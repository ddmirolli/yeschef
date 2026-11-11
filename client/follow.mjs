// Keeps one read per source current for the threads that want it. A source is whatever a read looks at: a folder
// for changed files (client/changes.mjs), a branch or a pull request on GitHub (client/github.mjs).
// One read per source, a few at a time; again when a thread on it moves (its stamp, at most once per `gap`), and
// every `every` otherwise. A read older than `maxAge` is never shown as current: get() says "not checked" and why.

/** want(targets) names who to follow, each time the board refreshes: [{ id, key, args, stamp }], or [{ id, why }]
 *  for one that cannot be followed. read(args) gives { state: 'checked' | 'not-checked', at, … }.
 *  get(id) gives that id's last read, or { state: 'not-checked', why }. subscribe(fn) calls fn({ ids }) when a read
 *  changes what those ids show. */
export function createFollower({ read, now = Date.now, concurrency = 2, every = 60000, gap = 10000, maxAge = 3 * every, log = () => {}, name = 'read' } = {}) {
  // readAt is when this follower last started a read of the source. Turns are counted from it, not from the result's
  // `at`: a reused GitHub read keeps the older time its checks were read (client/github.mjs), and counting from that
  // would read again at every refresh until the reuse ran out.
  const sources = new Map();  // key -> { args, stamp, wantStamp, result, readAt, busy, queued }
  const owners = new Map();   // id -> key, or { why }
  const listeners = new Set();
  const queue = [];
  let running = 0, stopped = false;
  const sig = (r) => JSON.stringify({ ...r, at: 0 });

  function pump() {
    while (!stopped && running < concurrency && queue.length) {
      const key = queue.shift();
      const s = sources.get(key);
      // A key queued twice (dropped and wanted again before its turn) is read once (PR-Agent r1 on #80).
      if (!s || s.busy || !s.queued) continue;
      s.queued = false; s.busy = true; running++;
      const stamp = s.wantStamp, started = now();
      let reading;
      try { reading = Promise.resolve(read(s.args)); } catch (ex) { reading = Promise.reject(ex); }
      reading.catch((ex) => ({ state: 'not-checked', why: String(ex?.message || ex).slice(0, 200), at: now() }))
        .then((result) => {
          s.busy = false; running--;
          if (stopped) return;
          // A read too old to show (get() said "not checked"), read again the same, is news: it is current again
          // (PR-Agent r1 on #3).
          const before = s.result ? sig(s.result) : null, wasStale = !!s.result && now() - s.result.at > maxAge;
          s.result = result; s.stamp = stamp; s.readAt = started;
          if (sources.get(key) === s && (before !== sig(result) || wasStale)) {
            const ids = [...owners].filter(([, k]) => k === key).map(([id]) => id);
            for (const fn of [...listeners]) { try { fn({ ids }); } catch (ex) { log(`a ${name} listener failed: ${ex?.message || ex}`); } }
          }
          pump();
        });
    }
  }

  return {
    want(targets) {
      const t = now();
      owners.clear();
      const stamps = new Map();
      for (const x of targets) {
        if (!x.key) { owners.set(x.id, { why: x.why || 'nothing to read' }); continue; }
        owners.set(x.id, x.key);
        if (!sources.has(x.key)) sources.set(x.key, { args: x.args, stamp: null, wantStamp: null, result: null, readAt: null, busy: false, queued: false });
        const stamp = String(x.stamp ?? '');
        if (!stamps.has(x.key) || stamp > stamps.get(x.key)) stamps.set(x.key, stamp);
      }
      for (const [key, s] of sources) {
        if (!stamps.has(key)) { sources.delete(key); continue; }
        s.wantStamp = stamps.get(key);
        if (s.busy || s.queued) continue;
        const age = s.readAt === null ? Infinity : t - s.readAt;
        if (age >= every || (s.wantStamp !== s.stamp && age >= gap)) { s.queued = true; queue.push(key); }
      }
      pump();
    },
    get(id) {
      const o = owners.get(id);
      if (!o) return { state: 'not-checked', why: 'not followed' };
      if (typeof o !== 'string') return { state: 'not-checked', why: o.why };
      const r = sources.get(o)?.result;
      if (!r) return { state: 'not-checked', why: 'not read yet' };
      if (now() - r.at > maxAge) return { state: 'not-checked', why: `last read ${Math.round((now() - r.at) / 1000)} s ago`, at: r.at };
      return r;
    },
    /** The ids followed now. */
    ids: () => [...owners.keys()],
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    stop() { stopped = true; queue.length = 0; },
  };
}
