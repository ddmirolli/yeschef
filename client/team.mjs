// The team client: one dev's Yes Chef on the relay (docs/team-relay-v0_1.md, "The app"). It keeps the socket, sends
// this dev's sealed summary, reads the team's, and runs a teammate's action on this dev's own threads only after it
// checks the sender, the sender's role, the action's age and its id. It never acts through anything but the dev's own
// capped T3 sign-in, which the caller passes in as `run`.
//
// Reconnects follow T3 Code's rules: one owner for retries, jittered backoff capped at five minutes, a probe on wake,
// the socket's health kept apart from how fresh the data is, and a cached summary never shown as live.
import {
  newId, isId, newMember, saveMember, loadMember, authToken, AUTH_SKEW_MS, signRoster, readRoster, newTeamKey, teamKey,
  seal, open, aad, sealSigned, openSigned, sealTo, openFrom, newInvite, readInvite, joinRequest, openJoin,
} from './seal.mjs';
import { grant, allows, refusal, signature, shares } from './roles.mjs';

/** A roster's fingerprint: SHA-256 of its signed body. Two rosters with one version must have one fingerprint. */
async function rosterDigest(body) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(body))));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const RETRY = { base: 1000, cap: 5 * 60000 };
export const PING_MS = 30000, PONG_MS = 10000, ASK_MS = 15000;
/** A teammate's action older than this is not run. It is also how long the relay holds it. */
export const ACT_TTL = 15 * 60000;
/** A dev's own board older than this is not checked: an action waits for a fresh one. */
export const BOARD_FRESH_MS = 60000;
// A member without the team key asks the lead for another welcome at most this often.
export const KEY_ASK_MS = 86400000;
const LATER_INBOX = 100, SUMMARY_TICKETS = 100, SEEN_MAX = 500, STATE_V = 1;
// A seen id is kept past the last moment its action could still be taken: its age limit plus the clock skew allowed.
const SEEN_KEEP_MS = ACT_TTL + AUTH_SKEW_MS + 60000;

/** The network as the app has it: fetch for HTTP, the platform's WebSocket for the socket. */
export const webNet = {
  async http(method, url, body, headers = {}) {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let out = null;
    try { out = await res.json(); } catch { out = null; }
    return { status: res.status, body: out };
  },
  socket: (url) => new WebSocket(url),
};

const failText = (res) => res?.body?.error || `The relay answered ${res?.status}.`;
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Make a team: this Mac's keys, the team key, roster 1 with this dev as lead. Returns the state to save (it holds
 *  private keys and the team key: the app seals it before it touches a disk). */
export async function createTeam({ relay, teamName, name, net = webNet, now = Date.now }) {
  const me = await newMember();
  const team = newId();
  const raw = newTeamKey();
  const key = await teamKey(raw);
  const people = { [me.id]: { name: clean(name, 60), ...grant('lead') } };
  const detail = await seal(key, people, aad.detail(team, 1));
  const roster = await signRoster(me, { team, ver: 1, lead: me.id, at: now(), members: [{ id: me.id, sign: me.signPub, dh: me.dhPub, invite: true }], detail });
  const res = await net.http('POST', `${relay}/v1/teams/${team}`, { roster });
  if (res.status !== 201) throw new Error(failText(res));
  return { v: STATE_V, relay, team, teamName: clean(teamName, 80), leadSign: me.signPub, me: await saveMember(me), name: clean(name, 60), key: raw, status: 'member', shared: [], seen: [], rosterVer: 1 };
}

/** Ask to join with an invite link. The name is what the dev types at Join; projects are the titles they share, for
 *  the lead's dialog. Returns the state to save: it waits for the lead. */
export async function joinTeam({ link, name, projects = [], shared = [], net = webNet, now = Date.now }) {
  const inv = readInvite(link);
  if (!inv) throw new Error('That is not a Yes Chef invite link.');
  if (inv.until < now()) throw new Error('This invite has ended. Ask the lead for a new link.');
  const me = await newMember();
  const ask = { name: clean(name, 60), projects: projects.map((p) => clean(p, 80)).slice(0, 50) };
  if (!ask.name) throw new Error('Type your name first.');
  const res = await net.http('POST', `${inv.relay}/v1/teams/${inv.team}/join`, await joinRequest(inv, me, ask));
  if (res.status !== 202) throw new Error(failText(res));
  return { v: STATE_V, relay: inv.relay, team: inv.team, teamName: inv.teamName, leadName: inv.leadName, leadSign: inv.leadSignPub,
    me: await saveMember(me), name: ask.name, key: null, status: 'pending', shared: [...shared], seen: [], rosterVer: 0 };
}

/** The live team. state: from createTeam or joinTeam. save(state): called whenever it changes.
 *  run(input, prefix): runs an action on this dev's own board through their T3 sign-in (client/actions.mjs act()).
 *  board(): { board, ok, at }: this dev's board as the Pass last read it. */
export class Team {
  constructor({ state, save = () => {}, net = webNet, now = Date.now, timers = globalThis, random = Math.random, run = null, board = null }) {
    if (!state || state.v !== STATE_V || !isId(state.team)) throw new Error('Not a saved team.');
    Object.assign(this, { state, saveFn: save, net, now, timers, random, run, boardOf: board });
    this.link = 'off';           // the socket: off, connecting, online, waiting (a retry is set), stopped
    this.linkAt = now();
    this.attempts = 0;
    this.retry = null;           // the one retry timer
    this.ws = null;
    this.asks = new Map();       // request id -> { resolve, timer }
    this.out = new Map();        // action nonce -> { resolve, timer }
    this.rosterLock = Promise.resolve(); // the lead's roster edits, one at a time
    this.writes = Promise.resolve();     // the store's writes, one at a time
    this.unsaved = false;        // the last roster floor did not reach the disk: the screens say so
    this.listeners = new Set();
    this.roster = null;          // the verified roster body
    this.people = new Map();     // id -> { id, sign, dh, invite, name, role, perms }
    this.summaries = new Map();  // id -> { at, body } (opened)
    this.summaryFloor = new Map(); // id -> the newest summary revision taken, kept across reconnects
    this.online = new Set();
    this.pending = new Map();    // asks to join, for inviters: m -> { m, invite, at, name, projects }
    this.invites = new Map();    // id -> { id, until, by, secret }
    this.limits = { summaryMs: 10000, summaryMax: 65536, sendMax: 16384 };
    this.next = null;            // the newest summary not yet sent: { json, body }
    this.sentJson = null;        // the last summary the relay took
    this.sentAt = 0;
    this.summaryTimer = null;
    this.holds = new Map();
    this.answered = new Map();
    this.seen = new Map(state.seen || []);
    this.key = null;
    this.later = [];             // messages that need the team key, kept until the welcome brings it
  }

  // ---- state and events ----
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data = {}) { for (const fn of [...this.listeners]) { try { fn({ type, ...data }); } catch { /* a listener's fault is its own */ } } }
  /** Queue one write of the state as it is now. Writes go one at a time, in order, each a copy taken when it was
   *  queued: an older write never lands after a newer one (PR-Agent r6 on public #7). Resolves true once written. */
  write() {
    this.state.seen = [...this.seen];
    let snap;
    try { snap = structuredClone(this.state); } catch { snap = JSON.parse(JSON.stringify(this.state)); }
    const done = this.writes.then(() => this.saveFn(snap)).then(() => true, () => false);
    this.writes = done;
    // A store that answers later (the desktop app's Keychain) reports here too: a failed write shows as unsaved, never
    // as an unhandled rejection (PR-Agent r5 on public #7).
    return done.then((ok) => { this.saved(ok); return ok; });
  }
  save() { this.write(); return true; }
  /** The last save's outcome. The screens say "Not saved" until a later save gets through. */
  saved(ok) { const was = this.unsaved; this.unsaved = !ok; if (was !== this.unsaved) this.emit('team'); }
  /** Save and wait until the store says it is written. False when it failed: whatever needed it does not go ahead. */
  saveNow() { return this.write(); }
  setLink(link) { if (this.link !== link) { this.link = link; this.linkAt = this.now(); this.emit('link', { link }); } }
  async member() { return this.meCache || (this.meCache = await loadMember(this.state.me)); }
  async teamKey() { if (!this.key && this.state.key) this.key = await teamKey(this.state.key); return this.key; }
  get me() { return this.people.get(this.meId) || null; }
  get isLead() { return !!this.roster && this.roster.lead === this.meId; }

  /** What the screens show. Health and freshness are apart: a summary carries its own time, and nobody reads as
   *  online, nor any summary as live, while this Mac's socket is not. */
  view() {
    const live = this.link === 'online';
    return {
      status: this.state.status, link: this.link, linkAt: this.linkAt, team: this.state.team, teamName: this.state.teamName, unsaved: this.unsaved,
      me: this.me ? { id: this.meId, name: this.me.name, role: this.me.role, perms: this.me.perms } : { id: this.meId, name: this.state.name, role: null, perms: [] },
      lead: this.isLead,
      people: [...this.people.values()].map((p) => {
        const s = this.summaries.get(p.id);
        return { id: p.id, name: p.name, role: p.role, perms: p.perms, online: live && this.online.has(p.id),
          summary: s?.body || null, at: s?.at || null, live: live && !!s };
      }),
      pending: [...this.pending.values()],
      invites: [...this.invites.values()].map(({ id, until, by }) => ({ id, until, by })),
    };
  }

  // ---- the socket ----
  start() {
    if (['declined', 'removed', 'ended'].includes(this.state.status)) { this.setLink('stopped'); return; }
    this.stopped = false;
    // A retry left waiting from before would fire over the connection this opens (PR-Agent r10 on public #7).
    this.timers.clearTimeout(this.retry); this.retry = null;
    this.connect();
  }
  stop() {
    this.stopped = true;
    this.attempt = (this.attempt || 0) + 1;
    this.timers.clearTimeout(this.retry); this.retry = null;
    this.timers.clearTimeout(this.summaryTimer); this.summaryTimer = null;
    this.stopBeat();
    const ws = this.ws; this.ws = null;
    try { ws?.close(1000, 'Yes Chef closed.'); } catch { /* already closed */ }
    for (const [, a] of this.asks) { this.timers.clearTimeout(a.timer); a.resolve({ t: 'err', code: 'closed', text: 'Not sent: the team connection closed.' }); }
    this.asks.clear();
    this.setLink('stopped');
  }
  /** The Mac woke or the network came back: probe now instead of waiting out the backoff. */
  wake() {
    if (this.stopped || this.link === 'stopped') return;
    if (this.link === 'waiting') { this.timers.clearTimeout(this.retry); this.retry = null; this.connect(); return; }
    if (this.link === 'online') this.ping();
  }

  async connect() {
    if (this.stopped || this.ws || this.link === 'connecting') return;
    this.setLink('connecting');
    // A stop() while this attempt waits on the keys makes it stale: it opens nothing, and a start() after the stop owns
    // the one socket (PR-Agent r8 on public #7).
    const attempt = this.attempt = (this.attempt || 0) + 1;
    let ws;
    try {
      const me = await this.member();
      this.meId = me.id;
      const path = `/v1/teams/${this.state.team}/ws`;
      const auth = await authToken(me, { team: this.state.team, method: 'GET', path, now: this.now() });
      if (this.stopped || attempt !== this.attempt) return;
      ws = this.net.socket(`${this.state.relay.replace(/^http/, 'ws')}${path}?auth=${encodeURIComponent(auth)}`);
    } catch { if (attempt === this.attempt) this.lost(1006); return; }
    this.ws = ws;
    let opened = false;
    // The relay's hello has a deadline, counted from when the socket is made: a socket that never opens, or opens and
    // never says hello, is retried, not kept connecting for ever (PR-Agent r2 and r7 on public #7).
    this.timers.setTimeout(() => {
      if (this.ws !== ws || this.link !== 'connecting') return;
      this.ws = null;
      this.stopBeat();
      try { ws.close(4000, 'No hello from the relay.'); } catch { /* already closed */ }
      this.lost(1006, opened);
    }, ASK_MS);
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      opened = true;
      this.startBeat();
    });
    ws.addEventListener('message', (ev) => { if (this.ws === ws) this.heard(ev.data); });
    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopBeat();
      this.lost(ev.code, opened);
    });
  }

  /** The socket closed. The relay's own codes say what to do; anything else is the network: back off and try again. */
  async lost(code, opened = false) {
    for (const [, a] of this.asks) { this.timers.clearTimeout(a.timer); a.resolve({ t: 'err', code: 'closed', text: 'Not sent: the team connection dropped.' }); }
    this.asks.clear();
    if (this.stopped) { this.setLink('stopped'); return; }
    if (code === 4001) { this.attempts = 0; this.setLink('off'); this.connect(); return; }
    if (code === 4002) return this.end('declined');
    if (code === 4003) return this.end('removed');
    if (code === 4004) return this.end('ended');
    // A socket that never opened shows no reason. After a few, ask the relay what it knows of this Mac.
    if (!opened && this.attempts >= 2) {
      // A stop() while the probe waits makes this loss stale: a start() after it owns the connection, and this one
      // schedules nothing over it (PR-Agent r9 on public #7).
      const attempt = this.attempt;
      // The probe has a deadline: a relay that takes the request and never answers must not leave this Mac without a
      // retry (PR-Agent r1 on public #7).
      let timer;
      const why = await Promise.race([this.probe(), new Promise((r) => { timer = this.timers.setTimeout(() => r(null), ASK_MS); })]);
      this.timers.clearTimeout(timer);
      if (attempt !== this.attempt) return;
      if (this.stopped) { this.setLink('stopped'); return; }
      if (why) return this.end(why);
    }
    this.schedule();
  }

  /** What the relay knows of this member, when the socket cannot say: a status to end on, or null to keep trying. */
  async probe() {
    try {
      const me = await this.member();
      const path = `/v1/teams/${this.state.team}/me`;
      const signedAt = this.now();
      const auth = await authToken(me, { team: this.state.team, method: 'GET', path, now: signedAt });
      const res = await this.net.http('GET', `${this.state.relay}${path}`, undefined, { authorization: `YesChef ${auth}` });
      if (res.status === 404) return 'ended';
      if (res.status === 401) {
        // A Mac clock far off fails every token: say so, and keep trying, rather than call the dev removed.
        // Measured against the time the token was signed with, not the clock now: a clock set right while the request
        // was out must not turn a skewed token into a removal (PR-Agent r4 on public #7).
        if (Number.isFinite(res.body?.now) && Math.abs(res.body.now - signedAt) > AUTH_SKEW_MS) { this.emit('clock', { off: res.body.now - signedAt }); return null; }
        // The clock moved while the request was out: try again with a fresh token before calling this Mac removed.
        if (Math.abs(this.now() - signedAt) > AUTH_SKEW_MS) return null;
        return this.state.status === 'pending' ? 'declined' : 'removed';
      }
    } catch { /* the network: keep trying */ }
    return null;
  }

  schedule() {
    if (this.stopped) return;
    // Full jitter on a doubling backoff, capped: many Macs that lost one relay do not come back at once.
    const ceil = Math.min(RETRY.cap, RETRY.base * 2 ** Math.min(this.attempts, 20));
    const ms = Math.max(RETRY.base / 2, Math.round(ceil * this.random()));
    this.attempts++;
    this.timers.clearTimeout(this.retry);
    this.setLink('waiting');
    this.retry = this.timers.setTimeout(() => { this.retry = null; this.setLink('off'); this.connect(); }, ms);
    this.retryMs = ms;
  }

  end(status) {
    this.state.status = status;
    if (status !== 'declined') this.state.key = null; // removed or ended: the team key goes with the team
    this.key = null;
    this.summaries.clear(); this.people.clear(); this.online.clear(); this.pending.clear(); this.invites.clear();
    this.save();
    this.stop();
    this.emit('status', { status });
  }

  /** Drop the socket and open a new one: the relay's hello brings the current team. */
  refresh() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null; this.stopBeat();
    try { ws.close(4000, 'Reading the team again.'); } catch { /* gone */ }
    this.lost(1006, true);
  }

  startBeat() {
    this.stopBeat();
    this.beat = this.timers.setInterval(() => this.ping(), PING_MS);
  }
  stopBeat() { this.timers.clearInterval(this.beat); this.beat = null; this.timers.clearTimeout(this.pongTimer); this.pongTimer = null; }
  ping() {
    // On the roster with no key: ask the lead again, at most once a day, so an ask that expired while the lead was away
    // is sent again without a reconnect (PR-Agent r11 on public #7).
    if (this.link === 'online' && this.state.status === 'member' && !this.state.key && !this.isLead) this.askKey().catch(() => {});
    if (!this.ws || this.pongTimer) return;
    try { this.ws.send('ping'); } catch { return; }
    // No pong in time: the socket is dead even if it never said so. Close it and let the retry owner take over.
    this.pongTimer = this.timers.setTimeout(() => { this.pongTimer = null; const ws = this.ws; if (ws) { this.ws = null; this.stopBeat(); try { ws.close(4000, 'No pong.'); } catch { /* gone */ } this.lost(1006, true); } }, PONG_MS);
  }

  /** A request over the socket; resolves with the relay's reply ({ t: 'ok' } or { t: 'err', code, text }). */
  say(msg) {
    return new Promise((resolve) => {
      if (!this.ws || this.link !== 'online') { resolve({ t: 'err', code: 'offline', text: 'Not sent: Yes Chef is not connected to the team.' }); return; }
      const id = newId();
      const timer = this.timers.setTimeout(() => { this.asks.delete(id); resolve({ t: 'err', code: 'timeout', text: 'The relay did not answer.' }); }, ASK_MS);
      this.asks.set(id, { resolve, timer });
      try { this.ws.send(JSON.stringify({ ...msg, id })); } catch { this.timers.clearTimeout(timer); this.asks.delete(id); resolve({ t: 'err', code: 'offline', text: 'Not sent: the team connection dropped.' }); }
    });
  }

  async heard(data) {
    if (data === 'pong') { this.timers.clearTimeout(this.pongTimer); this.pongTimer = null; return; }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.id && this.asks.has(msg.id)) {
      const a = this.asks.get(msg.id); this.asks.delete(msg.id); this.timers.clearTimeout(a.timer); a.resolve(msg); return;
    }
    // One message at a time, in order: a roster must land before the summaries and actions that follow it.
    this.chain = (this.chain || Promise.resolve()).then(() => this.handle(msg)).catch((ex) => this.emit('error', { text: String(ex?.message || ex) }));
    return this.chain;
  }

  async handle(msg) {
    switch (msg.t) {
      case 'hello': return this.hello(msg);
      case 'roster': return this.takeRoster(msg.roster);
      case 'summary': return this.takeSummary(msg.m, msg.blob, msg.at);
      // Their summary still waiting for the key goes too, so the welcome does not bring back what they unshared
      // (PR-Agent r11 on public #7).
      // Revisions are whole milliseconds: half past the withdrawn one turns that summary away and lets a newer one in
      // (PR-Agent r14 on public #7).
      case 'gone': this.summaries.delete(msg.m); if (this.summaryFloor.has(msg.m)) this.summaryFloor.set(msg.m, this.summaryFloor.get(msg.m) + 0.5); this.later = this.later.filter((x) => !(x.t === 'summary' && x.m === msg.m)); this.emit('team'); return;
      case 'presence': if (msg.on) this.online.add(msg.m); else this.online.delete(msg.m); this.emit('team'); return;
      case 'inbox': return this.take(msg);
      case 'pending': return this.takePending(msg.pending);
      case 'pending-gone': this.pending.delete(msg.m); this.emit('team'); return;
      case 'invite': return this.takeInvite(msg.invite);
      case 'invite-gone': this.invites.delete(msg.invite); this.emit('team'); return;
      case 'declined': return; // the close (4002) that follows ends it
      default: return;
    }
  }

  async hello(msg) {
    // Each await below can outlive its socket (stopped, or closed and replaced): then this hello goes no further, so a
    // stopped team never reads as online or takes its inbox (PR-Agent r1 on public #7).
    const ws = this.ws;
    const gone = () => this.stopped || this.ws !== ws;
    const me = await this.member();
    if (gone()) return;
    this.meId = me.id;
    if (msg.role === 'pending') { this.attempts = 0; this.setLink('online'); this.emit('team'); return; }
    const took = await this.takeRoster(msg.roster);
    if (took === 'removed' || gone()) return;
    if (!took) {
      // A roster the pinned lead did not sign, or an older one: this relay is not to be trusted with this team.
      this.emit('error', { text: 'The relay sent a team list the lead did not sign, or an older one. Yes Chef stopped talking to it.' });
      this.stop();
      return;
    }
    this.attempts = 0;
    this.online = new Set(msg.online || []);
    this.limits = { ...this.limits, ...(msg.limits || {}) };
    this.summaries.clear(); this.invites.clear(); this.pending.clear(); this.later = [];
    // Online before the waiting messages: taking one is a request to the relay.
    this.setLink('online');
    if (this.state.status === 'pending') { this.state.status = 'member'; this.save(); this.emit('status', { status: 'member' }); }
    // Waiting messages first: the welcome among them carries the team key the rest need.
    for (const item of msg.inbox || []) { if (gone()) return; await this.take(item); }
    for (const s of msg.summaries || []) { if (gone()) return; await this.takeSummary(s.m, s.blob, s.at); }
    for (const inv of msg.invites || []) { if (gone()) return; await this.takeInvite(inv); }
    for (const p of msg.pending || []) { if (gone()) return; await this.takePending(p); }
    if (gone()) return;
    this.emit('team');
    if (this.isLead) await this.sendWelcomes();
    // On the roster, but no welcome came: it waited its 7 days on the relay unread. Ask the lead for another.
    else if (!this.state.key) await this.askKey();
    if (gone()) return;
    this.flushFails = 0;
    // The relay kept our last summary; send only what changed while this Mac was away. A Viewer, or a dev who shares
    // nothing now, has it dropped.
    const held = (msg.summaries || []).some((s) => s.m === this.meId);
    if (held && (!shares(this.me?.role) || !this.state.shared?.length)) this.unshare();
    // A project dropped before a restart, its replacement never taken: the relay's copy still carries it. Rebuild it
    // from the board, or drop it until the board is read (PR-Agent r9 on public #7).
    else if (held && this.state.dropped && !this.next) this.shareNow(new Set([null]));
    else this.flush();
  }

  /** Check a roster against the lead this Mac pinned, then read its names and roles with the team key. The highest
   *  version taken is saved, so after a restart a relay cannot hand back an older roster that still lists a removed
   *  member or a role the lead took away (PR-Agent r1 on #79). A roster the lead signed without this Mac on it is a
   *  removal, whether or not the relay closes the socket: returns 'removed' (PR-Agent r2 on #79). */
  async takeRoster(roster) {
    const body = await readRoster(roster, { team: this.state.team, leadSignPub: this.state.leadSign });
    const floor = Math.max(this.roster?.ver || 0, Number(this.state.rosterVer) || 0);
    if (!body || body.ver < floor) return false;
    // One roster per version: a different roster signed at a version this Mac already took is refused, so a relay
    // that kept two cannot swap one for the other (PR-Agent r4 on public #7).
    const digest = await rosterDigest(roster.body);
    if (body.ver === (Number(this.state.rosterVer) || 0) && this.state.rosterHash && this.state.rosterHash !== digest) return false;
    if (body.ver > (Number(this.state.rosterVer) || 0) || !this.state.rosterHash) {
      this.state.rosterVer = body.ver;
      this.state.rosterHash = digest;
      // The floor is waited for. When it does not reach the disk this Mac still takes the newer roster (the older one
      // grants more), and the screens say the team is not saved (PR-Agent r4 on public #7).
      // Taking it even so is the safer way: the older roster is the one that grants more. A later save that gets
      // through writes this floor too, and the "Not saved" notice stays until one does.
      await this.saveNow();
      if (body.ver < (this.roster?.ver || 0)) return false;
    }
    const myId = this.meId || (await this.member()).id;
    if (!body.members.some((x) => x.id === myId)) { this.end('removed'); return 'removed'; }
    const sharedBefore = this.me ? shares(this.me.role) : null;
    const key = await this.teamKey();
    let detail = {};
    if (key) { try { detail = await open(key, body.detail, aad.detail(this.state.team, body.ver)); } catch { detail = {}; } }
    // The roster, its people and their grants change together, after the waits above, and never back to an older
    // version: an edit never reads a new version with the old grants (PR-Agent r3 on public #7).
    if (body.ver < (this.roster?.ver || 0)) return false;
    this.roster = body;
    this.rosterSigned = roster;
    // A roster this lead signed and kept for its answer leaves once one at or past its version is in place.
    if (this.state.unsent) { let u = null; try { u = JSON.parse(this.state.unsent.body).ver; } catch { u = null; } if (!(u > body.ver)) { delete this.state.unsent; this.save(); } }
    this.people = new Map(body.members.map((m) => {
      const d = detail[m.id] || {};
      const g = m.id === body.lead ? grant('lead') : grant(d.role, d.perms);
      return [m.id, { id: m.id, sign: m.sign, dh: m.dh, invite: !!m.invite || m.id === body.lead, name: clean(d.name, 60) || 'Not checked', ...g }];
    }));
    for (const id of [...this.summaries.keys()]) if (!this.people.has(id)) this.summaries.delete(id);
    for (const id of [...this.summaryFloor.keys()]) if (!this.people.has(id)) this.summaryFloor.delete(id);
    // Made a Viewer: nothing more goes out, and the relay's copy goes (PR-Agent r1 on #79).
    if (sharedBefore === true && !shares(this.me?.role)) this.unshare();
    this.emit('team');
    return true;
  }

  /** Keep an inbox item for when the key comes. It is not taken, so the relay keeps its copy and sends it again with
   *  the next hello: one copy per item, none past an action's age, and at most LATER_INBOX of them (PR-Agent r12 on
   *  public #7). */
  defer(msg) {
    const t = this.now();
    const inbox = this.later.filter((x) => x.t === 'inbox' && x.item !== msg.item && t - (Number(x.at) || 0) <= ACT_TTL);
    this.later = [...this.later.filter((x) => x.t !== 'inbox'), ...inbox.slice(-(LATER_INBOX - 1)), msg];
  }

  async takeSummary(m, blob, at) {
    const p = this.people.get(m);
    const key = await this.teamKey();
    if (!p || m === this.meId) return;
    // The welcome can land after the hello that carried the summaries: keep them until the key comes.
    // One per teammate, the latest: a Mac that waits long for its key does not keep every update (PR-Agent r10 on
    // public #7).
    if (!key) { this.later = this.later.filter((x) => !(x.t === 'summary' && x.m === m)); this.later.push({ t: 'summary', m, blob, at }); return; }
    try {
      const body = await openSigned(key, blob, aad.summary(this.state.team, m), p.sign);
      // The time shown is the one the dev's Mac signed, not the relay's: a relay that replays an old summary cannot
      // make it look new, and an older one never replaces a newer one (PR-Agent r1 on #79).
      const signed = Number(body?.at), rev = Number(body?.rev);
      if (!Number.isFinite(signed) || !Number.isFinite(rev)) { this.summaries.delete(m); this.emit('team'); return; }
      // A teammate's clock far ahead would set a floor no right-dated summary passes: not taken (PR-Agent r10 on
      // public #7).
      if (signed - this.now() > AUTH_SKEW_MS) return;
      // The floor outlives the shown summary: a reconnect clears what is shown, never the newest revision taken, so a
      // relay cannot hand back an older summary after it (PR-Agent r1 on public #7). The revision, not the time: a
      // teammate whose clock went back still gets through (PR-Agent r13 on public #7).
      if (rev < (this.summaryFloor.get(m) || 0)) return;
      this.summaryFloor.set(m, rev);
      this.summaries.set(m, { at: Math.min(signed, this.now()), body });
    } catch { this.summaries.delete(m); }
    this.emit('team');
  }

  async takeInvite(inv) {
    const key = await this.teamKey();
    if (!isId(inv?.id)) return;
    if (!key) { this.later.push({ t: 'invite', invite: inv }); return; }
    try {
      const { secret } = await open(key, inv.box, aad.invite(this.state.team, inv.id));
      this.invites.set(inv.id, { id: inv.id, until: inv.until, by: inv.by, secret });
    } catch { /* not sealed with our key: not shown */ }
    this.emit('team');
  }

  async takePending(p) {
    const inv = this.invites.get(p?.invite);
    if (!inv) { if (!this.state.key) this.later.push({ t: 'pending', pending: p }); return; }
    try {
      const ask = await openJoin(inv.secret, { team: this.state.team, ...p });
      this.pending.set(p.m, { m: p.m, invite: p.invite, at: p.at, sign: p.sign, dh: p.dh, name: clean(ask.name, 60) || 'No name', projects: (ask.projects || []).map((x) => clean(x, 80)).slice(0, 50) });
    } catch { /* an ask that does not open or is not signed by its key: not shown */ }
    this.emit('team');
  }

  // ---- messages between members ----
  async done(item) { await this.say({ t: 'done', item }); }

  async take({ item, from, blob, at }) {
    const sender = this.people.get(from);
    const me = await this.member();
    let ack = true;
    try {
      if (!sender) return;
      if (!this.state.key) {
        // Before the team key, the only message to take is the lead's welcome. Anything else (a teammate's action that
        // came first) waits here, not taken, and runs once the welcome brings the key (PR-Agent r1 on #79).
        let w = null;
        if (from === this.roster?.lead) { try { w = await openFrom(me, sender.dh, blob, aad.welcome(this.state.team, from, me.id)); } catch { w = null; } }
        if (typeof w?.teamKey !== 'string') { ack = false; this.defer({ t: 'inbox', item, from, blob, at }); return; }
        // Removed, declined or stopped while the welcome was opened: the key is not kept (PR-Agent r5 on public #7).
        if (this.stopped || (this.state.status !== 'member' && this.state.status !== 'pending')) { ack = false; return; }
        this.state.key = w.teamKey; this.key = null;
        if (w.teamName) this.state.teamName = clean(w.teamName, 80);
        this.save();
        if (this.rosterSigned) await this.takeRoster(this.rosterSigned);
        const later = this.later; this.later = [];
        for (const msg of later) await this.handle(msg);
        this.emit('welcome');
        this.flush();
        return;
      }
      const key = await this.teamKey();
      let body;
      try { body = await openSigned(key, blob, aad.send(this.state.team, from, me.id), sender.sign); }
      catch { if (this.isLead) await this.takeKeyAsk(sender, blob); return; }
      // The team may have changed while the blob was opened: this Mac removed or stopped, or the sender removed or
      // given another role. Only the roster as it is now counts (PR-Agent r2 on public #7).
      if (this.stopped || this.state.status !== 'member') { ack = false; return; }
      const now = this.people.get(from);
      if (!now) return;
      // The action stays on the relay until its answer is queued: a lost answer comes again from the seen ids, and
      // nothing runs twice (PR-Agent r3 on public #7).
      if (body?.k === 'act') { if (!(await this.intake(now, body))) ack = false; }
      else if (body?.k === 'result') {
        const result = { status: Number(body.status) || 500, text: clean(body.text, 300) };
        const o = this.out.get(body.re);
        if (o && o.to === from) { this.out.delete(body.re); this.timers.clearTimeout(o.timer); o.resolve(result); }
        // A late answer still reaches the screen: the action ran when their Mac came online.
        this.emit('result', { from, name: sender.name, re: body.re, ...result });
      }
    } finally {
      if (ack && typeof item === 'string') await this.done(item);
    }
  }

  async reply(to, re, status, text) {
    const p = this.people.get(to);
    if (!p) return true; // nobody left to tell
    const me = await this.member();
    const blob = await sealSigned(await this.teamKey(), me, { k: 'result', re, status, text, at: this.now() }, aad.send(this.state.team, me.id, to));
    return (await this.say({ t: 'send', to, blob, ttl: ACT_TTL })).t === 'ok';
  }

  /** A teammate's action on this dev's threads. Every check here holds before anything reaches T3. */
  async intake(sender, body) {
    const nonce = String(body.nonce || '');
    if (!isId(nonce)) return true;
    const seenKey = `${sender.id}:${nonce}`;
    const now = this.now();
    // Seen ones get their first answer again; nothing runs twice.
    const had = this.seen.get(seenKey);
    if (had) return this.reply(sender.id, nonce, had.status, had.text);
    // An id leaves only once its action is too old to run anyway. A full list of live ids refuses new work rather than
    // forget one, so a replay never runs twice (PR-Agent r1 on public #7). The refusal is not kept: nothing ran.
    // Against the latest time this Mac has seen, so a clock set forward and back again cannot drop an id and then take
    // its action again (PR-Agent r5 on public #7).
    const high = Math.max(now, Number(this.state.clockHigh) || 0);
    this.state.clockHigh = high;
    for (const [k, v] of this.seen) { if (high - v.at < SEEN_KEEP_MS) break; this.seen.delete(k); }
    if (this.seen.size >= SEEN_MAX) return this.reply(sender.id, nonce, 429, 'Not run: too many teammate actions in the last few minutes. Try again shortly.');
    const answer = async (status, text) => {
      this.seen.set(seenKey, { at: now, status, text });
      this.save();
      this.emit('acted', { from: sender.id, name: sender.name, kind: body.action?.kind, thread: body.action?.thread, status, text });
      return this.reply(sender.id, nonce, status, text);
    };
    const action = body.action || {};
    const kind = String(action.kind || '');
    const thread = String(action.thread || '');
    // Every check, from what this Mac holds at time t. It runs again after the save below: a project dropped, a role
    // taken away or a board gone stale while the id was saved stops the action (PR-Agent r4 on public #7).
    const gate = (t) => {
      const at = Number(body.at);
      if (!Number.isFinite(at) || t - at > ACT_TTL || at - t > AUTH_SKEW_MS) return [409, 'Not run: that action is too old. Look again and send it fresh.'];
      if (high - at > ACT_TTL) return [409, 'Not run: this teammate\'s Mac clock went back. Send it again once their clock is right.'];
      if (this.stopped || this.state.status !== 'member') return [409, 'Not run: this Mac is no longer on the team.'];
      const from = this.people.get(sender.id);
      if (!from) return [403, 'Not run: the sender is no longer on the team.'];
      if (!allows(from, kind)) return [403, refusal(from, kind)];
      if (!this.me || !shares(this.me.role)) return [409, 'Not run: this teammate shares no tickets.'];
      if (!this.run || !this.boardOf) return [409, 'Not checked: this teammate\'s Yes Chef cannot act yet.'];
      const b = this.boardOf();
      // A board read "later" than now means the clock went back: its age is unknown, so it is not fresh (PR-Agent r7 on
      // public #7).
      if (!b?.ok || !b.board || !(b.at <= t) || t - b.at > BOARD_FRESH_MS) return [409, 'Not checked: this teammate\'s board is not fresh. Try again in a minute.'];
      // The thread must sit in a project this dev shares. A thread id from anywhere else is refused, whoever sends it.
      const ticket = b.board.tickets.find((k) => k.thread.threadId === thread || k.asks.some((a) => a.thread.threadId === thread));
      if (!ticket || !new Set(this.state.shared || []).has(ticket.thread.projectId)) return [409, 'Not run: that ticket is not on this teammate\'s shared board.'];
      return null;
    };
    const no = gate(now);
    if (no) return answer(...no);
    // The id is saved before T3 hears the action: if this Mac stops mid-run, the relay's copy that comes back gets
    // "not confirmed", never a second run (PR-Agent r2 on public #7).
    this.seen.set(seenKey, { at: now, status: 502, text: 'Not confirmed: this teammate\'s Yes Chef stopped while it ran the action. Check the thread before you send again.' });
    // The reservation must be on disk first. If it is not, nothing runs (PR-Agent r3 on public #7).
    if (!(await this.saveNow())) { this.seen.delete(seenKey); return this.reply(sender.id, nonce, 503, 'Not run: this teammate\'s Yes Chef could not save. Try again shortly.'); }
    const late = gate(this.now());
    if (late) return answer(...late);
    const from = this.people.get(sender.id);
    let out;
    try {
      // The nonce T3 sees names the sender too, so one teammate's ids never collide with another's or with the dev's.
      out = await this.run({ ...action, kind, thread, nonce: `t-${sender.id}-${nonce}` }, signature(from), { holds: this.holds, answered: this.answered });
    } catch (ex) { return answer(502, `Not checked: T3 did not take it (${clean(ex?.message || ex, 120)}). Check the thread.`); }
    return answer(out?.status || 500, clean(out?.text || 'No answer.', 300));
  }

  /** Send an action to a teammate's Yes Chef. Resolves with their answer: { status, text }. */
  async act(to, action) {
    const p = this.people.get(to);
    if (!p || to === this.meId) return { status: 400, text: 'That person is not on the team.' };
    if (!allows(this.me, action?.kind)) return { status: 403, text: refusal(this.me, action?.kind) };
    const me = await this.member();
    const nonce = newId();
    const body = { k: 'act', nonce, at: this.now(), action: { ...action } };
    const blob = await sealSigned(await this.teamKey(), me, body, aad.send(this.state.team, me.id, to));
    if (blob.length > this.limits.sendMax) return { status: 400, text: 'That note is too long to send.' };
    let got = null;
    const result = new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => {
        const unsure = this.out.get(nonce)?.unsure;
        this.out.delete(nonce);
        resolve(unsure
          ? { status: 504, text: 'Not confirmed: the relay may have taken it. Do not send it again: if it was taken, their Yes Chef runs it when it comes online, within 15 minutes.' }
          : { status: 504, text: 'Not checked: no answer from their Yes Chef yet. It runs the action when it comes online, within 15 minutes.' });
      }, ASK_MS * 2);
      this.out.set(nonce, { to, resolve: (r) => { got = r; resolve(r); }, timer });
    });
    const sent = await this.say({ t: 'send', to, blob, ttl: ACT_TTL });
    // Their answer can beat the relay's own: a known result wins over a missing ack (PR-Agent r2 on public #7).
    if (sent.t !== 'ok' && got) return got;
    // Sent, then the connection dropped or the relay's answer did not come: the relay may hold it, and it can still
    // run. Wait for their answer as for a taken send, and never say "Not sent" (PR-Agent r14 on public #7).
    if (sent.code === 'timeout' || sent.code === 'closed') { const o = this.out.get(nonce); if (o) o.unsure = true; return result; }
    if (sent.t !== 'ok') { const o = this.out.get(nonce); this.timers.clearTimeout(o?.timer); this.out.delete(nonce); return { status: 503, text: sent.text }; }
    return result;
  }

  // ---- this dev's summary ----
  /** The Pass read a new board. Sends this dev's summary of the shared projects, coalesced: at most one per the relay's
   *  limit, always the newest, and only when it changed. */
  board(board) {
    this.lastBoard = board;
    // The board was read just now: the summary carries this time, not the time it is sealed, so a summary held through
    // an outage never shows as live (PR-Agent r10 on public #7).
    this.lastBoardAt = this.now();
    if (this.state.status !== 'member' || !shares(this.me?.role) || !this.state.shared?.length) return;
    const body = summarize(board, this.state.shared, this.limits.summaryMax);
    const json = JSON.stringify(body);
    if (!this.flushing && json === this.sentJson && !this.state.dropped) { this.next = null; return; }
    this.next = { json, body, at: this.lastBoardAt, drop: this.state.dropped };
    this.flush();
  }

  async flush() {
    if (!this.next || this.link !== 'online' || this.summaryTimer || this.flushing || !this.state.key) return;
    // Checked again at send time: a dev made a Viewer, or sharing nothing, sends no summary, whatever was queued
    // before (PR-Agent r1 on #79).
    if (!this.next.forget && (!shares(this.me?.role) || !this.state.shared?.length)) { this.next = null; return; }
    // A summary and a forget share the relay's one limit per member. The clock went back since the send time was set:
    // the wait moves back by the jump, so it keeps its length and never waits the whole jump (PR-Agent r10 on
    // public #7).
    const jump = (this.setAt ?? -Infinity) - this.now();
    if (jump > 0) { this.sentAt -= jump; this.setAt = this.now(); }
    const wait = this.sentAt + this.limits.summaryMs - this.now();
    if (wait > 0) { this.summaryTimer = this.timers.setTimeout(() => { this.summaryTimer = null; this.flush(); }, wait); return; }
    const next = this.next;
    if (!next.forget && next.json === this.sentJson && !this.state.dropped) { this.next = null; return; }
    this.flushing = true;
    try {
      let blob = null;
      if (!next.forget) {
        try { blob = next.blob || (next.blob = await this.sealSummary(next.body, next.at)); } catch (ex) {
          // A key or member that does not load fails the same way every time: wait as for a failed send, so the
          // re-flush below does not spin (own review on the public PR).
          this.flushFails = (this.flushFails || 0) + 1;
          this.sentAt = this.now() - this.limits.summaryMs + Math.min(RETRY.cap, this.limits.summaryMs * 2 ** Math.min(this.flushFails, 10)); this.setAt = this.now();
          this.emit('error', { text: `Yes Chef could not seal this Mac's summary: ${clean(String(ex?.message || ex), 200)}` });
          return;
        }
        // Sealing waits on WebCrypto. A project dropped, or a Viewer made, while it ran replaced this summary or ended
        // sharing: it goes nowhere, and the newer one or the check above decides what does (PR-Agent r2 on #79).
        if (this.next !== next || !shares(this.me?.role) || !this.state.shared?.length) return;
      }
      const r = next.forget ? await this.say({ t: 'forget' }) : await this.say({ t: 'summary', blob });
      if (r.t === 'ok') {
        this.sentJson = next.forget ? null : next.json; this.sentAt = this.now(); this.setAt = this.now(); this.flushFails = 0;
        if (this.state.dropped && next.drop === this.state.dropped) { delete this.state.dropped; this.save(); }
        if (this.next === next) this.next = null;
      } else if (r.code === 'slow') {
        this.sentAt = this.now() - this.limits.summaryMs + (Number(r.retryAfter) || this.limits.summaryMs); this.setAt = this.now();
      } else if (r.code === 'bad') {
        // The relay will never take this one: drop it and say so, rather than send it again (PR-Agent r1 on #79).
        if (this.next === next) this.next = null;
        this.emit('error', { text: `The relay refused this Mac's summary: ${clean(r.text, 200)}` });
      } else {
        // Offline, a timeout, the cap: try again later, waiting longer each time, up to five minutes. The relay may have
        // taken it, so what it holds is not known: the next summary goes even if it matches the last one taken
        // (PR-Agent r8 on public #7).
        this.sentJson = null;
        this.flushFails = (this.flushFails || 0) + 1;
        this.sentAt = this.now() - this.limits.summaryMs + Math.min(RETRY.cap, this.limits.summaryMs * 2 ** Math.min(this.flushFails, 10)); this.setAt = this.now();
      }
    } finally {
      this.flushing = false;
      if (this.next) this.flush();
    }
  }

  /** Seal a summary, and halve its tickets until the sealed blob fits the relay's limit: names in any script are
   *  measured as the bytes they seal to (PR-Agent r1 on #79). */
  async sealSummary(body, at = this.now()) {
    const me = await this.member();
    const key = await this.teamKey();
    const now = this.now();
    const read = Math.min(Number.isFinite(at) ? at : now, now);
    // The order is a revision, apart from the time shown: kept on disk and only going up, even when the clock goes
    // back, so a replacement built from the same board (a dropped project) is always newer and the relay cannot hand
    // back the one it replaced (PR-Agent r11 and r13 on public #7).
    const rev = Math.max(now, (Number(this.state.summaryRev) || 0) + 1);
    this.state.summaryRev = rev;
    // On disk before any summary carries it: a restart never reuses a revision teammates already took. Not saved,
    // nothing goes (PR-Agent r14 on public #7).
    if (!(await this.saveNow())) throw new Error('This Mac could not save the summary\'s revision, so it did not send it.');
    for (let b = body; ; ) {
      const blob = await sealSigned(key, me, { ...b, at: read, rev }, aad.summary(this.state.team, me.id));
      if (blob.length <= this.limits.summaryMax || !b.tickets.length) return blob;
      const n = Math.floor(b.tickets.length / 2);
      b = { ...b, tickets: b.tickets.slice(0, n), more: (b.more || 0) + b.tickets.length - n };
    }
  }

  /** Nothing more goes out, and the relay's copy goes. */
  unshare() { this.next = { forget: true, drop: this.state.dropped }; this.flush(); }

  /** The dev changed which projects they share. Sharing nothing drops the relay's copy. Dropping a project rebuilds the
   *  waiting summary from the last board at once, so a summary queued before the change never carries that project's
   *  tickets, and the relay's copy is replaced within the limit (PR-Agent r1 on #79). */
  /** Resolves false when the new list did not reach the disk. It is in use here all the same (PR-Agent r5 on public #7). */
  async share(projectIds) {
    const before = new Set(this.state.shared || []);
    this.state.shared = [...new Set(projectIds.map(String))];
    // A project dropped is kept on disk as owed until the relay takes a summary or forget built after it: a restart
    // before then still replaces the relay's copy (PR-Agent r9 on public #7).
    if ([...before].some((id) => !this.state.shared.includes(id))) this.state.dropped = (Number(this.state.dropped) || 0) + 1;
    // The waiting summary follows the new list first, so nothing from a dropped project goes out while it saves
    // (PR-Agent r6 on public #7).
    this.shareNow(before);
    return this.saveNow();
  }
  shareNow(before) {
    if (!this.state.shared.length) { this.unshare(); return; }
    if (![...before].some((id) => !this.state.shared.includes(id))) return; // only added: the next board sends them
    if (this.lastBoard && shares(this.me?.role)) {
      const body = summarize(this.lastBoard, this.state.shared, this.limits.summaryMax);
      this.next = { json: JSON.stringify(body), body, at: this.lastBoardAt, drop: this.state.dropped };
      this.flush();
    } else this.unshare();
  }

  // ---- the lead's and inviters' part ----
  async invite({ site, now = this.now() } = {}) {
    if (!this.people.get(this.meId)?.invite) return { error: 'Your role cannot invite people.' };
    const inv = await newInvite({ site, relay: this.state.relay, team: this.state.team, lead: { signPub: this.state.leadSign }, leadName: this.people.get(this.roster.lead)?.name || '', teamName: this.state.teamName, now });
    const box = await seal(await this.teamKey(), { secret: inv.secret }, aad.invite(this.state.team, inv.record.invite));
    const r = await this.say({ t: 'invite', invite: inv.record.invite, verifier: inv.record.verifier, until: inv.record.until, box });
    if (r.t !== 'ok') return { error: r.text };
    this.invites.set(inv.record.invite, { id: inv.record.invite, until: inv.record.until, by: this.meId, secret: inv.secret });
    this.emit('team');
    return { link: inv.link, until: inv.record.until, id: inv.record.invite };
  }

  async revoke(id) { const r = await this.say({ t: 'revoke', invite: id }); if (r.t === 'ok') { this.invites.delete(id); this.emit('team'); } return r; }
  async decline(m) { const r = await this.say({ t: 'decline', m }); if (r.t === 'ok') { this.pending.delete(m); this.emit('team'); } return r; }

  /** A new roster from the lead: people is the full list as Map id -> { sign, dh, name, role, perms }. */
  async pushRoster(people) {
    // One edit at a time, so two edits never sign two rosters with one version (PR-Agent r4 on public #7).
    const next = this.rosterLock.then(() => this.pushRosterNow(people));
    this.rosterLock = next.catch(() => {});
    return next;
  }
  async pushRosterNow(people) {
    if (!this.isLead) return { t: 'err', code: 'role', text: 'Only the lead can change the team.' };
    const stale = { t: 'err', code: 'stale', text: 'The team changed while you edited it. Look again and try once more.' };
    // A roster this Mac signed and the relay never confirmed goes again first: the lead never signs a second, different
    // roster with that version.
    const held = this.state.unsent;
    if (held) {
      const hb = await readRoster(held, { team: this.state.team, leadSignPub: this.state.leadSign });
      // It leaves only once a roster at or past its version is in place here. Until then no new roster is signed, so
      // the relay never holds two at one version (PR-Agent r5 on public #7).
      if (!hb || hb.ver <= (this.roster?.ver || 0)) { delete this.state.unsent; await this.saveNow(); }
      else {
        const r0 = await this.say({ t: 'roster', roster: held });
        // takeRoster saves the new floor first, then lets the kept copy go (PR-Agent r6 on public #7).
        if (r0.t === 'ok') { await this.takeRoster(held); return stale; }
        // The relay is past this Mac's roster: read the team again (the next hello brings it). Nothing is signed till then.
        if (r0.code === 'stale') { this.refresh(); return stale; }
        return r0;
      }
    }
    const me = await this.member();
    const ver = this.roster.ver + 1;
    const detail = {};
    const members = [];
    for (const [id, p] of people) {
      const g = id === me.id ? grant('lead') : grant(p.role, p.perms);
      detail[id] = { name: clean(p.name, 60), ...g };
      members.push({ id, sign: p.sign, dh: p.dh, ...(g.perms.includes('invite') ? { invite: true } : {}) });
    }
    if ((people.ver !== undefined && people.ver !== this.roster.ver) || ver !== this.roster.ver + 1) return stale;
    const roster = await signRoster(me, { team: this.state.team, ver, lead: me.id, at: this.now(), members, detail: await seal(await this.teamKey(), detail, aad.detail(this.state.team, ver)) });
    // Kept until the relay answers, so a lost answer sends this same roster again, never a new one.
    this.state.unsent = roster;
    if (!(await this.saveNow())) { delete this.state.unsent; return { t: 'err', code: 'save', text: 'Not changed: Yes Chef could not save. Try again shortly.' }; }
    const r = await this.say({ t: 'roster', roster });
    if (r.t === 'ok') await this.takeRoster(roster);
    // Refused or unanswered, it is kept: it leaves once a roster at or past its version is in place here.
    else if (r.code === 'stale') this.refresh();
    return r;
  }

  /** The people as this Mac has them now, marked with the roster version they came from: pushRoster refuses a list
   *  read from an older version, so two edits that cross never undo each other (PR-Agent r3 on public #7). */
  current() { const out = this._current(); out.ver = this.roster?.ver; return out; }
  _current() { return new Map([...this.people].map(([id, p]) => [id, { sign: p.sign, dh: p.dh, name: p.name, role: p.role, perms: p.perms }])); }

  /** Approve an ask: the dev joins the roster with a role, then gets the team key sealed to their own key. */
  async approve(m, role = 'engineer', perms) {
    const ask = this.pending.get(m);
    if (!ask) return { t: 'err', code: 'gone', text: 'That ask is no longer waiting.' };
    const people = this.current();
    people.set(m, { sign: ask.sign, dh: ask.dh, name: ask.name, ...grant(role, perms) });
    // The welcome is owed from before the roster goes: if the relay takes the roster but its answer is lost, the next
    // connect finds the dev on the roster and sends it then. sendWelcomes() drops one whose dev never made the roster,
    // so a refused roster owes nothing (PR-Agent r1 on #79).
    this.state.welcomes = [...new Set([...(this.state.welcomes || []), m])];
    this.save();
    const r = await this.pushRoster(people);
    if (r.t !== 'ok') return r;
    this.pending.delete(m);
    const left = await this.sendWelcomes();
    this.emit('team');
    return left.includes(m) ? { t: 'ok', ver: r.ver, welcome: 'later' } : { t: 'ok', ver: r.ver };
  }

  /** Send each welcome still owed. Returns the members still waiting for one. */
  async sendWelcomes() {
    const me = await this.member();
    const left = [];
    for (const m of this.state.welcomes || []) {
      const p = this.people.get(m);
      if (!p) continue; // removed since: nothing owed
      const blob = await sealTo(me, p.dh, { teamKey: this.state.key, teamName: this.state.teamName }, aad.welcome(this.state.team, me.id, m));
      if ((await this.say({ t: 'send', to: m, blob, ttl: 7 * 86400000 })).t !== 'ok') left.push(m);
    }
    if (left.length !== (this.state.welcomes || []).length) { this.state.welcomes = left; this.save(); }
    return left;
  }

  /** On the roster without the team key: the welcome waited its 7 days on the relay unread. Ask the lead for another,
   *  sealed to the lead's key, at most once a day (PR-Agent r2 on #79). */
  async askKey() {
    const lead = this.people.get(this.roster?.lead);
    const at = this.now();
    if (!lead || lead.id === this.meId || at - (Number(this.state.keyAskAt) || 0) < KEY_ASK_MS) return;
    const me = await this.member();
    const blob = await sealTo(me, lead.dh, { k: 'key', at }, aad.rekey(this.state.team, me.id, lead.id));
    if ((await this.say({ t: 'send', to: lead.id, blob, ttl: 7 * 86400000 })).t === 'ok') { this.state.keyAskAt = at; this.save(); }
  }

  /** The lead reads a member's ask for the key. Only that member can open the welcome it gets, so a forged ask gains
   *  nothing; it still must come from a key on the lead's roster. */
  async takeKeyAsk(sender, blob) {
    const me = await this.member();
    let ask = null;
    try { ask = await openFrom(me, sender.dh, blob, aad.rekey(this.state.team, sender.id, me.id)); } catch { return; }
    if (ask?.k !== 'key') return;
    this.state.welcomes = [...new Set([...(this.state.welcomes || []), sender.id])];
    this.save();
    await this.sendWelcomes();
  }

  async setRole(m, role, perms) {
    const people = this.current();
    if (!people.has(m) || m === this.meId) return { t: 'err', code: 'bad', text: 'That person is not on the team.' };
    people.set(m, { ...people.get(m), ...grant(role, perms) });
    return this.pushRoster(people);
  }

  async remove(m) {
    const people = this.current();
    if (!people.has(m) || m === this.meId) return { t: 'err', code: 'bad', text: 'That person is not on the team.' };
    people.delete(m);
    return this.pushRoster(people);
  }
}

/** This dev's summary for the team: the tickets in the projects they share, newest first, the ones waiting on a person
 *  first. Only what a teammate's board needs: no messages, no code. It fits the relay's limit with room for the seal. */
export function summarize(board, shared, max = 65536) {
  const keep = new Set(shared || []);
  const tickets = (board?.tickets || [])
    .filter((k) => keep.has(k.thread.projectId) && k.place !== 'Coordinators')
    .sort((a, b) => (b.atPass - a.atPass) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .map((k) => ({
      thread: k.thread.threadId, title: clean(k.thread.title, 160), project: clean(k.project, 80), place: k.place,
      atPass: !!k.atPass, working: k.working || 0, asks: k.asks.length, call: !!k.call,
      prs: k.prs.slice(0, 5).map((p) => ({ repo: clean(p.repository, 100), n: p.number, state: p.state, url: typeof p.url === 'string' && /^https:\/\//.test(p.url) ? p.url.slice(0, 300) : null })),
      updatedAt: k.updatedAt || null,
    }));
  let n = Math.min(tickets.length, SUMMARY_TICKETS);
  // A sealed summary is about 4/3 of its JSON's UTF-8 bytes plus the signature. Halve the list until it fits. Sealing
  // checks the real size again (sealSummary).
  const bytes = (x) => new TextEncoder().encode(JSON.stringify(x)).length;
  while (n > 0 && (bytes(tickets.slice(0, n)) * 4) / 3 + 600 > max) n = Math.floor(n / 2);
  return { v: 1, tickets: tickets.slice(0, n), more: tickets.length - n };
}
