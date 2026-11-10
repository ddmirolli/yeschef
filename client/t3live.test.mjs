// The live stream against a fake T3 Code: an HTTP server with the socket-ticket route and a small WebSocket server
// that speaks T3's Effect RPC frames. No T3 Code, no network beyond 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createLive, createKeys, retryDelay, TIMING } from './t3live.mjs';

// ----- A minimal WebSocket server (RFC 6455 text frames, enough for one test client) -----
function frame(text) {
  const p = Buffer.from(text), n = p.length;
  let head;
  if (n < 126) head = Buffer.from([0x81, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, p]);
}
function unframe(buf) {
  if (buf.length < 2) return null;
  const op = buf[0] & 0x0f, masked = buf[1] & 0x80;
  let n = buf[1] & 0x7f, off = 2;
  if (n === 126) { if (buf.length < 4) return null; n = buf.readUInt16BE(2); off = 4; }
  else if (n === 127) { if (buf.length < 10) return null; n = Number(buf.readBigUInt64BE(2)); off = 10; }
  const mask = masked ? buf.subarray(off, off + 4) : null;
  if (masked) off += 4;
  if (buf.length < off + n) return null;
  const data = Buffer.from(buf.subarray(off, off + n));
  if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  return { op, text: data.toString('utf8'), used: off + n };
}

const shell = (id, extra = {}) => ({ id, projectId: 'p1', title: id, status: 'idle', lineage: { parentThreadId: null }, settledOverride: null, settledAt: null, latestRunId: null, pendingRuntimeRequest: null, updatedAt: '2026-11-10T12:00:00.000Z', visibleItemCount: 1, ...extra });

/** A fake T3 Code. `reply(conn, msg)` answers each client message; the default serves a snapshot and pongs. */
async function fakeT3({ snapshot = [shell('a'), shell('b')], sequence = 10 } = {}) {
  const t3 = { tickets: [], conns: [], refuse: new Set(), pong: true, subscribe: 'serve', acks: 0, pings: 0, hold: null, held: [] };
  t3.reply = (conn, m) => {
    if (m._tag === 'Ping') { t3.pings++; if (t3.pong) conn.send({ _tag: 'Pong' }); return; }
    if (m._tag === 'Ack') { t3.acks++; return; }
    if (m._tag === 'Request' && m.tag === 'orchestration.subscribeShell') {
      conn.requests.push(m);
      if (t3.subscribe === 'fail') { t3.subscribe = 'serve'; conn.send({ _tag: 'Exit', requestId: m.id, exit: { _tag: 'Failure', cause: { _tag: 'Fail', error: 'boom' } } }); return; }
      if (t3.subscribe === 'silent') return;
      conn.send({ _tag: 'Chunk', requestId: m.id, values: [{ kind: 'snapshot', snapshot: { snapshotSequence: sequence, threads: snapshot, archivedThreads: [], projects: [{ id: 'p1', title: 'P' }] } }] });
      conn.send({ _tag: 'Chunk', requestId: m.id, values: [{ kind: 'synchronized' }] });
    }
  };
  const srv = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/auth/websocket-ticket/rpc') {
      const auth = req.headers.authorization;
      t3.tickets.push(auth);
      if (t3.refuse.has(auth)) return res.writeHead(401, { 'content-type': 'application/json' }).end('{"code":"auth_invalid"}');
      if (t3.hold === 'ticket') { t3.held.push(req.socket); return; }
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ticket: `ticket-${t3.tickets.length}` }));
    }
    res.writeHead(404).end();
  });
  srv.on('upgrade', (req, socket) => {
    if (t3.hold === 'open') { t3.held.push(socket); socket.on('error', () => {}); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = {
      url: new URL(req.url, 'http://x'), got: [], requests: [], open: true,
      send: (m) => { if (conn.open) socket.write(frame(JSON.stringify(m))); },
      kill: () => { conn.open = false; socket.destroy(); },
    };
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (let f; (f = unframe(buf)); ) {
        buf = buf.subarray(f.used);
        if (f.op === 8) { conn.open = false; socket.end(); return; }
        if (f.op === 1) { const m = JSON.parse(f.text); conn.got.push(m); t3.reply(conn, m); }
      }
    });
    socket.on('close', () => { conn.open = false; });
    socket.on('error', () => {});
    t3.conns.push(conn);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t3.origin = `http://127.0.0.1:${srv.address().port}`;
  t3.close = () => { for (const c of t3.conns) c.kill(); for (const s of t3.held) s.destroy(); srv.close(); };
  t3.last = () => t3.conns[t3.conns.length - 1];
  return t3;
}

const FAST = { base: 10, max: 40, stable: 60000, establish: 2000, sync: 2000, ping: 25, silent: 200, probe: 120, watch: 1e9 };
const until = async (fn, ms = 3000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 5)); }
};
function fakeKeys() {
  const k = { n: 0, drops: 0 };
  k.get = async () => `tok-${k.n}`;
  k.drop = () => { k.drops++; k.n++; };
  return k;
}

test('retry delay: jittered, doubling from 1 s, capped at 5 minutes', () => {
  assert.equal(retryDelay(0, 0), 1000);
  assert.equal(retryDelay(0, 1), 2000);
  assert.equal(retryDelay(3, 0.5), 12000);
  assert.equal(retryDelay(20, 0), 150000);
  assert.equal(retryDelay(20, 1), TIMING.max);
  assert.equal(TIMING.max, 300000);
});

test('the snapshot, then changes: live only once synchronized, every chunk acked, stale changes ignored', async (t) => {
  const t3 = await fakeT3();
  const live = createLive({ origin: t3.origin, keys: fakeKeys(), timing: FAST });
  t.after(async () => { await live.stop(); t3.close(); });
  assert.equal(live.live(), false);
  live.start();
  await until(() => live.live(), 3000, 'live');
  const conn = t3.last();
  assert.equal(conn.url.searchParams.get('wsTicket'), 'ticket-1');
  assert.equal(conn.url.searchParams.get('orchestrationProtocol'), '2');
  // Read only: the one request is the shell subscription, with every thread asked for.
  assert.deepEqual(conn.requests.map((r) => r.tag), ['orchestration.subscribeShell']);
  assert.deepEqual(conn.requests[0].payload, { requestCompletionMarker: true, omitIdleSubagents: false, omitOlderSettled: false });
  assert.deepEqual(live.threads().map((s) => s.id).sort(), ['a', 'b']);
  conn.send({ _tag: 'Chunk', requestId: '1', values: [{ kind: 'thread.updated', sequence: 12, location: 'active', thread: shell('c') }] });
  conn.send({ _tag: 'Chunk', requestId: '1', values: [{ kind: 'thread.updated', sequence: 11, location: 'active', thread: shell('stale') }] });
  conn.send({ _tag: 'Chunk', requestId: '1', values: [{ kind: 'thread.removed', sequence: 13, location: 'active', threadId: 'a' }] });
  conn.send({ _tag: 'Chunk', requestId: '1', values: [{ kind: 'thread.updated', sequence: 14, location: 'archive', thread: shell('b') }] });
  // A project-only refresh is not a list of threads: it must not empty the store.
  conn.send({ _tag: 'Chunk', requestId: '1', values: [{ kind: 'snapshot', snapshot: { snapshotSequence: 14, threads: [], archivedThreads: [], projects: [{ id: 'p1', title: 'P2' }] }, resolvedRepositoryIdentityRoots: ['/x'] }] });
  conn.send({ _tag: 'Ping' });
  await until(() => t3.acks >= 7 && conn.got.some((m) => m._tag === 'Pong'), 3000, 'acks and pong');
  assert.deepEqual(live.threads().map((s) => s.id), ['c']);
  assert.equal(live.live(), true);
});

test('a dropped socket: the cache stops being live at once, one retry reconnects, and the data comes back live', async (t) => {
  const t3 = await fakeT3();
  const live = createLive({ origin: t3.origin, keys: fakeKeys(), timing: FAST, random: () => 0 });
  t.after(async () => { await live.stop(); t3.close(); });
  live.start();
  await until(() => live.live(), 3000, 'live');
  t3.last().kill();
  await until(() => !live.live(), 1000, 'not live');
  assert.match(live.why() || '', /down|connecting|loading/);
  assert.equal(live.threads().length, 2, 'the cache is kept, but not called live');
  await until(() => live.live() && t3.conns.length === 2, 3000, 'live again');
  assert.equal(t3.tickets.length, 2);
});

test('T3 refuses the key: it is dropped and the next try mints a new one', async (t) => {
  const t3 = await fakeT3();
  const keys = fakeKeys();
  t3.refuse.add('Bearer tok-0');
  const live = createLive({ origin: t3.origin, keys, timing: FAST, random: () => 0 });
  t.after(async () => { await live.stop(); t3.close(); });
  live.start();
  await until(() => live.live(), 3000, 'live');
  assert.equal(keys.drops, 1);
  assert.deepEqual(t3.tickets, ['Bearer tok-0', 'Bearer tok-1']);
});

test('a silent socket is dropped after 15 s worth of nothing, then replaced', async (t) => {
  const t3 = await fakeT3();
  const live = createLive({ origin: t3.origin, keys: fakeKeys(), timing: FAST, random: () => 0 });
  t.after(async () => { await live.stop(); t3.close(); });
  live.start();
  await until(() => live.live(), 3000, 'live');
  t3.pong = false;
  await until(() => t3.conns.length === 2, 3000, 'a second socket');
  assert.equal(t3.conns[0].open, false);
  t3.pong = true;
  await until(() => live.live(), 3000, 'live again');
});

test('a probe on wake: an answered Ping keeps the socket; an unanswered one replaces it', async (t) => {
  const t3 = await fakeT3();
  const live = createLive({ origin: t3.origin, keys: fakeKeys(), timing: { ...FAST, ping: 1e6, silent: 1e6 }, random: () => 0 });
  t.after(async () => { await live.stop(); t3.close(); });
  live.start();
  await until(() => live.live(), 3000, 'live');
  live.probe('woke from sleep');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(t3.conns.length, 1, 'answered probe: same socket');
  t3.pong = false;
  live.probe('woke from sleep');
  await until(() => t3.conns.length === 2, 2000, 'a new socket');
  t3.pong = true;
  await until(() => live.live(), 3000, 'live again');
});

test('a failed subscription on a healthy socket resubscribes on that socket: no reconnect', async (t) => {
  const t3 = await fakeT3();
  t3.subscribe = 'fail';
  const live = createLive({ origin: t3.origin, keys: fakeKeys(), timing: { ...FAST, base: 200, max: 400 }, random: () => 0 });
  t.after(async () => { await live.stop(); t3.close(); });
  live.start();
  await until(() => live.health().data.state === 'failed', 3000, 'data failed');
  assert.equal(live.health().transport.state, 'open', 'transport health stays apart from data');
  assert.match(live.why(), /connected, but the shell subscription failed/);
  await until(() => live.live(), 3000, 'live after resubscribe');
  assert.equal(t3.conns.length, 1);
  assert.equal(t3.tickets.length, 1);
  assert.deepEqual(t3.last().requests.map((r) => r.id), ['1', '3']);
});

test('one retry owner: probes while waiting to retry start one attempt, never several', async (t) => {
  const t3 = await fakeT3();
  const live = createLive({ origin: t3.origin, keys: fakeKeys(), timing: { ...FAST, base: 5000, max: 5000 }, random: () => 1 });
  t.after(async () => { await live.stop(); t3.close(); });
  live.start();
  await until(() => live.live(), 3000, 'live');
  t3.last().kill();
  await until(() => live.health().transport.state === 'retrying', 1000, 'retrying');
  for (let i = 0; i < 5; i++) live.probe('network changed');
  await until(() => live.live(), 3000, 'live');
  assert.equal(t3.tickets.length, 2);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(t3.conns.length, 2);
});

test('a stop while the key, the ticket or the socket is on its way ends the attempt at once, with no retry', async (t) => {
  for (const hold of ['key', 'ticket', 'open']) {
    const t3 = await fakeT3();
    t3.hold = hold;
    const lines = [], keys = fakeKeys();
    if (hold === 'key') keys.get = () => { t3.held.push({ destroy() {} }); return new Promise(() => {}); };
    const live = createLive({ origin: t3.origin, keys, timing: { ...FAST, establish: 60000 }, log: (m) => lines.push(m) });
    t.after(() => t3.close());
    live.start();
    await until(() => t3.held.length === 1, 3000, `the ${hold} held`);
    const t0 = Date.now();
    await live.stop();
    assert.ok(Date.now() - t0 < 500, `stop() during the ${hold} took ${Date.now() - t0} ms`);
    assert.equal(live.health().transport.state, 'stopped');
    assert.deepEqual(lines.filter((l) => /next try/.test(l)), [], 'a stop is not a failure');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(t3.tickets.length, hold === 'key' ? 0 : 1, 'and nothing tries again');
  }
});

test('stop: interrupts the subscription, closes the socket, and the data is no longer live', async (t) => {
  const t3 = await fakeT3();
  const live = createLive({ origin: t3.origin, keys: fakeKeys(), timing: FAST });
  t.after(() => t3.close());
  live.start();
  await until(() => live.live(), 3000, 'live');
  const conn = t3.last();
  await live.stop();
  await until(() => !conn.open, 1000, 'socket closed');
  assert.ok(conn.got.some((m) => m._tag === 'Interrupt' && m.requestId === '1'));
  assert.equal(live.live(), false);
  assert.equal(live.why(), 'the live stream is stopped');
});

// ----- The key: read only, revoked, swept -----
function fakeCli({ scope = 'orchestration:read', sessions = [] } = {}) {
  const cli = { calls: [], revoked: [], sessions };
  cli.run = async (bin, args) => {
    cli.calls.push(args);
    if (args[1] === 'pairing') return JSON.stringify({ id: 'x', credential: 'code' });
    if (args[1] === 'session' && args[2] === 'list') return JSON.stringify(cli.sessions);
    if (args[1] === 'session' && args[2] === 'revoke') { cli.revoked.push(args[3]); return 'Revoked'; }
    throw new Error('unexpected ' + args.join(' '));
  };
  cli.fetch = async (url, init) => {
    cli.exchange = Object.fromEntries(new URLSearchParams(init.body));
    return { ok: true, status: 200, json: async () => ({ access_token: 'secret', token_type: 'Bearer', scope }) };
  };
  return cli;
}

test('the key: a pairing code for orchestration:read only, swapped once, and reused', async () => {
  const cli = fakeCli();
  const keys = createKeys({ origin: 'http://127.0.0.1:3773', run: cli.run, fetchImpl: cli.fetch, pid: 4242 });
  assert.equal(await keys.get(), 'secret');
  assert.equal(await keys.get(), 'secret');
  const pairing = cli.calls.filter((a) => a[1] === 'pairing');
  assert.equal(pairing.length, 1);
  assert.deepEqual(pairing[0].filter((_, i, a) => a[i - 1] === '--scope'), ['orchestration:read']);
  assert.ok(!JSON.stringify(cli.calls).includes('operate'));
  assert.equal(cli.exchange.scope, 'orchestration:read');
  assert.equal(cli.exchange.client_label, 'Yes Chef live, read only (pid 4242)');
});

test('the key: a wider scope is revoked at once and never used', async () => {
  const cli = fakeCli({ scope: 'orchestration:read orchestration:operate', sessions: [{ sessionId: 's1', client: { label: 'Yes Chef live, read only (pid 4242)' } }] });
  const keys = createKeys({ origin: 'http://127.0.0.1:3773', run: cli.run, fetchImpl: cli.fetch, pid: 4242 });
  await assert.rejects(keys.get(), /not read only/);
  assert.deepEqual(cli.revoked, ['s1']);
});

test('the key: only T3 Code on this Mac', async () => {
  const cli = fakeCli();
  const keys = createKeys({ origin: 'https://t3.example.com', run: cli.run, fetchImpl: cli.fetch });
  await assert.rejects(keys.get(), /on this Mac/);
  assert.equal(cli.calls.length, 0);
});

test('revoke at stop cuts a key still being minted short, then revokes what T3 made of it', async () => {
  const cli = fakeCli({ sessions: [{ sessionId: 'half', client: { label: 'Yes Chef live, read only (pid 4242)' } }] });
  let signal = null;
  // T3 has made the session, but its answer never comes back.
  cli.fetch = (url, init) => { signal = init.signal; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))); };
  const keys = createKeys({ origin: 'http://127.0.0.1:3773', run: cli.run, fetchImpl: cli.fetch, pid: 4242 });
  const got = keys.get();
  await until(() => signal, 1000, 'the exchange');
  const t0 = Date.now();
  assert.equal(await keys.revokeMine(), 1);
  assert.ok(Date.now() - t0 < 500, 'no wait for the exchange');
  assert.deepEqual(cli.revoked, ['half']);
  await assert.rejects(got, /stopping/);
});

test('revoke: our own keys at stop; at start, only keys of runs that are gone', async () => {
  const sessions = [
    { sessionId: 'mine', client: { label: 'Yes Chef live, read only (pid 4242)' } },
    { sessionId: 'dead', client: { label: 'Yes Chef live, read only (pid 1111)' } },
    { sessionId: 'running', client: { label: 'Yes Chef live, read only (pid 2222)' } },
    { sessionId: 'app', client: { label: 'Yes Chef (desktop)' } },
    { sessionId: 'other', client: { label: 'T3 Code Desktop' } },
  ];
  const cli = fakeCli({ sessions });
  const keys = createKeys({ origin: 'http://127.0.0.1:3773', run: cli.run, fetchImpl: cli.fetch, pid: 4242, isAlive: (p) => p === 2222 });
  assert.equal(await keys.sweep(), 1);
  assert.deepEqual(cli.revoked, ['dead']);
  assert.equal(await keys.revokeMine(), 1);
  assert.deepEqual(cli.revoked, ['dead', 'mine']);
});

test('a second consumer: subscribe hears the same changes, with the threads they touched', async (t) => {
  const t3 = await fakeT3();
  const board = [], sealer = [];
  const live = createLive({ origin: t3.origin, keys: fakeKeys(), timing: FAST, onChange: (c) => board.push(c) });
  const off = live.subscribe((c) => sealer.push(c));
  live.subscribe(() => { throw new Error('a bad listener'); });
  t.after(async () => { await live.stop(); t3.close(); });
  live.start();
  await until(() => live.live(), 3000, 'live');
  assert.ok(sealer.some((c) => c.all), 'the snapshot reaches the second consumer');
  t3.last().send({ _tag: 'Chunk', requestId: '1', values: [{ kind: 'thread.updated', sequence: 20, location: 'active', thread: shell('z') }] });
  await until(() => sealer.some((c) => c.ids.includes('z')), 2000, 'the change');
  assert.deepEqual(sealer.at(-1), { ids: ['z'], all: false, live: true });
  assert.deepEqual(board.at(-1), sealer.at(-1), 'both hear the same change, despite a listener that throws');
  assert.equal(live.thread('z').title, 'z');
  off();
  const n = sealer.length;
  t3.last().send({ _tag: 'Chunk', requestId: '1', values: [{ kind: 'thread.updated', sequence: 21, location: 'active', thread: shell('y') }] });
  await until(() => board.some((c) => c.ids.includes('y')), 2000, 'the board hears it');
  assert.equal(sealer.length, n, 'unsubscribed');
});

test('an archived thread removed is named in the change, so a reader that cached it drops it', async (t) => {
  const t3 = await fakeT3();
  const heard = [];
  const live = createLive({ origin: t3.origin, keys: fakeKeys(), timing: FAST, onChange: (c) => heard.push(c) });
  t.after(async () => { await live.stop(); t3.close(); });
  live.start();
  await until(() => live.live(), 3000, 'live');
  t3.last().send({ _tag: 'Chunk', requestId: '1', values: [{ kind: 'thread.removed', sequence: 30, location: 'archive', threadId: 'old-parent' }] });
  await until(() => heard.some((c) => c.ids.includes('old-parent')), 2000, 'the removal');
  assert.deepEqual(live.threads().map((s) => s.id).sort(), ['a', 'b'], 'the active store is untouched');
});

test('the clocks: a Mac clock that runs back, or one that stands still, never keeps a silent socket live', async (t) => {
  // The Mac's clock runs back a minute: the cache is not live at that moment, and the socket is replaced.
  const t3 = await fakeT3();
  let shift = 0;
  const live = createLive({ origin: t3.origin, keys: fakeKeys(), timing: FAST, random: () => 0, now: () => Date.now() + shift });
  t.after(async () => { await live.stop(); t3.close(); });
  live.start();
  await until(() => live.live(), 3000, 'live');
  shift = -60000;
  assert.equal(live.live(), false, 'a clock that ran back is silence');
  await until(() => t3.conns.length === 2, 3000, 'a second socket');
  await until(() => live.live(), 3000, 'live again on the new clock');
  // The Mac's clock stands still while T3 Code goes quiet: the monotonic clock still sees the silence.
  const t3b = await fakeT3();
  const frozen = Date.now();
  const still = createLive({ origin: t3b.origin, keys: fakeKeys(), timing: FAST, random: () => 0, now: () => frozen });
  t.after(async () => { await still.stop(); t3b.close(); });
  still.start();
  await until(() => still.live(), 3000, 'live');
  t3b.pong = false;
  await until(() => !still.live(), 3000, 'not live on the monotonic clock');
  await until(() => t3b.conns.length === 2, 3000, 'a second socket');
});
