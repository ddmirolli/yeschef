// A relay room in Node, for tests: Cloudflare's SQL API over node:sqlite, and sockets that keep what they hear.
// The real thing runs under `wrangler dev` (relay/README.md); this lets the tests run with plain `node --test`.
import { DatabaseSync } from 'node:sqlite';
import { Room } from './room.mjs';

const WRITES = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
/** Cloudflare's ctx.storage.sql: exec(query, ...bindings) -> { toArray(), one(), rowsWritten }. */
export function fakeSql() {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings).map((r) => ({ ...r }));
      const rowsWritten = WRITES.test(query) ? Number(db.prepare('SELECT changes() AS n').get().n) : 0;
      return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('expected one row'); return rows[0]; }, rowsWritten };
    },
  };
}

/** A room with a clock you move by hand, and a connect() that opens a socket the way the Worker does. */
export function fakeRelay({ env = {}, start = Date.UTC(2026, 10, 10, 12), register = null } = {}) {
  let clock = start;
  const open = new Set();
  const sql = fakeSql();
  const created = [], deleted = [], alarms = [];
  const room = new Room({
    sql, env, now: () => clock, wakeAt: (at) => { alarms.push(at); },
    sockets: {
      list: (m) => [...open].filter((ws) => !m || ws.info.m === m),
      info: (ws) => ws.info,
      send: (ws, value) => { if (ws.closed) throw new Error('closed'); const v = JSON.parse(JSON.stringify(value)); ws.heard.push(v); ws.onheard?.(v); },
      close: (ws, code, reason) => { if (!ws.closed) { ws.closed = { code, reason }; open.delete(ws); room.closed(ws); ws.onclosed?.(code, reason); } },
    },
    // register(team, at): the Worker's registry call, so a test can make it fail.
    onCreate: async (team, at) => { if (register) await register(team, at); created.push([team, at]); },
    onDelete: (team) => { deleted.push(team); for (const t of ['team', 'summary', 'invite', 'pending', 'inbox', 'usage']) sql.exec(`DROP TABLE IF EXISTS ${t}`); },
  });
  const base = 'https://relay.test';
  const relay = {
    room, sql, created, deleted, alarms, base,
    now: () => clock,
    tick(ms) { clock += ms; },
    /** HTTP to the room, as the Worker would pass it. */
    async http(method, path, body, headers = {}) {
      const res = await room.fetch(new Request(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }));
      return { status: res.status, body: await res.json() };
    },
    /** Open a socket. Returns { status, body } on a refusal, else the socket. hooks: { heard(value), closed(code, reason) }
     *  hear what the relay sends as it sends it, for a client that runs on its own (the app's team client). */
    async connect(path, hooks = {}) {
      const out = await room.fetch(new Request(base + path, { headers: { upgrade: 'websocket' } }));
      if (out instanceof Response) return { status: out.status, body: await out.json() };
      const ws = { info: out.upgrade, heard: [], closed: null, onheard: hooks.heard, onclosed: hooks.closed,
        say: async (value) => { await room.message(ws, JSON.stringify(value)); return ws.heard[ws.heard.length - 1]; },
        last: (t) => [...ws.heard].reverse().find((x) => x.t === t) || null,
        drain: () => ws.heard.splice(0) };
      open.add(ws);
      room.opened(ws);
      return ws;
    },
    close(ws, code = 1000, reason = '') { if (!ws.closed) { ws.closed = { code, reason }; open.delete(ws); room.closed(ws); ws.onclosed?.(code, reason); } },
    sockets: () => [...open],
  };
  return relay;
}

/** The relay as a team client sees it over the network: fetch and a WebSocket, both async, as in the app.
 *  drop() cuts every socket the way a lost network does (close 1006). down = true refuses new ones. */
export function fakeNet(relay) {
  const net = {
    down: false,
    async http(method, url, body, headers = {}) {
      if (net.down) throw new Error('network down');
      const u = new URL(url);
      return relay.http(method, u.pathname + u.search, body, headers);
    },
    socket(url) {
      const u = new URL(url);
      const listeners = { open: [], message: [], close: [] };
      const fire = (type, ev) => { for (const fn of listeners[type]) fn(ev); };
      let ws = null, state = 0;
      const sock = {
        get readyState() { return state; },
        addEventListener: (type, fn) => listeners[type]?.push(fn),
        send(text) {
          if (state !== 1) throw new Error('not open');
          // Cloudflare answers a ping itself, without the room (setWebSocketAutoResponse).
          if (text === 'ping') { setImmediate(() => state === 1 && fire('message', { data: 'pong' })); return; }
          setImmediate(() => { if (state === 1 && ws && !ws.closed) relay.room.message(ws, text); });
        },
        close(code = 1000, reason = '') { if (state < 2) { state = 2; setImmediate(() => { if (ws) relay.close(ws, code, reason); else end(code, reason); }); } },
      };
      const end = (code, reason) => { if (state === 3) return; state = 3; setImmediate(() => fire('close', { code, reason })); };
      net.open.add(sock);
      sock.cut = () => { if (ws) { const w = ws; ws = null; relay.close(w, 1006, ''); } end(1006, ''); };
      setImmediate(async () => {
        if (net.down || state !== 0) { end(1006, ''); return; }
        const out = await relay.connect(u.pathname + u.search, {
          heard: (v) => { const text = JSON.stringify(v); setImmediate(() => state === 1 && fire('message', { data: text })); },
          closed: (code, reason) => { net.open.delete(sock); end(code, reason); },
        });
        // A refused upgrade shows the client no status, as in a browser: an abnormal close.
        if (!out.info) { end(1006, ''); return; }
        ws = out;
        if (state !== 0) { relay.close(ws, 1000, ''); return; }
        state = 1;
        fire('open', {});
        // The relay may have spoken already (the hello): the hooks queued it behind this open.
      });
      return sock;
    },
    open: new Set(),
    drop() { for (const s of [...net.open]) s.cut(); net.open.clear(); },
  };
  return net;
}
