// One team's room on the relay (docs/team-relay-v0_1.md). The Worker (relay/worker.mjs) runs one Durable Object per
// team, and each holds one Room. The Room is plain JavaScript over two adapters, so the tests run it in Node:
//   sql      Cloudflare's ctx.storage.sql: exec(query, ...bindings) -> a cursor with toArray() and rowsWritten.
//   sockets  list(member?), info(ws), send(ws, value), close(ws, code, reason): the hibernating WebSockets.
//
// What the room keeps, and nothing else:
//   - the roster the lead signed: member ids and public keys in plain, names and roles sealed;
//   - the latest sealed summary per member (one row each, replaced on every update, so no history);
//   - open invites (a hash of each invite's proof, its sealed secret, its end) and the asks waiting on them;
//   - sealed messages between members (actions, their results, the lead's welcome) until the receiver takes them;
//   - its own usage per UTC day: requests and messages it took, rows written, bytes in, and requests it refused.
// It never holds a key that opens a blob, so it cannot read a summary, an action, a name or a role.
import { checkAuth, isId, joinText, memberId, proofMatches, readRoster, verify } from '../client/seal.mjs';

const DAY = 86400000;
const num = (v, d) => (v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? d : Number(v));
/** The relay's settings, from the Worker's vars. A cap left empty is off: Dan sets the number once usage is known. */
export function settings(env = {}) {
  const s = {
    summaryMs: num(env.SUMMARY_MIN_MS, 10000),    // one summary update per member per this many ms
    summaryMax: num(env.SUMMARY_MAX_BYTES, 65536),
    sendMax: num(env.SEND_MAX_BYTES, 16384),
    maxDevs: num(env.MAX_DEVS, 0),                // the cap on members per team; 0 is no cap
    maxDaily: num(env.MAX_DAILY_REQUESTS, 0),     // the cap on requests plus messages per team per UTC day; 0 is no cap
    inviteMaxMs: 7 * DAY + 60000,                 // an invite lasts at most 7 days, as the onboarding mock shows
    inboxMaxMs: 7 * DAY,
    maxPending: 50, maxInvites: 20, maxInbox: 100, maxSockets: 4, keepDays: 90,
  };
  // The largest frame the relay reads: the largest blob it takes, plus room for the message around it.
  s.frameMax = Math.max(s.summaryMax, s.sendMax, 4096) + 4096;
  return s;
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS team (k INTEGER PRIMARY KEY CHECK (k = 1), id TEXT NOT NULL, lead TEXT NOT NULL, lead_sign TEXT NOT NULL, roster TEXT NOT NULL, ver INTEGER NOT NULL, created INTEGER NOT NULL)',
  // A forget empties the blob and keeps the time, so forget and summary share one rate limit (PR-Agent r1 on #78).
  'CREATE TABLE IF NOT EXISTS summary (m TEXT PRIMARY KEY, blob TEXT, at INTEGER NOT NULL) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS invite (id TEXT PRIMARY KEY, verifier TEXT NOT NULL, box TEXT NOT NULL, until INTEGER NOT NULL, by TEXT NOT NULL) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS pending (m TEXT PRIMARY KEY, invite TEXT NOT NULL, sign TEXT NOT NULL, dh TEXT NOT NULL, blob TEXT NOT NULL, sig TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS inbox (to_m TEXT NOT NULL, item TEXT NOT NULL, from_m TEXT NOT NULL, blob TEXT NOT NULL, at INTEGER NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (to_m, item)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL, messages INTEGER NOT NULL, rows_written INTEGER NOT NULL, bytes_in INTEGER NOT NULL, refused INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID',
];

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, text) => json(status, { error: text });
const isKey = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{87}$/.test(s); // a raw P-256 point (65 bytes)
const isBlob = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s);
const MAX_BODY = 65536;
const TABLES = ['team', 'summary', 'invite', 'pending', 'inbox', 'usage'];

export class Room {
  constructor({ sql, sockets, env = {}, now = () => Date.now(), onCreate = null, onDelete = null, wakeAt = null }) {
    this.sql = sql;
    this.sockets = sockets;
    this.wakeAt = wakeAt; // wakeAt(ms): the Durable Object's alarm, so expired rows go even while a team is idle
    this.cfg = settings(env);
    this.now = now;
    this.onCreate = onCreate;
    this.onDelete = onDelete;
    this.written = 0;     // rows the current request or message wrote, before the usage row's own write
    this.creating = false; // true while a new team waits on the registry: nothing else may use it yet
    this.held = 0;        // requests and messages taken under the cap and still running, so a burst cannot pass it
    this.holding = new WeakSet(); // the HTTP requests among them, given back just before they are tallied
    this.team = undefined; // the team row, read once per wake
    this.members = null;  // id -> roster entry, from the team row
    this.today = null;    // { day, n }: requests and messages taken so far today, for the daily cap
    this.refused = { n: 0, bytes: 0 }; // refused requests, counted in memory and written with the next real write
    this.bodySize = new WeakMap(); // request -> the bytes of its body, for the usage row
    this.prunedDay = null;
  }

  // SQL. Every data write adds its rows to this.written, which the usage row then records.
  rows(query, ...bindings) {
    const cur = this.sql.exec(query, ...bindings);
    const out = cur.toArray();
    this.written += cur.rowsWritten || 0;
    return out;
  }
  one(query, ...bindings) { return this.rows(query, ...bindings)[0] || null; }

  /** The team row, or null. A team id nobody made gets no tables: a stray request writes nothing. */
  teamRow() {
    if (this.team !== undefined) return this.team;
    const made = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team'").toArray().length > 0;
    if (made) for (const q of SCHEMA) this.sql.exec(q);
    this.team = made ? this.one('SELECT * FROM team WHERE k = 1') : null;
    this.members = null;
    return this.team;
  }
  roster() {
    if (!this.members) {
      const t = this.teamRow();
      this.members = new Map(t ? JSON.parse(JSON.parse(t.roster).body).members.map((m) => [m.id, m]) : []);
    }
    return this.members;
  }
  member(id) { return this.roster().get(id) || null; }
  isLead(id) { return !!this.team && this.team.lead === id; }
  canInvite(id) { return this.isLead(id) || !!this.member(id)?.invite; }

  /** Count one request or message for today, with the rows it wrote. Only for a team that exists.
   *  A refused one (a bad token, a stray path, a dev not let in yet, a team over its cap) writes nothing of its own: it
   *  is counted in memory and recorded with the next real write. So nobody outside the team can spend its daily cap or
   *  make the relay write rows (PR-Agent r1 on #78). */
  tally(requests, messages, bytes, { refused = false } = {}) {
    if (!this.team) { this.written = 0; return; }
    if (refused && !this.written) { this.refused.n += requests + messages; this.refused.bytes += bytes; return; }
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const r = this.refused;
    this.sql.exec(`INSERT INTO usage (day, requests, messages, rows_written, bytes_in, refused) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET requests = requests + excluded.requests, messages = messages + excluded.messages,
      rows_written = rows_written + excluded.rows_written, bytes_in = bytes_in + excluded.bytes_in, refused = refused + excluded.refused`,
      day, refused ? 0 : requests, refused ? 0 : messages, this.written, bytes + r.bytes, r.n + (refused ? requests + messages : 0));
    this.refused = { n: 0, bytes: 0 };
    this.written = 0;
    // A day's first row arms the alarm for the oldest day still kept, so a team that never opens an invite or sends a
    // message still has its counts end on time (PR-Agent r2 on public #6).
    if (this.armedDay !== day) { this.armedDay = day; const next = this.nextExpiry(); if (next !== null) this.expireAt(next); }
    if (refused) return;
    if (this.today?.day === day) this.today.n += requests + messages;
    else this.today = null;
    // Days past the keep window go, once per wake and day. The alarm prunes them too, for a team that went quiet.
    if (this.prunedDay !== day) { this.prunedDay = day; this.pruneUsage(); }
  }
  /** The first day still kept. */
  keepFrom() { return new Date(this.now() - this.cfg.keepDays * DAY).toISOString().slice(0, 10); }
  pruneUsage() { this.sql.exec('DELETE FROM usage WHERE day < ?', this.keepFrom()); }
  /** True when today's requests and messages taken reached the daily cap. Refused ones do not count. */
  overCap() {
    if (!this.cfg.maxDaily || !this.team) return false;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.today?.day !== day) {
      const u = this.one('SELECT requests, messages FROM usage WHERE day = ?', day);
      this.today = { day, n: u ? u.requests + u.messages : 0 };
    }
    return this.today.n + this.held >= this.cfg.maxDaily;
  }
  /** Take one place under today's cap for work that waits before it is counted. False when the cap is reached.
   *  Every true is given back with release(), just before that work is tallied (PR-Agent r3 on public #6). */
  reserve() { if (this.overCap()) return false; this.held++; return true; }
  /** reserve() for an HTTP request: its place is held until fetch() tallies it, through every await on the way out. */
  hold(request) { if (!this.reserve()) return false; this.holding.add(request); return true; }
  release() { this.held = Math.max(0, this.held - 1); }

  /** Expired invites, the asks on them, and messages nobody took in time. An ask that ends with its invite goes
   *  through drop(), so a dev still waiting hears it and their socket closes, and the inviters hear it is gone
   *  (PR-Agent r2 on #78). */
  prune() {
    const now = this.now();
    const ended = this.rows('SELECT m FROM pending WHERE invite NOT IN (SELECT id FROM invite WHERE until >= ?)', now).map((p) => p.m);
    this.rows('DELETE FROM invite WHERE until < ?', now);
    this.drop(ended, 'The invite has ended. Ask the lead for a new link.');
    this.rows('DELETE FROM inbox WHERE until < ?', now);
    this.pruneUsage();
  }
  /** The next time something here expires, for the alarm. */
  nextExpiry() {
    const r = this.sql.exec('SELECT MIN(u) AS u FROM (SELECT MIN(until) AS u FROM invite UNION ALL SELECT MIN(until) AS u FROM inbox)').toArray()[0];
    // The oldest usage day leaves keepDays after it, so an idle team's counts end on time too (PR-Agent r1 on
    // public #6).
    const oldest = this.sql.exec('SELECT MIN(day) AS d FROM usage').toArray()[0]?.d;
    const usageEnds = oldest ? Date.parse(oldest + 'T00:00:00Z') + (this.cfg.keepDays + 1) * DAY : null;
    const all = [r?.u ?? null, usageEnds].filter((x) => x !== null);
    return all.length ? Math.min(...all) : null;
  }
  /** Ask the Durable Object to wake when this row expires, so an idle team keeps nothing past its time. */
  expireAt(until) { if (this.wakeAt) this.wakeAt(until + 1000); }
  /** The alarm: drop what expired, then set the next one. */
  async alarm() {
    if (!this.teamRow() || this.creating) return null;
    this.prune();
    this.tally(0, 0, 0, { refused: true });
    const next = this.nextExpiry();
    if (next !== null && this.wakeAt) this.wakeAt(next + 1000);
    return next;
  }

  send(ws, value) { try { this.sockets.send(ws, value); } catch { /* a socket that went away hears nothing */ } }
  /** Every member socket, or one member's. Pending sockets only when asked. */
  socketsOf(id = null, { pending = false } = {}) {
    // A member socket counts only while its member is on the roster: one that slipped past a removal hears nothing
    // (PR-Agent r4 on public #6).
    return this.sockets.list(id).filter((ws) => { const a = this.sockets.info(ws); return a && (pending || (a.role === 'member' && !!this.member(a.m))); });
  }
  /** The socket's role as of now, read again just before the Worker accepts it, with no wait in between: a member
   *  removed or an ask declined after route() said yes gets no socket (PR-Agent r4 on public #6). Null: refuse it. */
  admit(up) {
    if (!up || !this.teamRow() || this.creating) return null;
    const role = this.member(up.m) ? 'member' : this.one('SELECT m FROM pending WHERE m = ?', up.m) ? 'pending' : null;
    if (!role) return null;
    // One Mac may hold a few sockets (a restart before the old one closed). Past the limit the oldest gives way. Done
    // here, where the socket is accepted with no wait, so upgrades that arrive together cannot pass the limit
    // (PR-Agent r5 on public #6).
    const mine = this.socketsOf(up.m, { pending: true });
    for (const ws of mine.slice(0, Math.max(0, mine.length - this.cfg.maxSockets + 1))) this.sockets.close(ws, 4005, 'Replaced by a newer connection.');
    return { m: up.m, role };
  }
  broadcast(value, { except = null, to = null } = {}) {
    for (const ws of this.socketsOf()) {
      const a = this.sockets.info(ws);
      if (a.m !== except && (!to || to(a.m))) this.send(ws, value);
    }
  }

  // HTTP: create a team, ask to join, open a socket, delete a team. Returns a Response, or { upgrade } for a socket.
  async fetch(request) {
    const url = new URL(request.url);
    const [v, teams, team, ...rest] = url.pathname.split('/').filter(Boolean);
    let out;
    try {
      if (v !== 'v1' || teams !== 'teams' || !isId(team)) out = fail(404, 'Not a relay address.');
      else if (this.teamRow() && this.team.id !== team) out = fail(500, 'This room holds another team.');
      // A team the registry has not taken yet may still be undone: nobody asks to join it or opens a socket on it
      // until it is made (PR-Agent r3 on public #6).
      else if (this.creating) out = fail(503, 'This team is still being made. Try again in a moment.');
      else out = await this.route(request, url, team, rest.join('/'));
    } catch (ex) {
      out = fail(ex.status || 500, ex.status === 413 ? 'That request is too large.' : ex.status === 400 ? 'The relay could not read that request.' : 'The relay failed on that request.');
    }
    // The daily cap is checked where a request is known to come from the team (route), never before: a stranger who
    // knows the team id must not spend it.
    if (this.holding.delete(request)) this.release();
    this.tally(1, 0, this.bodySize.get(request) || 0, { refused: out instanceof Response && out.status >= 400 });
    return out;
  }
  capped() { return fail(429, 'This team reached its daily cap on the relay. It resets at 00:00 UTC.'); }

  /** The body as JSON, read up to MAX_BODY bytes and no further: a huge body is refused before it fills memory. */
  async readJson(request) {
    const tooLarge = () => Object.assign(new Error('too large'), { status: 413 });
    if (Number(request.headers.get('content-length')) > MAX_BODY) throw tooLarge();
    const parts = [];
    let size = 0;
    const reader = request.body ? request.body.getReader() : null;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      this.bodySize.set(request, size);
      if (size > MAX_BODY) { try { await reader.cancel(); } catch { /* gone */ } throw tooLarge(); }
      parts.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(all)); } catch { throw Object.assign(new Error('not JSON'), { status: 400 }); }
  }

  async route(request, url, team, rest) {
    const method = request.method;
    if (rest === '' && method === 'POST') return this.create(team, await this.readJson(request));
    if (!this.team) return fail(404, 'No such team on this relay.');
    if (rest === 'join' && method === 'POST') return this.join(team, await this.readJson(request), request);
    if (rest === 'ws' && method === 'GET') {
      if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return fail(426, 'Open this address as a WebSocket.');
      this.prune();
      const m = await this.signedIn(url.searchParams.get('auth'), { team, method, path: url.pathname });
      if (!m) return fail(401, 'The relay does not know this member, or the sign-in token is old.');
      if (!this.hold(request)) return this.capped();
      return { upgrade: { m: m.id, role: this.member(m.id) ? 'member' : 'pending' } };
    }
    // A Mac whose socket keeps failing asks what the relay knows of it. A socket that fails to open shows no status, so
    // without this a declined or removed dev would retry forever. The relay's clock comes back on a 401, so the app can
    // tell a wrong Mac clock from a dropped member.
    if (rest === 'me' && method === 'GET') {
      const auth = (request.headers.get('authorization') || '').replace(/^YesChef\s+/i, '');
      const m = await this.signedIn(auth, { team, method, path: url.pathname });
      if (!m) return json(401, { error: 'The relay does not know this member, or the sign-in token is old.', now: this.now() });
      if (!this.hold(request)) return this.capped();
      return json(200, { m: m.id, role: this.member(m.id) ? 'member' : 'pending', now: this.now() });
    }
    if (rest === '' && method === 'DELETE') {
      const auth = (request.headers.get('authorization') || '').replace(/^YesChef\s+/i, '');
      const m = await checkAuth(auth, { team, method, path: url.pathname, now: this.now(), signPubOf: (id) => this.member(id)?.sign || null });
      if (!m || !this.isLead(m)) return fail(403, 'Only the lead can delete the team.');
      // The registry row goes only as this team made it: a slow retry of this delete never removes the row of a team
      // made again under this id (PR-Agent r7 on public #6).
      const created = this.teamRow()?.created ?? null;
      if (created === null) return fail(404, 'Not a relay address.');
      for (const ws of this.sockets.list()) this.sockets.close(ws, 4004, 'The lead deleted the team.');
      // The cache is cleared only after the delete, and read again from storage if it failed: a delete that stops
      // halfway leaves a team that still answers, so the lead can retry it and /v1/usage keeps it listed (PR-Agent r1
      // on public #6).
      try { await this.onDelete?.(team, created); }
      // armedDay too: a team made again under this id the same day arms its own alarm (PR-Agent r5 on public #6).
      finally { this.team = undefined; this.members = null; this.today = null; this.armedDay = null; this.prunedDay = null; }
      return json(200, { deleted: team });
    }
    return fail(404, 'Not a relay address.');
  }

  /** The member or waiting dev a token signs in, or null. The key is looked up again after the signature check: a
   *  dev removed, declined or given a new key while it ran is refused, not let in on the old key (PR-Agent r3 on
   *  public #6). */
  async signedIn(auth, { team, method, path }) {
    const keyOf = (id) => this.member(id)?.sign || this.one('SELECT sign FROM pending WHERE m = ?', id)?.sign || null;
    let used = null;
    const id = await checkAuth(auth, { team, method, path, now: this.now(), signPubOf: (x) => (used = keyOf(x)) });
    if (!id || !used || !this.teamRow() || keyOf(id) !== used) return null;
    return { id };
  }

  async create(team, body) {
    if (this.teamRow()) return fail(409, 'That team already exists.');
    const r = await readRoster(body?.roster, { team });
    if (!r || r.ver !== 1) return fail(400, 'A new team needs its first roster, signed by its lead.');
    if (this.cfg.maxDevs && r.members.length > this.cfg.maxDevs) return fail(403, `A team on this relay holds up to ${this.cfg.maxDevs} people.`);
    for (const q of SCHEMA) this.sql.exec(q);
    const lead = r.members.find((m) => m.id === r.lead);
    const now = this.now();
    this.rows('INSERT INTO team (k, id, lead, lead_sign, roster, ver, created) VALUES (1, ?, ?, ?, ?, ?, ?)', team, r.lead, lead.sign, JSON.stringify(body.roster), 1, now);
    this.team = undefined;
    this.teamRow();
    this.creating = true;
    try {
      await this.onCreate?.(team, now);
    } catch (ex) {
      // The registry did not take the team: undo it, so the app's retry makes it again and /v1/usage never misses a team
      // that exists (PR-Agent r2 on #78).
      for (const t of TABLES) this.sql.exec(`DROP TABLE IF EXISTS ${t}`);
      this.team = undefined; this.members = null; this.today = null; this.armedDay = null; this.prunedDay = null;
      throw ex;
    } finally {
      this.creating = false;
    }
    return json(201, { team, ver: 1 });
  }

  async join(team, body, request) {
    this.prune();
    const { invite, proof, sign, dh, blob, sig } = body || {};
    if (!isId(invite) || typeof proof !== 'string' || !isKey(sign) || !isKey(dh) || !isBlob(blob, 4096) || typeof sig !== 'string') return fail(400, 'That ask to join is not complete.');
    const inv = this.one('SELECT verifier, until FROM invite WHERE id = ?', invite);
    if (!inv) return fail(410, 'This invite has ended. Ask the lead for a new link.');
    if (!(await proofMatches(proof, inv.verifier))) return fail(403, 'This invite link is not valid.');
    // The signing key must sign the ask: proof the asker holds it, bound to the key agreement key and the sealed ask.
    if (!(await verify(sign, sig, joinText(this.team.id, invite, dh, blob)))) return fail(403, 'That ask to join is not signed by its key.');
    const m = await memberId(sign);
    // The cap after the last wait, and its place held until the ask is counted, so asks that arrive together cannot all
    // pass it (PR-Agent r3 and r4 on public #6).
    if (!this.hold(request)) return this.capped();
    // The invite again, after the last wait: a revoke that landed while the keys were checked ends this ask too
    // (PR-Agent r2 on public #6).
    if (!this.one('SELECT id FROM invite WHERE id = ? AND until >= ?', invite, this.now())) return fail(410, 'This invite has ended. Ask the lead for a new link.');
    if (this.member(m)) return fail(409, 'You are already on this team.');
    // One ask per key per minute: someone holding a link cannot rewrite their ask in a loop.
    const had = this.one('SELECT at FROM pending WHERE m = ?', m);
    if (had && this.now() - had.at < 60000) return fail(429, 'You asked a moment ago. The lead will answer.');
    const others = this.one('SELECT COUNT(*) AS n FROM pending WHERE m != ?', m).n;
    if (others >= this.cfg.maxPending) return fail(429, 'Too many people are waiting to join. Ask the lead to answer them first.');
    if (this.cfg.maxDevs && this.roster().size + others + 1 > this.cfg.maxDevs) return fail(403, `A team on this relay holds up to ${this.cfg.maxDevs} people.`);
    const at = this.now();
    this.rows(`INSERT INTO pending (m, invite, sign, dh, blob, sig, at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(m) DO UPDATE SET invite = excluded.invite, sign = excluded.sign, dh = excluded.dh, blob = excluded.blob, sig = excluded.sig, at = excluded.at`, m, invite, sign, dh, blob, sig, at);
    this.broadcast({ t: 'pending', pending: { m, invite, sign, dh, blob, sig, at } }, { to: (id) => this.canInvite(id) });
    this.expireAt(inv.until);
    return json(202, { m, until: inv.until });
  }

  /** A socket the Worker just accepted. */
  opened(ws) {
    const a = this.sockets.info(ws);
    if (a.role !== 'member') { this.send(ws, { t: 'hello', me: a.m, role: 'pending' }); return; }
    const inviter = this.canInvite(a.m);
    const online = [...new Set(this.socketsOf().map((s) => this.sockets.info(s).m))];
    this.send(ws, {
      t: 'hello', me: a.m, role: 'member', ver: this.team.ver, roster: JSON.parse(this.team.roster), online,
      summaries: this.rows('SELECT m, blob, at FROM summary WHERE blob IS NOT NULL'),
      inbox: this.rows('SELECT item, from_m AS "from", blob, at FROM inbox WHERE to_m = ? AND until >= ?', a.m, this.now()),
      invites: inviter ? this.rows('SELECT id, box, until, by FROM invite') : [],
      pending: inviter ? this.rows('SELECT m, invite, sign, dh, blob, sig, at FROM pending') : [],
      limits: { summaryMs: this.cfg.summaryMs, summaryMax: this.cfg.summaryMax, sendMax: this.cfg.sendMax },
    });
    // The member's first socket: the others hear it came online.
    if (this.socketsOf(a.m).length === 1) this.broadcast({ t: 'presence', m: a.m, on: true }, { except: a.m });
  }

  /** A socket closed. Others hear that the member went offline once its last socket is gone. */
  closed(ws) {
    if (!this.teamRow()) return;
    const a = this.sockets.info(ws);
    if (!a || a.role !== 'member') return;
    if (!this.socketsOf(a.m).some((s) => s !== ws)) this.broadcast({ t: 'presence', m: a.m, on: false }, { except: a.m });
  }

  async message(ws, data) {
    const bytes = typeof data === 'string' ? data.length : data.byteLength || 0;
    if (!this.teamRow()) { this.sockets.close(ws, 4004, 'No such team.'); return; }
    // A frame past the largest real message is never decoded or parsed: parsing a 32 MiB frame could use up the
    // object's memory and drop every socket on the team. The socket closes (1009, too big) and the frame counts as
    // refused (PR-Agent r2 on #78).
    if (bytes > this.cfg.frameMax) { this.sockets.close(ws, 1009, 'That message is too large.'); this.tally(0, 1, bytes, { refused: true }); return; }
    let msg = null, refused = true, held = false;
    try {
      // Parsed before the cap check, so a capped reply carries the request's id and the app stops waiting on it
      // (PR-Agent r3 on #78). The frame is already within the limit above.
      try { msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { msg = null; }
      if (!(held = this.reserve())) { this.send(ws, { t: 'err', id: msg?.id, code: 'cap', text: 'This team reached its daily cap on the relay. It resets at 00:00 UTC.' }); return; }
      if (!msg || typeof msg.t !== 'string') { this.send(ws, { t: 'err', id: msg?.id, code: 'bad', text: 'The relay could not read that message.' }); return; }
      const a = this.sockets.info(ws);
      if (a.role !== 'member' || !this.member(a.m)) { this.send(ws, { t: 'err', id: msg.id, code: 'wait', text: 'The lead has not let you in yet.' }); return; }
      refused = false;
      const reply = await this.handle(a.m, msg);
      this.send(ws, { id: msg.id, ...reply });
    } catch {
      this.send(ws, { t: 'err', id: msg?.id, code: 'fail', text: 'The relay failed on that message.' });
    } finally {
      if (held) this.release();
      this.tally(0, 1, bytes, { refused });
    }
  }

  async handle(me, msg) {
    const now = this.now();
    const ok = (more = {}) => ({ t: 'ok', ...more });
    const no = (code, text, more = {}) => ({ t: 'err', code, text, ...more });
    switch (msg.t) {
      case 'summary': {
        if (!isBlob(msg.blob, this.cfg.summaryMax)) return no('bad', 'That summary is empty or too large.');
        // Rate limit: one update per member per summaryMs, so writes stay small. The app keeps the newest and sends it after.
        const last = this.one('SELECT at FROM summary WHERE m = ?', me);
        if (last && now - last.at < this.cfg.summaryMs) return no('slow', 'Too soon after your last summary.', { retryAfter: this.cfg.summaryMs - (now - last.at) });
        this.rows(`INSERT INTO summary (m, blob, at) VALUES (?, ?, ?) ON CONFLICT(m) DO UPDATE SET blob = excluded.blob, at = excluded.at`, me, msg.blob, now);
        this.broadcast({ t: 'summary', m: me, blob: msg.blob, at: now }, { except: me });
        return ok({ at: now });
      }
      case 'forget': {
        // The time stays, so a forget counts against the same limit as a summary.
        const last = this.one('SELECT at, blob IS NULL AS gone FROM summary WHERE m = ?', me);
        if (!last || last.gone) return ok();
        if (now - last.at < this.cfg.summaryMs) return no('slow', 'Too soon after your last summary.', { retryAfter: this.cfg.summaryMs - (now - last.at) });
        this.rows('UPDATE summary SET blob = NULL, at = ? WHERE m = ?', now, me);
        this.broadcast({ t: 'gone', m: me }, { except: me });
        return ok();
      }
      case 'send': {
        if (!isId(msg.to) || !this.member(msg.to) || msg.to === me) return no('bad', 'That member is not on the team.');
        if (!isBlob(msg.blob, this.cfg.sendMax)) return no('bad', 'That message is empty or too large.');
        const ttl = Math.min(Math.max(Number(msg.ttl) || 15 * 60000, 60000), this.cfg.inboxMaxMs);
        // Expired messages leave first, so they never hold a place (PR-Agent r1 on #78).
        this.rows('DELETE FROM inbox WHERE to_m = ? AND until < ?', msg.to, now);
        if (this.one('SELECT COUNT(*) AS n FROM inbox WHERE to_m = ?', msg.to).n >= this.cfg.maxInbox) return no('full', 'Their inbox on the relay is full. They have not been online to take it.');
        const item = crypto.randomUUID();
        this.rows('INSERT INTO inbox (to_m, item, from_m, blob, at, until) VALUES (?, ?, ?, ?, ?, ?)', msg.to, item, me, msg.blob, now, now + ttl);
        for (const ws of this.socketsOf(msg.to)) this.send(ws, { t: 'inbox', item, from: me, blob: msg.blob, at: now });
        this.expireAt(now + ttl);
        return ok({ item });
      }
      case 'done': {
        this.rows('DELETE FROM inbox WHERE to_m = ? AND item = ?', me, String(msg.item || ''));
        return ok();
      }
      case 'invite': {
        if (!this.canInvite(me)) return no('role', 'Your role cannot invite people.');
        const until = Number(msg.until);
        if (!isId(msg.invite) || !/^[A-Za-z0-9_-]{43}$/.test(msg.verifier || '') || !isBlob(msg.box, 1024)) return no('bad', 'That invite is not complete.');
        if (!(until > now && until <= now + this.cfg.inviteMaxMs)) return no('bad', 'An invite lasts at most 7 days.');
        this.prune();
        // The same invite sent again (a retry after a lost answer) is taken once, even with the invites full (r2).
        // Another invite under a used id is refused, so nobody hears a box that does not match the verifier the relay
        // checks (PR-Agent r1 on public #6).
        const had = this.one('SELECT verifier, box, until, by FROM invite WHERE id = ?', msg.invite);
        if (had) {
          if (had.verifier === msg.verifier && had.box === msg.box && had.until === until && had.by === me) return ok({ until });
          return no('bad', 'That invite id is taken. Make a new link.');
        }
        if (this.one('SELECT COUNT(*) AS n FROM invite').n >= this.cfg.maxInvites) return no('full', 'Too many open invites. Revoke one first.');
        this.rows('INSERT INTO invite (id, verifier, box, until, by) VALUES (?, ?, ?, ?, ?)', msg.invite, msg.verifier, msg.box, until, me);
        this.broadcast({ t: 'invite', invite: { id: msg.invite, box: msg.box, until, by: me } }, { except: me, to: (id) => this.canInvite(id) });
        this.expireAt(until);
        return ok({ until });
      }
      case 'revoke': {
        const inv = this.one('SELECT by FROM invite WHERE id = ?', String(msg.invite || ''));
        if (!inv) return ok();
        if (!this.isLead(me) && inv.by !== me) return no('role', 'Only the lead or the person who made it can revoke an invite.');
        this.rows('DELETE FROM invite WHERE id = ?', msg.invite);
        this.drop(this.rows('SELECT m FROM pending WHERE invite = ?', msg.invite).map((p) => p.m), 'The invite was revoked.');
        // The other inviters drop it from their open links too (PR-Agent r6 on public #6).
        this.broadcast({ t: 'invite-gone', invite: msg.invite }, { except: me, to: (id) => this.canInvite(id) });
        return ok();
      }
      case 'decline': {
        if (!this.isLead(me)) return no('role', 'Only the lead can answer an ask to join.');
        this.drop([String(msg.m || '')], 'The lead declined.');
        return ok();
      }
      case 'roster': return this.newRoster(me, msg.roster);
      default: return no('bad', 'The relay does not know that message.');
    }
  }

  /** Remove asks to join, tell their sockets, and tell the inviters. */
  drop(ids, why) {
    for (const m of ids) {
      if (!this.rows('DELETE FROM pending WHERE m = ? RETURNING m', m).length) continue;
      for (const ws of this.sockets.list(m)) {
        if (this.sockets.info(ws)?.role !== 'pending') continue;
        this.send(ws, { t: 'declined', text: why });
        this.sockets.close(ws, 4002, why);
      }
      this.broadcast({ t: 'pending-gone', m }, { to: (id) => this.canInvite(id) });
    }
  }

  /** The lead's new roster: approve asks, change roles, remove people. */
  async newRoster(me, roster) {
    if (!this.isLead(me)) return { t: 'err', code: 'role', text: 'Only the lead can change the team.' };
    const r = await readRoster(roster, { team: this.team.id, leadSignPub: this.team.lead_sign });
    if (!r || r.lead !== this.team.lead) return { t: 'err', code: 'bad', text: 'That roster is not signed by this team\'s lead.' };
    if (r.ver !== this.team.ver + 1) return { t: 'err', code: 'stale', text: `The team changed. Roster ${this.team.ver} is current.`, ver: this.team.ver };
    // Asks still waiting hold their places, as join() counts them: a roster cannot take a place an ask was given
    // (PR-Agent r1 on public #6).
    const listed = new Set(r.members.map((m) => m.id));
    const waiting = this.rows('SELECT m FROM pending').filter((p) => !listed.has(p.m)).length;
    if (this.cfg.maxDevs && r.members.length + waiting > this.cfg.maxDevs) return { t: 'err', code: 'cap', text: `A team on this relay holds up to ${this.cfg.maxDevs} people, counting the asks still waiting. Decline one first.` };
    const before = new Set(this.roster().keys());
    const after = new Set(r.members.map((m) => m.id));
    this.rows('UPDATE team SET roster = ?, ver = ? WHERE k = 1', JSON.stringify(roster), r.ver);
    this.team = undefined; this.teamRow();
    const removed = [...before].filter((id) => !after.has(id));
    const added = [...after].filter((id) => !before.has(id));
    for (const id of removed) {
      this.rows('DELETE FROM summary WHERE m = ?', id);
      this.rows('DELETE FROM inbox WHERE to_m = ? OR from_m = ?', id, id);
      for (const ws of this.sockets.list(id)) this.sockets.close(ws, 4003, 'You were removed from the team.');
    }
    for (const id of added) {
      this.rows('DELETE FROM pending WHERE m = ?', id);
      // An approved dev reconnects as a member and gets the whole team in its hello.
      for (const ws of this.sockets.list(id)) this.sockets.close(ws, 4001, 'Approved. Connect again.');
    }
    this.broadcast({ t: 'roster', roster }, { except: me, to: (id) => after.has(id) });
    for (const id of removed) this.broadcast({ t: 'gone', m: id }, { to: (x) => after.has(x) });
    for (const id of added) this.broadcast({ t: 'pending-gone', m: id }, { to: (x) => this.canInvite(x) });
    return { t: 'ok', ver: r.ver };
  }

  /** This team's usage, newest day first, for the relay's owner to set the cap from. Null once the team is gone. */
  usage(days = 7) {
    if (!this.teamRow()) return null;
    const since = new Date(this.now() - (Math.min(Math.max(Number(days) || 7, 1), this.cfg.keepDays) - 1) * DAY).toISOString().slice(0, 10);
    const rows = this.sql.exec('SELECT day, requests, messages, rows_written, bytes_in, refused FROM usage WHERE day >= ? ORDER BY day DESC', since).toArray();
    return { team: this.team.id, created: this.team.created, members: this.roster().size, days: rows };
  }
}

/** One page of `GET /v1/usage`, 40 teams by default: each read is a subrequest, and the free plan allows 50 per request.
 *  A listed team whose object holds nothing (its delete stopped after the data went but before the registry heard)
 *  leaves the registry here, in one call, so the list heals itself and stops counting a team that is gone
 *  (PR-Agent r3 on #78). */
export async function usagePage(reg, usageOf, { after = '', days = 7, page = 40 } = {}) {
  const rows = await reg.list(after, page);
  const ids = rows.map((r) => r.id);
  const read = await Promise.all(rows.map(async (r) => [r, await usageOf(r.id, days)]));
  // Each gone row leaves only as it was listed (its id and when it was made): a team deleted and made again while this
  // page was read keeps its new row (PR-Agent r6 on public #6).
  const gone = read.filter(([, u]) => !u).map(([r]) => ({ id: r.id, created: r.created }));
  if (gone.length) await reg.remove(gone);
  return { teams: read.map(([, u]) => u).filter(Boolean), total: await reg.count(), next: ids.length === page ? ids[ids.length - 1] : null };
}
