// The team client: one dev's Yes Chef on the relay (docs/team-relay-v0_1.md, "The app"). It keeps the socket, sends
// this dev's sealed summary when it changes, reads the team's, and runs a teammate's action on this dev's own threads
// only after it checks the sender, the sender's role, the action's age and its id. It never acts through anything but
// the dev's own capped T3 sign-in, which the caller passes in as `run`.
//
// One Team, four parts behind it: the connection (team-connection.ts), the roster (team-roster.ts), the inbox
// (team-inbox.ts) and the summaries (team-summaries.ts). This file holds the state they share, the store, and what
// the screens read.
import { newId, isId, newMember, saveMember, loadMember, signRoster, newTeamKey, teamKey, seal, aad, readInvite, joinRequest, matchCode } from './seal.ts';
import type { Member, RosterBody, SignedRoster } from './seal.ts';
import { grant } from './roles.ts';
import type { Perm, Role } from './roles.ts';
import { clean, ASK_MS, ACT_TTL } from './team-common.ts';
import { connection, RETRY, PING_MS, PONG_MS } from './team-connection.ts';
import { roster, KEY_ASK_MS, chartUnder, readUnderForTest } from './team-roster.ts';
import { inbox, BOARD_FRESH_MS } from './team-inbox.ts';
import type { Outgoing } from './team-inbox.ts';
import { summaries, summarize, identity, notCheckedSince } from './team-summaries.ts';
import type { Next, PersonView, Readers, Received } from './team-summaries.ts';
import type { ActInput, ActResult, Answered } from './actions.ts';
import type { Board } from './board.ts';
import type { InboxRow, InviteRow, PendingRow, RelayMessage } from '../relay/room.ts';

export { chartUnder, readUnderForTest };
export { RETRY, PING_MS, PONG_MS, ASK_MS, ACT_TTL, BOARD_FRESH_MS, KEY_ASK_MS, summarize, identity, notCheckedSince };
const STATE_V = 1;

/** Where this Mac stands with the team. */
export type TeamStatus = 'member' | 'pending' | 'declined' | 'removed' | 'ended';
/** The socket: off, connecting, online, waiting (a retry is set), stopped. */
export type Link = 'off' | 'connecting' | 'online' | 'waiting' | 'stopped';
/** A teammate's action this Mac judged, kept by its id so a redelivery gets the first answer again. */
export interface SeenAct { at: number; status: number; text: string }
/** What the store keeps. It holds private keys and the team key: the app seals it before it touches a disk. */
export interface TeamState {
  v: number; relay: string; team: string; teamName: string; leadSign: string; me: string; name: string;
  key: string | null; status: TeamStatus; shared: string[]; seen: [string, SeenAct][]; rosterVer: number;
  rosterHash?: string; code?: string; leadName?: string; projects?: string[];
  /** A roster this lead signed and the relay has not confirmed: it goes again, never a new one at its version. */
  unsent?: SignedRoster;
  welcomes?: string[]; keyAskAt?: number; seenFloor?: number; clockHigh?: unknown;
  seenCalls?: Record<string, number>; overAt?: Record<string, number>; summaryRev?: number; dropped?: number;
}
/** A member as the roster and its sealed detail give them. `under`: who they report to, or null (not checked). */
export interface Person { id: string; sign: string; dh: string; invite: boolean; name: string; role: Role; perms: Perm[]; area: string | null; under: string | null }
export interface Area { id: string; name: string }
/** An ask to join, opened by an inviter. */
export interface Asking { m: string; invite: string; at: number; sign: string; dh: string; code: string; name: string; projects: string[] }
/** An open invite this Mac can read: its secret makes the link. */
export interface HeldInvite { id: string; until: number; by: string; secret: string }
/** The relay's answer to a request, or this Mac's own when the request never went. */
export type Reply = { t: 'ok' | 'err'; id?: unknown; code?: string | undefined; text?: string | undefined; retryAfter?: number | undefined; ver?: number | undefined;
  at?: number | undefined; item?: string | undefined; until?: number | undefined; welcome?: 'later' };
/** A message that waits for the team key, as the relay sent it. */
export type Later = { t: 'invite'; invite: InviteRow } | { t: 'pending'; pending: PendingRow } | { t: 'summary'; m: string; blob: string } | ({ t: 'inbox' } & InboxRow);
/** What the socket hears, and what waits for the key. */
export type Incoming = RelayMessage | Later;
/** What a request over the socket sends. */
export type Request = { t: string; [field: string]: unknown };

/** A timer's handle, as the timers give it. */
export type TimerId = unknown;
/** The timers the team uses: the platform's, or a test's clock. */
export interface TeamTimers {
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
  setInterval(fn: () => void, ms: number): TimerId;
  clearInterval(id: TimerId): void;
}
/** What a socket event carries, as far as the team reads it. */
export interface SocketEvents { open: unknown; message: { data: unknown }; close: { code: number } }
/** The socket, as far as the team uses it: the platform's WebSocket, or a test's. */
export interface TeamSocket {
  addEventListener<K extends keyof SocketEvents>(type: K, fn: (ev: SocketEvents[K]) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
/** An HTTP answer: its status and its JSON body (null when it had none). */
export interface HttpAnswer { status: number; body: { error?: unknown; now?: unknown } | null | undefined }
export interface TeamNet {
  http(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<HttpAnswer>;
  socket(url: string): TeamSocket;
}
/** This dev's board as the Pass last read it. */
export interface OwnBoard { board: Board | null; ok: boolean; at: number }
/** Runs an action on this dev's own board through their T3 sign-in (client/actions.ts act()). */
export type TeamRun = (input: ActInput, prefix: string, maps: { holds: Map<string, string>; answered: Map<string, Answered> }) => Promise<ActResult | null | undefined>;
/** What the team tells its listeners, by type, and what goes with each. */
export interface TeamEvents {
  team: object; welcome: object;
  link: { link: Link };
  status: { status: TeamStatus };
  clock: { off: number };
  error: { text: string };
  /** A teammate's answer to an action this Mac sent. */
  result: { from: string; name: string; re: unknown; status: number; text: string };
  /** A teammate's action that ran, or was refused, on this Mac. */
  acted: { from: string; name: string; kind: unknown; thread: unknown; status: number; text: string };
}
export type TeamEvent = { [K in keyof TeamEvents]: { type: K } & TeamEvents[K] }[keyof TeamEvents];
export interface TeamOptions {
  state: TeamState; save?: (state: TeamState) => unknown; net?: TeamNet; now?: () => number; timers?: TeamTimers;
  random?: () => number; run?: TeamRun | null; board?: (() => OwnBoard | null | undefined) | null;
}
/** A teammate as the screens show them. */
export type ViewPerson = { id: string; name: string; role: Role; perms: Perm[]; area: string | null; under: string | null } & PersonView;
/** What the screens show. */
export type View = {
  status: TeamStatus; link: Link; linkAt: number; team: string; teamName: string; unsaved: boolean;
  me: { id: string | undefined; name: string; role: Role | null; perms: Perm[]; area: string | null; under: string | null };
  lead: boolean; leadName: string; code: string | null; asked: string[]; areas: Area[]; people: ViewPerson[];
  pending: Pick<Asking, 'm' | 'at' | 'code' | 'name' | 'projects'>[]; invites: Pick<HeldInvite, 'id' | 'until' | 'by'>[];
};

/** The network as the app has it: fetch for HTTP, the platform's WebSocket for the socket. */
export const webNet: TeamNet = {
  async http(method, url, body, headers = {}) {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: (body === undefined ? undefined : JSON.stringify(body)) as string });
    let out: HttpAnswer['body'] = null;
    try { out = await res.json(); } catch { out = null; }
    return { status: res.status, body: out };
  },
  socket: (url) => new WebSocket(url),
};

const failText = (res: HttpAnswer | null | undefined): string => (res?.body?.error as string) || `The relay answered ${res?.status}.`;

/** Make a team: this Mac's keys, the team key, roster 1 with this dev as lead. Returns the state to save (it holds
 *  private keys and the team key: the app seals it before it touches a disk). */
export async function createTeam({ relay, teamName, name, net = webNet, now = Date.now }: { relay: string; teamName: unknown; name: unknown; net?: TeamNet; now?: () => number }): Promise<TeamState> {
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
export async function joinTeam({ link, name, projects = [], shared = [], net = webNet, now = Date.now }: {
  link: unknown; name: unknown; projects?: unknown[]; shared?: string[]; net?: TeamNet; now?: () => number;
}): Promise<TeamState> {
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

/** The four parts' methods, which Object.assign puts on Team's prototype below. */
type Parts = typeof connection & typeof roster & typeof inbox & typeof summaries;
// The class and this interface merge: a Team has its own fields and methods, and the parts' methods.
export interface Team extends Parts {}

/** The live team. state: from createTeam or joinTeam. save(state): called whenever it changes.
 *  run(input, prefix): runs an action on this dev's own board through their T3 sign-in (client/actions.ts act()).
 *  board(): { board, ok, at }: this dev's board as the Pass last read it. */
export class Team {
  declare state: TeamState;
  declare saveFn: (state: TeamState) => unknown;
  declare net: TeamNet;
  declare now: () => number;
  declare timers: TeamTimers;
  declare random: () => number;
  declare run: TeamRun | null;
  declare boardOf: (() => OwnBoard | null | undefined) | null;
  // The connection
  declare link: Link;
  declare linkAt: number;
  declare lostAt: number | null;
  declare attempts: number;
  declare retry: TimerId | null;
  declare retryMs: number | undefined;
  declare ws: TeamSocket | null;
  declare asks: Map<string, { resolve: (r: Reply) => void; timer: TimerId }>;
  declare limits: { summaryMs: number; summaryMax: number; sendMax: number };
  declare stopped: boolean | undefined;
  declare attempt: number | undefined;
  declare beat: TimerId | null | undefined;
  declare pongTimer: TimerId | null | undefined;
  declare chain: Promise<unknown> | undefined;
  declare meId: string | undefined;
  declare meCache: Member | undefined;
  // The store
  declare writes: Promise<unknown>;
  declare unsaved: boolean;
  declare listeners: Set<(event: TeamEvent) => void>;
  // The roster
  declare rosterLock: Promise<unknown>;
  declare roster: RosterBody | null;
  declare rosterSigned: SignedRoster | undefined;
  declare people: Map<string, Person>;
  declare areas: Area[];
  declare pending: Map<string, Asking>;
  declare invites: Map<string, HeldInvite>;
  declare approving: Map<string, number> | undefined;
  declare key: CryptoKey | null;
  declare later: Later[];
  // The inbox
  declare out: Map<string, Outgoing>;
  declare holds: Map<string, string>;
  declare answered: Map<string, Answered>;
  declare seen: Map<string, SeenAct>;
  // The summaries
  declare summaries: Map<string, { body: Received }>;
  declare summaryFloor: Map<string, number>;
  declare online: Set<string>;
  declare lastSeen: Map<string, number>;
  declare healthOk: boolean | null;
  declare healthSince: number | null;
  declare next: Next | null;
  declare sentId: string | null;
  declare sentAt: number;
  declare setAt: number | undefined;
  declare summaryTimer: TimerId | null;
  declare flushing: boolean | undefined;
  declare flushFails: number | undefined;
  declare lastBoard: Board | undefined;
  declare lastBoardAt: number | undefined;
  declare readers: Readers | undefined;
  declare heldBody: Received | null | undefined;

  constructor({ state, save = () => {}, net = webNet, now = Date.now, timers = globalThis, random = Math.random, run = null, board = null }: TeamOptions) {
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
  on(fn: (event: TeamEvent) => void): () => boolean { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit<K extends keyof TeamEvents>(type: K, data: TeamEvents[K] = {} as TeamEvents[K]): void { for (const fn of [...this.listeners]) { try { fn({ type, ...data } as TeamEvent); } catch { /* a listener's fault is its own */ } } }
  /** Queue one write of the state as it is now. Writes go one at a time, in order, each a copy taken when it was
   *  queued: an older write never lands after a newer one. Resolves true once written. */
  write(): Promise<boolean> {
    this.state.seen = [...this.seen];
    let snap: TeamState;
    try { snap = structuredClone(this.state); } catch { snap = JSON.parse(JSON.stringify(this.state)); }
    const done = this.writes.then(() => this.saveFn(snap)).then(() => true, () => false);
    this.writes = done;
    // A store that answers later (the desktop app's Keychain) reports here too: a failed write shows as unsaved, never as
    // an unhandled rejection.
    return done.then((ok) => { this.saved(ok); return ok; });
  }
  save(): boolean { this.write(); return true; }
  /** The last save's outcome. The screens say "Not saved" until a later save gets through. */
  saved(ok: boolean): void { const was = this.unsaved; this.unsaved = !ok; if (was !== this.unsaved) this.emit('team'); }
  /** Save and wait until the store says it is written. False when it failed: whatever needed it does not go ahead. */
  saveNow(): Promise<boolean> { return this.write(); }
  setLink(link: Link): void {
    if (this.link === link) return;
    if (this.link === 'online') this.lostAt = this.now();
    this.link = link; this.linkAt = this.now();
    this.emit('link', { link });
  }
  async member(): Promise<Member> { return this.meCache || (this.meCache = await loadMember(this.state.me)); }
  async teamKey(): Promise<CryptoKey | null> { if (!this.key && this.state.key) this.key = await teamKey(this.state.key); return this.key; }
  get me(): Person | null { return this.people.get(this.meId as string) || null; }
  get isLead(): boolean { return !!this.roster && this.roster.lead === this.meId; }

  /** What the screens show. A teammate reads as live only from events: they are online and their board reads. Anyone
   *  else reads "Not checked since" a time, or "Not checked" when none is known (team-summaries.ts). */
  view(): View {
    return {
      status: this.state.status, link: this.link, linkAt: this.linkAt, team: this.state.team, teamName: this.state.teamName, unsaved: this.unsaved,
      me: this.me ? { id: this.meId, name: this.me.name, role: this.me.role, perms: this.me.perms, area: this.me.area, under: this.me.under } : { id: this.meId, name: this.state.name, role: null, perms: [], area: null, under: null },
      lead: this.isLead, leadName: this.people.get(this.roster?.lead as string)?.name || this.state.leadName || '',
      code: this.state.status === 'pending' ? this.state.code || null : null, asked: this.state.projects || [],
      areas: this.areas.map((a) => ({ ...a })),
      people: [...this.people.values()].map((p) => ({ id: p.id, name: p.name, role: p.role, perms: p.perms, area: p.area, under: p.under, ...this.personView(p) })),
      pending: [...this.pending.values()].map(({ m, at, code, name, projects }) => ({ m, at, code, name, projects })),
      invites: [...this.invites.values()].map(({ id, until, by }) => ({ id, until, by })),
    };
  }
}

Object.assign(Team.prototype, connection, roster, inbox, summaries);
