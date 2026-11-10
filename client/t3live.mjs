// The live stream from T3 Code (the team build, step 3: Spike 1A made real). Read only.
//
// The app's MCP sign-in cannot open T3 Code's socket: T3 Code turns MCP client sessions away from every route but
// /mcp (apps/server/src/auth/EnvironmentAuth.ts, rejectMcpClientAudience; checked live on 2026-11-10, a read-only
// MCP token got 401 from /api/auth/websocket-ticket/rpc). So the stream uses its own key, minted as Spike 1A did:
// a five-minute pairing code limited to `orchestration:read` from T3 Code's CLI, swapped for a session token.
// The key lives in this process only. It is revoked when Yes Chef stops, and a key left by a run that died is
// revoked at the next start.
//
// Protocol and reconnect rules from T3 Code v0.1.7 (MIT, T3 Tools Inc.): packages/contracts/src/{orchestrationV2,
// rpc}.ts, packages/client-runtime/src/connection/supervisor.ts and rpc/protocol.ts, docs/internals/connection-runtime.md.
//   - One retry owner: only the supervisor below schedules an attempt; an attempt is one try.
//   - Jittered exponential backoff from 1 s, capped at 5 minutes, reset only after a connection stays up 30 s.
//   - A probe on wake or network change: a Ping that gets no frame back in 3 s (loopback) replaces the socket.
//   - Transport health is kept apart from data freshness: a failed subscription on a healthy socket resubscribes on
//     that socket and is never called a reconnect.
//   - A cache is never shown as live: live() is true only while the socket is healthy and the shell is synchronized.
// Socket messages are Effect RPC JSON: Request, Chunk (each needs an Ack), Exit, Ping, Pong, Interrupt.
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';

export const TIMING = {
  base: 1000,          // first retry ceiling is 2 s (T3: RETRY_BASE_DELAY_MS)
  max: 300000,         // 5 minutes (RETRY_MAX_DELAY_MS)
  stable: 30000,       // up this long resets the backoff (BACKOFF_RESET_AFTER_MS)
  establish: 15000,    // socket open and first snapshot (CONNECTION_ESTABLISHMENT_TIMEOUT)
  sync: 75000,         // snapshot to synchronized (synchronizationTimeout)
  ping: 5000,          // a Ping every 5 s (rpc/protocol.ts)
  silent: 15000,       // no frame for 15 s drops the socket (PING_TIMEOUT)
  probe: 3000,         // loopback probe deadline (QUICK_CONNECTION_PROBE_TIMEOUT); 15 s elsewhere
  watch: 5000,         // how often the wake and network watch looks
};

/** T3 Code's retry delay: half the ceiling plus a random share of the other half. */
export function retryDelay(failures, random, { base = TIMING.base, max = TIMING.max } = {}) {
  const ceiling = Math.min(max, base * 2 ** (failures + 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

export const LABEL = 'Yes Chef live, read only';
const labelFor = (pid) => `${LABEL} (pid ${pid})`;
const pidOf = (label) => { const m = /^Yes Chef live, read only \(pid (\d+)\)$/.exec(String(label || '')); return m ? Number(m[1]) : null; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (ex) { return ex.code === 'EPERM'; } };
export const isLoopback = (origin) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname); } catch { return false; } };

// T3 Code's CLI, with errors in words: which command, and its first line of complaint. Never the output itself.
const runCli = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => {
    if (!err) return resolve(out);
    const what = `t3 ${args.slice(0, 3).join(' ')}`;
    reject(new Error(err.code === 'ENOENT' ? `T3 Code's command line tool is not at ${bin}` : `${what} failed: ${String(errOut || err.code || err.message).split('\n')[0].slice(0, 120)}`));
  });
});

/** The stream's key: minted on first use, dropped when T3 refuses it, revoked at stop. Never printed or saved. */
export function createKeys({ origin, bin = `${process.env.HOME}/.t3/bin/t3`, run = runCli, fetchImpl = fetch, pid = process.pid, isAlive = alive } = {}) {
  const label = labelFor(pid);
  let token = null, minting = null, mintCtl = null;
  const sessions = async () => { const rows = JSON.parse(await run(bin, ['auth', 'session', 'list', '--json'])); return Array.isArray(rows) ? rows : []; };
  const revoke = async (keep) => {
    let n = 0;
    for (const s of await sessions()) {
      if (s?.sessionId && keep(s.client?.label)) { await run(bin, ['auth', 'session', 'revoke', String(s.sessionId)]); n++; }
    }
    return n;
  };
  async function mint(signal) {
    if (!isLoopback(origin)) throw new Error('the live stream needs T3 Code on this Mac');
    const issued = JSON.parse(await run(bin, ['auth', 'pairing', 'create', '--json', '--ttl', '5m', '--label', label, '--scope', 'orchestration:read']));
    if (typeof issued?.credential !== 'string') throw new Error('T3 Code gave no pairing code');
    const r = await fetchImpl(`${origin}/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: issued.credential,
        subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        scope: 'orchestration:read',
        client_label: label,
      }),
      signal,
    });
    const tok = await r.json().catch(() => ({}));
    if (!r.ok || typeof tok.access_token !== 'string') throw new Error(`T3 Code did not give a read-only key (${r.status})`);
    // Read only, or nothing: a key with any other scope is revoked at once and never used.
    if (String(tok.scope || '').split(' ').filter(Boolean).join(' ') !== 'orchestration:read') {
      await revoke((l) => l === label).catch(() => {});
      throw new Error('T3 Code offered a key that is not read only, so Yes Chef revoked it');
    }
    return tok.access_token;
  }
  return {
    label,
    async get() {
      if (token) return token;
      if (!minting) {
        // The exchange has T3's deadline, and revokeMine() can cut it short, so a quit never waits on it.
        const ctl = mintCtl = new AbortController();
        const late = setTimeout(() => ctl.abort(new Error('T3 Code gave no read-only key in time')), TIMING.establish);
        minting = mint(ctl.signal)
          .then((t) => { if (ctl.signal.aborted) throw ctl.signal.reason; token = t; return t; },
            (ex) => { throw ctl.signal.aborted ? ctl.signal.reason : ex; })
          .finally(() => { clearTimeout(late); minting = null; if (mintCtl === ctl) mintCtl = null; });
      }
      return minting;
    },
    /** T3 refused the key: forget it, so the next attempt mints a new one. */
    drop() { token = null; },
    /** Revoke every key this process made. */
    async revokeMine() {
      // A key still being minted is cut off first, so the list below sees every key this process got (PR-Agent r1 on #76).
      mintCtl?.abort(new Error('Yes Chef is stopping'));
      await minting?.catch(() => {});
      token = null;
      return revoke((l) => l === label);
    },
    /** Revoke keys left by Yes Chef runs that are no longer running. */
    sweep() { return revoke((l) => { const p = pidOf(l); return p !== null && p !== pid && !isAlive(p); }); },
  };
}

const netPrint = () => { try { return JSON.stringify(Object.entries(networkInterfaces()).map(([n, a]) => [n, (a || []).map((x) => x.address).sort()]).sort()); } catch { return ''; } };
const words = (ex) => String(ex?.message || ex || 'failed').slice(0, 160);

/** Follow T3 Code's shell. onChange({ ids, all, live }) runs after every change to the store or to health. */
export function createLive({
  origin, keys, onChange = () => {}, WebSocketImpl = globalThis.WebSocket, fetchImpl = fetch,
  now = Date.now, mono = () => performance.now(), random = Math.random, timing = {}, subscribe = {}, log = () => {}, network = netPrint,
} = {}) {
  const T = { ...TIMING, ...timing };
  const probeMs = isLoopback(origin) ? T.probe : 15000;
  const threads = new Map(), projects = new Map();
  const transport = { state: 'idle', since: now(), failures: 0, retryAt: null, error: null, upAt: null, lastFrameAt: 0, lastFrameMono: 0 };
  const data = { state: 'none', since: now(), generation: 0, sequence: -1, syncedAt: 0, error: null, projectsRev: 0 };
  let ws = null, attempt = null, retryTimer = null, pingTimer = null, watchTimer = null, probeTimer = null, stopped = false;
  let subId = 0, resubTimer = null, resubFailures = 0, establishTimer = null, cancelOpen = null;
  let lastWatch = now(), lastNet = network();
  const set = (o, patch) => { if (patch.state && patch.state !== o.state) o.since = now(); Object.assign(o, patch); };
  // How long since T3 Code's last frame. The Mac's clock counts a sleep, which the monotonic clock does not; the
  // monotonic clock never runs back, which the Mac's clock can (PR-Agent r3 on #76). The larger counts, and a
  // clock that ran back counts as silence, so a cache is never shown as live on either clock's word alone.
  const heardFrame = () => { transport.lastFrameAt = now(); transport.lastFrameMono = mono(); };
  const silentFor = () => {
    const wall = now() - transport.lastFrameAt;
    return wall < 0 ? Infinity : Math.max(wall, mono() - transport.lastFrameMono);
  };
  // Every consumer hears every change: the board (onChange) and any other (subscribe), such as the team summary.
  // A change names the threads it touched; `all` means a new snapshot replaced the store.
  const listeners = new Set([onChange]);
  let dirty = new Set(), dirtyAll = false;
  const changed = () => {
    const change = { ids: [...dirty], all: dirtyAll, live: api.live() };
    dirty = new Set(); dirtyAll = false;
    for (const fn of [...listeners]) { try { fn(change); } catch (ex) { log(`a stream listener failed: ${words(ex)}`); } }
  };
  const send = (m) => { try { ws?.send(JSON.stringify(m)); } catch { /* the socket's close handler takes it from here */ } };

  function closeSocket() {
    const old = ws; ws = null;
    clearInterval(pingTimer); pingTimer = null; clearTimeout(probeTimer); probeTimer = null; clearTimeout(resubTimer); resubTimer = null; clearTimeout(establishTimer); establishTimer = null;
    if (old) { old.onopen = old.onmessage = old.onerror = old.onclose = null; try { old.close(); } catch { /* already closed */ } }
    // An attempt still fetching its ticket or opening this socket gives up now. Its wait would otherwise never
    // settle, and stop() would hang before the key is revoked (PR-Agent r1 on #76).
    const cancel = cancelOpen; cancelOpen = null; cancel?.();
  }

  // The one retry owner. Every failure comes here; nothing else starts an attempt except wake() and probe().
  function fail(reason, { auth = false } = {}) {
    if (stopped) return;
    closeSocket();
    if (auth) keys.drop();
    const upFor = transport.upAt ? now() - transport.upAt : 0;
    const failures = upFor >= T.stable ? 0 : transport.failures;
    const delay = retryDelay(failures, random(), T);
    set(transport, { state: 'retrying', failures: failures + 1, retryAt: now() + delay, error: reason, upAt: null });
    if (data.state === 'live' || data.state === 'loading') set(data, { state: 'stale', error: reason });
    log(`live stream down: ${reason}; next try in ${Math.round(delay / 1000)} s`);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; start(); }, delay);
    changed();
  }

  function start() {
    if (stopped || attempt) return;
    clearTimeout(retryTimer); retryTimer = null;
    set(transport, { state: 'connecting', retryAt: null });
    changed();
    attempt = connectOnce().catch((ex) => { if (!ex?.cancelled) fail(words(ex), { auth: !!ex?.auth }); }).finally(() => { attempt = null; cancelOpen = null; });
  }

  async function connectOnce() {
    const cancelled = Object.assign(new Error('the attempt was cancelled'), { cancelled: true });
    // A stop does not wait for the key: revokeMine() cuts a mint short and revokes what it made.
    const token = await new Promise((resolve, reject) => { cancelOpen = () => reject(cancelled); keys.get().then(resolve, reject); });
    cancelOpen = null;
    if (stopped) return;
    // One abort for the ticket's deadline and for a stop or close while it is on its way.
    const ctl = new AbortController();
    const late = setTimeout(() => ctl.abort(new Error('T3 Code gave no socket ticket in time')), T.establish);
    cancelOpen = () => ctl.abort(cancelled);
    let kr, kt;
    try {
      kr = await fetchImpl(`${origin}/api/auth/websocket-ticket/rpc`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: ctl.signal });
      kt = await kr.json().catch(() => ({}));
    } catch (ex) { throw ctl.signal.aborted ? ctl.signal.reason : ex; }
    finally { clearTimeout(late); cancelOpen = null; }
    if (kr.status === 401 || kr.status === 403) throw Object.assign(new Error(`T3 Code refused the read-only key (${kr.status})`), { auth: true });
    if (!kr.ok || typeof kt.ticket !== 'string') throw new Error(`no socket ticket (${kr.status})`);
    if (stopped) return;
    const url = new URL('/ws', origin.replace(/^http/, 'ws'));
    url.searchParams.set('wsTicket', kt.ticket);
    url.searchParams.set('orchestrationProtocol', '2');
    const sock = new WebSocketImpl(url);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    await new Promise((resolve, reject) => {
      cancelOpen = () => reject(cancelled);
      establishTimer = setTimeout(() => reject(new Error('the socket did not open in time')), T.establish);
      sock.onopen = () => { clearTimeout(establishTimer); resolve(); };
      sock.onerror = () => { clearTimeout(establishTimer); reject(new Error('the socket failed to open')); };
      sock.onclose = (ev) => { clearTimeout(establishTimer); reject(new Error(`the socket closed (${ev?.code ?? '?'})`)); };
    });
    cancelOpen = null;
    if (ws !== sock) return;
    sock.onerror = () => {};
    sock.onclose = (ev) => { if (ws === sock) fail(`the socket closed (${ev?.code ?? '?'}${ev?.reason ? `, ${ev.reason}` : ''})`); };
    sock.onmessage = (ev) => { if (ws === sock) hear(ev.data); };
    set(transport, { state: 'open', upAt: now(), error: null });
    heardFrame();
    pingTimer = setInterval(() => {
      if (ws !== sock) return;
      if (silentFor() > T.silent) { fail(`no frame from T3 Code for ${Math.round(T.silent / 1000)} s`); return; }
      send({ _tag: 'Ping' });
    }, T.ping);
    subscribeShell();
  }

  function subscribeShell() {
    const id = String(++subId);
    set(data, { state: 'loading', error: null });
    changed();
    send({ _tag: 'Request', id, tag: 'orchestration.subscribeShell', headers: [],
      payload: { requestCompletionMarker: true, omitIdleSubagents: false, omitOlderSettled: false, ...subscribe } });
    // No snapshot and synchronized marker in time: a stuck subscription is a data failure on this socket.
    clearTimeout(resubTimer);
    resubTimer = setTimeout(() => { if (data.state === 'loading' && String(subId) === id) dataFailed('T3 Code sent no synchronized shell in time'); }, T.establish + T.sync);
  }

  // A failed subscription on a healthy socket: resubscribe on the same socket, with its own backoff.
  function dataFailed(reason) {
    if (!ws) return;
    send({ _tag: 'Interrupt', requestId: String(subId) });
    subId++; // frames for the old request are ignored from here on
    const delay = retryDelay(resubFailures++, random(), T);
    set(data, { state: 'failed', error: reason });
    log(`shell subscription failed: ${reason}; again in ${Math.round(delay / 1000)} s`);
    clearTimeout(resubTimer);
    resubTimer = setTimeout(() => { if (ws) subscribeShell(); }, delay);
    changed();
  }

  function hear(raw) {
    heardFrame();
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    let parsed;
    try { parsed = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); } catch { return; }
    let touched = false;
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!m || typeof m !== 'object') continue;
      if (m._tag === 'Ping') { send({ _tag: 'Pong' }); continue; }
      if (m._tag === 'Chunk') {
        send({ _tag: 'Ack', requestId: m.requestId });
        if (String(m.requestId) !== String(subId)) continue;
        for (const v of m.values || []) touched = apply(v) || touched;
        continue;
      }
      if (m._tag === 'Exit' && String(m.requestId) === String(subId)) {
        const why = m.exit?._tag === 'Failure' ? JSON.stringify(m.exit.cause ?? '').slice(0, 160) : 'the server ended it';
        dataFailed(`the shell subscription ended: ${why}`);
        continue;
      }
      if (m._tag === 'Defect') { dataFailed(`T3 Code reported a defect: ${String(m.defect ?? '').slice(0, 120)}`); continue; }
    }
    if (touched) changed();
  }

  function apply(v) {
    if (!v || typeof v.kind !== 'string') return false;
    if (v.kind === 'snapshot') {
      const s = v.snapshot || {};
      // A snapshot that names resolvedRepositoryIdentityRoots refreshes those projects only; its empty thread list
      // is not a list of threads (ShellStream.ts, shellStreamItemFromEnrichmentRefresh).
      if (v.resolvedRepositoryIdentityRoots !== undefined) {
        for (const p of s.projects || []) projects.set(p.id, p);
        data.projectsRev++;
        return true;
      }
      threads.clear(); projects.clear(); dirtyAll = true;
      for (const t of s.threads || []) threads.set(t.id, t);
      for (const p of s.projects || []) projects.set(p.id, p);
      data.sequence = Number(s.snapshotSequence ?? -1);
      data.generation++; data.projectsRev++;
      return true;
    }
    if (v.kind === 'synchronized') {
      resubFailures = 0;
      clearTimeout(resubTimer); resubTimer = null;
      set(data, { state: 'live', syncedAt: now(), error: null });
      return true;
    }
    const seq = Number(v.sequence);
    if (Number.isFinite(seq)) { if (seq < data.sequence) return false; data.sequence = seq; }
    if (v.kind === 'thread.updated') { dirty.add(v.thread.id); if (v.location === 'active') threads.set(v.thread.id, v.thread); else threads.delete(v.thread.id); return true; }
    // An archived thread is not in this store, but a reader may hold it (the server's parent cache): name it either way
    // (PR-Agent r3 on #76).
    if (v.kind === 'thread.removed') { dirty.add(v.threadId); if (v.location !== 'archive') threads.delete(v.threadId); return true; }
    if (v.kind === 'project.updated') { projects.set(v.project.id, v.project); data.projectsRev++; return true; }
    if (v.kind === 'project.removed') { projects.delete(v.projectId); data.projectsRev++; return true; }
    return false;
  }

  /** Wake, network change or an explicit retry: probe a live socket, or try at once when waiting to retry. */
  function probe(why = 'probe') {
    if (stopped) return;
    if (transport.state === 'retrying') { log(`${why}: retrying now`); start(); return; }
    if (transport.state !== 'open' || probeTimer) return;
    const sock = ws;
    send({ _tag: 'Ping' });
    probeTimer = setTimeout(() => { probeTimer = null; if (ws === sock) fail(`${why}: T3 Code did not answer in ${probeMs / 1000} s`); }, probeMs);
  }

  // Wake and network watch: a timer that slept far past its period means the Mac slept; a new set of
  // addresses means the network changed. Either one probes. It reads only this Mac's clock and interfaces.
  function watch() {
    const t = now(), slept = t - lastWatch > T.watch * 3;
    lastWatch = t;
    const net = network();
    if (slept) probe('woke from sleep');
    else if (net !== lastNet) probe('network changed');
    lastNet = net;
  }

  const api = {
    start() { stopped = false; watchTimer ??= setInterval(watch, T.watch); watchTimer.unref?.(); start(); },
    probe,
    async stop() {
      stopped = true;
      clearTimeout(retryTimer); clearInterval(watchTimer); watchTimer = null;
      if (ws) send({ _tag: 'Interrupt', requestId: String(subId) });
      closeSocket();
      await attempt?.catch(() => {});
      set(transport, { state: 'stopped', retryAt: null });
      if (data.state === 'live' || data.state === 'loading') set(data, { state: 'stale' });
    },
    /** True only while the socket is healthy and the shell is synchronized. Anything else is a cache. */
    live() { return transport.state === 'open' && data.state === 'live' && silentFor() <= T.silent; },
    health() {
      return { live: api.live(), transport: { ...transport }, data: { ...data }, threads: threads.size, projects: projects.size };
    },
    /** Why the data is not live, in words, or null when it is. */
    why() {
      if (api.live()) return null;
      const next = transport.retryAt ? `, next try in ${Math.max(1, Math.round((transport.retryAt - now()) / 1000))} s` : '';
      if (transport.state === 'retrying') return `the live stream from T3 Code is down (${transport.error})${next}`;
      if (transport.state === 'connecting' || transport.state === 'idle') return 'connecting to T3 Code\'s live stream';
      if (transport.state === 'stopped') return 'the live stream is stopped';
      if (data.state === 'failed') return `connected, but the shell subscription failed (${data.error})`;
      if (data.state === 'loading' || data.state === 'none') return 'loading the shell from T3 Code';
      return 'no frame from T3 Code lately';
    },
    threads: () => [...threads.values()],
    thread: (id) => threads.get(id) ?? null,
    projectsRev: () => data.projectsRev,
    generation: () => data.generation,
    /** A second consumer: fn({ ids, all, live }) after every change to the store or to health. Returns unsubscribe.
     *  Read the shells with threads() or thread(id), and treat them as current only while live() is true. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return api;
}
