// The team client: one dev's Yes Chef on the relay (docs/team-relay-v0_1.md, "The app"). It keeps the socket, sends
// this dev's sealed summary when it changes, reads the team's, and runs a teammate's action on this dev's own threads
// only after it checks the sender, the sender's role, the action's age and its id. It never acts through anything but
// the dev's own capped T3 sign-in, which the caller passes in as `run`.
//
// One Team, four parts behind it: the connection (team-connection.mjs), the roster (team-roster.mjs), the inbox
// (team-inbox.mjs) and the summaries (team-summaries.mjs). This file holds the state they share, the store, and what
// the screens read.
import { newId, isId, newMember, saveMember, loadMember, signRoster, newTeamKey, teamKey, seal, aad, readInvite, joinRequest, matchCode } from './seal.ts';
import { grant } from './roles.mjs';
import { clean, ASK_MS, ACT_TTL } from './team-common.mjs';
import { connection, RETRY, PING_MS, PONG_MS } from './team-connection.mjs';
import { roster, KEY_ASK_MS, chartUnder, readUnderForTest } from './team-roster.mjs';
import { inbox, BOARD_FRESH_MS } from './team-inbox.mjs';
import { summaries, summarize, identity, notCheckedSince } from './team-summaries.mjs';

export { chartUnder, readUnderForTest };
export { RETRY, PING_MS, PONG_MS, ASK_MS, ACT_TTL, BOARD_FRESH_MS, KEY_ASK_MS, summarize, identity, notCheckedSince };
const STATE_V = 1;

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

/** Make a team: this Mac's keys, the team key, roster 1 with this dev as lead. Returns the state to save (it holds
 *  private keys and the team key: the app seals it before it touches a disk). */
export async function createTeam({ relay, teamName, name, net = webNet, now = Date.now }) {
  const me = await newMember();
  const team = newId();
  const raw = newTeamKey();
  const key = await teamKey(raw);
  const people = { [me.id]: { name: clean(name, 60), ...grant('lead') } };
  const detail = await seal(key, { people, areas: [] }, aad.detail(team, 1));
  const signed = await signRoster(me, { team, ver: 1, lead: me.id, at: now(), members: [{ id: me.id, sign: me.signPub, dh: me.dhPub, invite: true }], detail });
  const res = await net.http('POST', `${relay}/v1/teams/${team}`, { roster: signed });
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
  // The six digits the lead sees beside this ask (Dan's 2a). Worked out once here: the invite's secret is not kept.
  const code = await matchCode({ team: inv.team, invite: inv.invite, secret: inv.secret, sign: me.signPub, dh: me.dhPub });
  return { v: STATE_V, relay: inv.relay, team: inv.team, teamName: inv.teamName, leadName: inv.leadName, leadSign: inv.leadSignPub,
    me: await saveMember(me), name: ask.name, key: null, status: 'pending', shared: [...shared], seen: [], rosterVer: 0, code,
    projects: ask.projects };
}

/** The live team. state: from createTeam or joinTeam. save(state): called whenever it changes.
 *  run(input, prefix): runs an action on this dev's own board through their T3 sign-in (client/actions.ts act()).
 *  board(): { board, ok, at }: this dev's board as the Pass last read it. */
export class Team {
  constructor({ state, save = () => {}, net = webNet, now = Date.now, timers = globalThis, random = Math.random, run = null, board = null }) {
    if (!state || state.v !== STATE_V || !isId(state.team)) throw new Error('Not a saved team.');
    Object.assign(this, { state, saveFn: save, net, now, timers, random, run, boardOf: board });
    // The connection
    this.link = 'off';           // the socket: off, connecting, online, waiting (a retry is set), stopped
    this.linkAt = now();
    this.lostAt = null;          // when this Mac last left online
    this.attempts = 0;
    this.retry = null;           // the one retry timer
    this.ws = null;
    this.asks = new Map();       // request id -> { resolve, timer }
    this.limits = { summaryMs: 10000, summaryMax: 65536, sendMax: 16384 };
    // The store
    this.writes = Promise.resolve();     // the store's writes, one at a time
    this.unsaved = false;        // the last save did not reach the disk: the screens say so
    this.listeners = new Set();
    // The roster
    this.rosterLock = Promise.resolve(); // the lead's roster edits, one at a time
    this.roster = null;          // the verified roster body
    this.people = new Map();     // id -> { id, sign, dh, invite, name, role, perms, area, under }
    this.areas = [];             // [{ id, name }] from the roster the lead signed: names only until Rules gives them projects
    this.pending = new Map();    // asks to join, for inviters: m -> { m, invite, at, name, projects }
    this.invites = new Map();    // id -> { id, until, by, secret }
    this.key = null;
    this.later = [];             // messages that need the team key, kept until the welcome brings it
    // The inbox
    this.out = new Map();        // action nonce -> { resolve, timer }
    this.holds = new Map();
    this.answered = new Map();
    this.seen = new Map(state.seen || []);
    // The summaries
    this.summaries = new Map();  // id -> { body } (opened)
    this.summaryFloor = new Map(); // id -> the newest summary revision taken, kept across reconnects
    this.online = new Set();
    this.lastSeen = new Map();   // id -> when the relay last saw them, on the relay's clock
    this.healthOk = null;        // this Mac's last board read: true, false, or not read yet
    this.healthSince = null;
    this.next = null;            // the newest summary not yet sent: { id, body } or { forget }
    this.sentId = null;          // the identity of the last summary the relay took
    this.sentAt = 0;
    this.summaryTimer = null;
  }

  // ---- state and events ----
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data = {}) { for (const fn of [...this.listeners]) { try { fn({ type, ...data }); } catch { /* a listener's fault is its own */ } } }
  /** Queue one write of the state as it is now. Writes go one at a time, in order, each a copy taken when it was
   *  queued: an older write never lands after a newer one. Resolves true once written. */
  write() {
    this.state.seen = [...this.seen];
    let snap;
    try { snap = structuredClone(this.state); } catch { snap = JSON.parse(JSON.stringify(this.state)); }
    const done = this.writes.then(() => this.saveFn(snap)).then(() => true, () => false);
    this.writes = done;
    // A store that answers later (the desktop app's Keychain) reports here too: a failed write shows as unsaved, never as
    // an unhandled rejection.
    return done.then((ok) => { this.saved(ok); return ok; });
  }
  save() { this.write(); return true; }
  /** The last save's outcome. The screens say "Not saved" until a later save gets through. */
  saved(ok) { const was = this.unsaved; this.unsaved = !ok; if (was !== this.unsaved) this.emit('team'); }
  /** Save and wait until the store says it is written. False when it failed: whatever needed it does not go ahead. */
  saveNow() { return this.write(); }
  setLink(link) {
    if (this.link === link) return;
    if (this.link === 'online') this.lostAt = this.now();
    this.link = link; this.linkAt = this.now();
    this.emit('link', { link });
  }
  async member() { return this.meCache || (this.meCache = await loadMember(this.state.me)); }
  async teamKey() { if (!this.key && this.state.key) this.key = await teamKey(this.state.key); return this.key; }
  get me() { return this.people.get(this.meId) || null; }
  get isLead() { return !!this.roster && this.roster.lead === this.meId; }

  /** What the screens show. A teammate reads as live only from events: they are online and their board reads. Anyone
   *  else reads "Not checked since" a time, or "Not checked" when none is known (team-summaries.mjs). */
  view() {
    return {
      status: this.state.status, link: this.link, linkAt: this.linkAt, team: this.state.team, teamName: this.state.teamName, unsaved: this.unsaved,
      me: this.me ? { id: this.meId, name: this.me.name, role: this.me.role, perms: this.me.perms, area: this.me.area, under: this.me.under } : { id: this.meId, name: this.state.name, role: null, perms: [], area: null, under: null },
      lead: this.isLead, leadName: this.people.get(this.roster?.lead)?.name || this.state.leadName || '',
      code: this.state.status === 'pending' ? this.state.code || null : null, asked: this.state.projects || [],
      areas: this.areas.map((a) => ({ ...a })),
      people: [...this.people.values()].map((p) => ({ id: p.id, name: p.name, role: p.role, perms: p.perms, area: p.area, under: p.under, ...this.personView(p) })),
      pending: [...this.pending.values()].map(({ m, at, code, name, projects }) => ({ m, at, code, name, projects })),
      invites: [...this.invites.values()].map(({ id, until, by }) => ({ id, until, by })),
    };
  }
}

Object.assign(Team.prototype, connection, roster, inbox, summaries);
