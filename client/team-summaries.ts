// The team client's summaries: this dev's sealed summary of the projects they share, the team's summaries, and who is
// online.
//
// Summaries are events, as in T3 Code's AgentAwarenessRelay: one goes out when its content changes, and only then. A
// read time (a key named `at`) is not a change: it rides along with a real one. Whether a teammate reads as live comes
// from events too: the relay's presence and the health their summary carries. Nothing compares two Macs' clocks.
import { sealSigned, openSigned, aad } from './seal.ts';
import { shares } from './roles.ts';
import { clean } from './team-common.ts';
import { RETRY } from './team-connection.ts';
import { rangesOf } from './changes.ts';
import { CLOSED, featureOf } from './linear.ts';
import type { LinearProject } from './linear.ts';
import { RULES } from './open-kitchen.ts';
import { cleanReviewers, loginOf, type Reviewer } from './reviewers.ts';
import type { Board, Ticket } from './board.ts';
import type { ChangedFile } from './changes.ts';
import type { PullRequestLink } from './contracts.ts';
import type { Person, Team } from './team.ts';

/** A teammate's summary, opened: outside data. Each field is checked where it is read (client/open-kitchen.ts). */
export type Received = { rev?: unknown; at?: unknown; health?: { ok?: unknown; since?: unknown } | null; tickets?: unknown; more?: unknown; [field: string]: unknown };
/** This Mac's board health: ok true or false, or null before the first read since this Mac started. */
export interface Health { ok: boolean | null; since: number | null }
/** This dev's summary, before it is sealed. */
export type OwnSummary = { v: number; tickets: unknown[]; more: number; health: Health; [field: string]: unknown };
/** The newest summary not yet sent, or a forget: the relay's copy goes. */
export type Next = { forget?: undefined; id: string; body: OwnSummary; drop: number | undefined; blob?: string }
  | { forget: true; drop: number | undefined; id?: undefined; body?: undefined; blob?: undefined };
/** A teammate as the screens show them. */
export interface PersonView { online: boolean; summary: Received | null; at: number | null; live: boolean; notCheckedSince: number | null }

/** A changed-files read (client/changes.ts readChanges), as the summary reads it: each field checked here. */
export type ChangesIn = { state?: unknown; why?: unknown; at?: unknown; files?: unknown; remote?: { repo?: unknown } | null;
  base?: { branch?: unknown; commit?: unknown } | null; head?: unknown; headAt?: unknown; truncated?: unknown;
  size?: { files?: unknown; added?: unknown; removed?: unknown } | null };
/** A changed file in that read. */
type FileIn = { path: string; hunks?: unknown; added?: unknown; removed?: unknown; lock?: unknown; generated?: unknown };
/** A PR's check runs (client/pr-runs.ts), as the summary reads them. */
export type ChecksIn = { result?: unknown; redRuns?: unknown; at?: unknown; runs?: unknown };
/** What the board server read of a PR from GitHub (client/github.ts readPrFacts), as the summary reads it. */
export type PrIn = { state?: unknown; why?: unknown; draft?: unknown; base?: unknown; at?: unknown; mergeSha?: unknown; blockedBy?: unknown;
  size?: { files?: unknown; added?: unknown; removed?: unknown } | null;
  runs?: { state?: unknown; why?: unknown; at?: unknown; readyAt?: unknown; checks?: ChecksIn | null; reviewers?: unknown } | null };
/** One base branch's checks (client/github.ts readBaseChecks), as the summary reads them. */
export type BaseIn = { state?: unknown; host?: unknown; repo?: unknown; branch?: unknown; sha?: unknown; title?: unknown; committedAt?: unknown;
  result?: unknown; requiredResult?: unknown; red?: { redSha?: unknown; redSince?: unknown } | null; checks?: unknown; at?: unknown };
/** What the board server reads beside the board, as getters, and what the summary keeps between reads. Each is optional:
 *  one left out reads "Not checked" on the lead's screen. */
export interface Readers {
  changes?: ((threadId: string) => ChangesIn | null | undefined) | undefined;
  pr?: ((pr: { host: string; repo: string; number: number }) => PrIn | null | undefined) | undefined;
  base?: ((threadId: string) => BaseIn | null | undefined) | undefined;
  seen?: unknown; fine?: unknown; over?: unknown; keepOver?: ((over: Record<string, number>) => void) | undefined; now?: number | undefined;
  /** This Mac's GitHub login (gh's sign-in), so a lead's Mac can match a PR's reviewers to its teammates. */
  login?: (() => unknown) | undefined;
  /** A Linear project as this Mac's agents read it (client/linear.ts), for French Brigade's features. */
  project?: ((id: string) => LinearProject | null | undefined) | undefined;
}
/** A feature as the summary sends it (step 7 PR 2): its lead's name (null: none; left out: not read), and its whole
 *  ticket list's count (left out: no whole list read). closed: done, canceled or duplicate; unread: no status read. */
export type SummaryFeature = { id: string; name: string; lead?: string | null; leadAt?: number;
  list?: { n: number; closed: number; unread: number; at: number } };
const FEATURES_MAX = 50, BLOCKERS_MAX = 5;
/** A PR's size as the summary sends it. */
export type SummarySize = { files: number | null; added: number | null; removed: number | null; at: number | null; overAt?: number };
/** A PR as the summary sends it. */
export type SummaryPr = { repo: string; n: number; state: string | null | undefined; url: string | null; base: string | null; draft: boolean | null;
  mergedAt: number | null; size?: SummarySize | null; readyAt?: number | null; checks?: ReturnType<typeof summaryChecks>;
  reviewers?: Reviewer[] | null; mergeSha?: string | null };
/** A ticket as the summary sends it. */
export type SummaryTicket = { thread: string; title: string; project: string; place: string; atPass: boolean; working: number; asks: number; call: boolean;
  prs: SummaryPr[]; updatedAt: string | null; startedAt: number | null; last: string | null; ask: ReturnType<typeof summaryAsk>;
  changes?: NonNullable<ReturnType<typeof summaryChanges>>;
  /** Its feature, the Linear project of its tickets (step 7): null when none is in a project; left out when no ticket was read. */
  feature?: { id: string; name: string } | null;
  /** The tickets that block it and are still open, as reads show (step 7 PR 2, 3C). Left out when none is known. */
  blocked?: { id: string; title: string | null; at: number }[] };

const SUMMARY_TICKETS = 100;

/** What a summary says, without its read times: two summaries with one identity are the same news. */
export function identity(body: unknown): string {
  return JSON.stringify(body, (k, v) => (k === 'at' ? undefined : v));
}

/** When a teammate was last known to be checked, for one who is not live: the earlier of the times that apply. Their
 *  board failing applies from its health's `since`; offline applies from when the relay last saw them. Null when no
 *  time is known. */
export function notCheckedSince({ online, health, lastSeen }: { online: boolean; health: { ok?: unknown; since?: unknown } | null | undefined; lastSeen: number | null | undefined }): number | null {
  const times: number[] = [];
  if (health && health.ok === false && Number.isFinite(health.since)) times.push(health.since as number);
  if (!online && Number.isFinite(lastSeen)) times.push(lastSeen as number);
  return times.length ? Math.min(...times) : null;
}

export const summaries = {
  // ---- the team's summaries and presence ----
  async takeSummary(m: string, blob: string): Promise<void> {
    const p = this.people.get(m);
    const key = await this.teamKey();
    if (!p || m === this.meId) return;
    // The welcome can land after the hello that carried the summaries: keep the latest one per teammate until the key
    // comes.
    if (!key) { this.later = this.later.filter((x) => !(x.t === 'summary' && x.m === m)); this.later.push({ t: 'summary', m, blob }); return; }
    try {
      const body = await openSigned(key, blob, aad.summary(this.state.team, m), p.sign) as Received | null;
      const rev = Number(body?.rev);
      if (!Number.isFinite(rev)) { this.summaries.delete(m); this.emit('team'); return; }
      // The floor outlives the shown summary: a reconnect clears what is shown, never the newest revision taken, so a
      // relay cannot hand back an older summary after it. The revision, not the time: a teammate whose clock went back
      // still gets through.
      if (rev < (this.summaryFloor.get(m) || 0)) return;
      this.summaryFloor.set(m, rev);
      this.summaries.set(m, { body: body as Received });
    } catch { this.summaries.delete(m); }
    this.emit('team');
  },

  /** A teammate withdrew their summary. Their summary still waiting for the key goes too. Revisions are whole
   *  milliseconds: half past the withdrawn one turns that summary away and lets a newer one in. Added once, so repeated
   *  withdrawals do not shut out the next revision. */
  takeGone(m: string): void {
    this.summaries.delete(m);
    if (Number.isInteger(this.summaryFloor.get(m))) this.summaryFloor.set(m, this.summaryFloor.get(m)! + 0.5);
    this.later = this.later.filter((x) => !(x.t === 'summary' && x.m === m));
    this.emit('team');
  },

  /** The relay says a teammate came online or went. Going carries the relay's time (`at`), read on the relay's clock. */
  takePresence(msg: { m: string; on: boolean; at?: number }): void {
    if (msg.on) { this.online.add(msg.m); this.lastSeen.delete(msg.m); }
    else { this.online.delete(msg.m); if (Number.isFinite(msg.at)) this.lastSeen.set(msg.m, msg.at!); }
    this.emit('team');
  },

  /** The summary the relay kept from this Mac before a restart, opened with this Mac's own key, so the first summary
   *  after the restart can carry its tickets with the health still unknown. */
  async takeHeld(blob: string | undefined): Promise<void> {
    if (this.lastBoard || !blob) return;
    try {
      const me = await this.member();
      this.heldBody = await openSigned((await this.teamKey())!, blob, aad.summary(this.state.team, me.id), me.signPub) as Received | null;
    } catch { this.heldBody = null; }
  },

  /** Who the hello says is online, and when the relay last saw each of the rest (`seen`: member id -> time). */
  takeHelloPresence(msg: { online?: string[]; seen?: Record<string, number> }): void {
    this.online = new Set(msg.online || []);
    this.lastSeen = new Map(Object.entries(msg.seen && typeof msg.seen === 'object' ? msg.seen : {})
      .filter(([m, at]) => !this.online.has(m) && Number.isFinite(at)));
  },

  /** A teammate as the screens show them. Live: they are online, this Mac is online, and their summary says their
   *  board reads. Otherwise "Not checked since" the earlier of the times that apply. While this Mac is offline, a
   *  teammate it last saw online counts as offline from when this Mac lost the relay. */
  personView(p: Pick<Person, 'id'>): PersonView {
    const linked = this.link === 'online';
    const online = linked && this.online.has(p.id);
    const s = this.summaries.get(p.id);
    const health = s?.body?.health || null;
    const lastSeen = linked ? this.lastSeen.get(p.id) : (this.online.has(p.id) ? this.lostAt : this.lastSeen.get(p.id));
    const live = online && health?.ok === true;
    return { online, summary: s?.body || null, at: Number.isFinite(s?.body?.at) ? s!.body.at as number : null, live,
      notCheckedSince: live ? null : notCheckedSince({ online, health, lastSeen }) };
  },

  // ---- this dev's summary ----
  /** The Pass read this dev's board. Its summary follows, only when it changed. readers: what the board server reads
   *  beside the board, as getters (summarize's `readers`); the last ones given stay until new ones come. */
  board(board: Board, readers?: Readers): void {
    this.lastBoard = board;
    if (readers) this.readers = readers;
    this.lastBoardAt = this.now();
    this.health(true);
  },

  /** The Pass's last board read worked (true) or failed (false). A flip is news and goes out like any change. */
  health(ok: boolean): void {
    if (this.healthOk !== ok) { this.healthOk = ok; this.healthSince = this.now(); }
    this.publish();
  },

  /** One of the readers beside the board (changed files, base checks, PR sizes) has news: the summary follows it, only
   *  when it changed. A board that failed its last read sends nothing new. */
  readersMoved(): void { if (this.lastBoard && this.healthOk) this.publish(); },

  /** The dev opened a call on their own Pass: its id (client/open-kitchen.ts callId) goes in their summary's `seen` (kept as state.seenCalls: state.seen is the actions already run), so
   *  the lead's Mac stops the call reaching them. Kept on disk for a day. */
  markSeen(callId: unknown): void {
    if (typeof callId !== 'string' || !callId || callId.length > 300) return;
    this.state.seenCalls = keepSeen({ ...(this.state.seenCalls || {}), [callId]: this.now() }, this.now());
    this.save();
    this.publish();
  },

  /** It's fine on a team call (Dan, 2026-11-13, "A"): its id goes in this Mac's summary's `fine`, with when, so every
   *  Pass that shows the call drops it and says who cleared it. Kept on disk for a day, as Seen is. A Mac that shares
   *  no project sends no summary, so its marks clear the call on this Mac only. */
  markFine(callId: unknown): boolean {
    if (typeof callId !== 'string' || !callId || callId.length > 300) return false;
    this.state.fineCalls = keepSeen({ ...(this.state.fineCalls || {}), [callId]: this.now() }, this.now());
    this.save();
    this.publish();
    return true;
  },

  /** Queue this dev's summary as it is now, if it differs from the one the relay took. */
  publish(): void {
    if (this.state.status !== 'member' || !(this.me && shares(this.me.role)) || !this.state.shared?.length) return;
    // No board read yet and nothing kept on the relay: there is nothing to say, or to correct.
    if (this.healthOk == null && !this.heldBody) return;
    const body = this.summaryBody();
    const id = identity(body);
    if (!this.flushing && id === this.sentId && !this.state.dropped) { this.next = null; return; }
    // The same summary already waits: it stays, so a sealed blob is not thrown away by each read.
    if (this.next && !this.next.forget && this.next.id === id && this.next.drop === this.state.dropped) return;
    this.next = { id, body, drop: this.state.dropped };
    this.flush();
  },

  /** The summary of the last board read, with this Mac's board health: ok true or false, or null before the first read
   *  since this Mac started. Before that read, the tickets are the ones the relay kept from before the restart, so a
   *  teammate keeps them but reads them as not checked. */
  summaryBody(): OwnSummary {
    const health: Health = { ok: this.healthOk ?? null, since: this.healthSince };
    if (!this.lastBoard) {
      const held = this.heldBody;
      // This Mac's It's fine marks go too: else the summary after a restart would take them off every other Pass until
      // the first board read (PR-Agent r1 on #75).
      return { v: 1, tickets: Array.isArray(held?.tickets) ? held!.tickets as unknown[] : [], more: Number(held?.more) || 0, health, fine: keepSeen(this.state.fineCalls, this.now()) };
    }
    const readers: Readers = { ...(this.readers || {}), seen: this.state.seenCalls, fine: this.state.fineCalls, now: this.now(), over: this.state.overAt,
      // Kept on disk, so a restart keeps Too big's age; saved only when it changed.
      keepOver: (m) => { if (JSON.stringify(m) !== JSON.stringify(this.state.overAt || {})) { this.state.overAt = m; this.save(); } } };
    return { ...summarize(this.lastBoard, this.state.shared, this.limits.summaryMax, readers), at: this.lastBoardAt, health };
  },

  async flush(): Promise<void> {
    if (!this.next || this.link !== 'online' || this.summaryTimer || this.flushing || !this.state.key) return;
    // Checked again at send time: a dev made a Viewer, or sharing nothing, sends no summary, whatever was queued before.
    if (!this.next.forget && (!(this.me && shares(this.me.role)) || !this.state.shared?.length)) { this.next = null; return; }
    // A summary and a forget share the relay's one limit per member. This Mac's clock went back since the send time was
    // set: the wait moves back by the jump, so it keeps its length and never waits the whole jump.
    const jump = (this.setAt ?? -Infinity) - this.now();
    if (jump > 0) { this.sentAt -= jump; this.setAt = this.now(); }
    const wait = this.sentAt + this.limits.summaryMs - this.now();
    if (wait > 0) { this.summaryTimer = this.timers.setTimeout(() => { this.summaryTimer = null; this.flush(); }, wait); return; }
    const next = this.next;
    if (!next.forget && next.id === this.sentId && !this.state.dropped) { this.next = null; return; }
    this.flushing = true;
    const backoff = () => {
      this.flushFails = (this.flushFails || 0) + 1;
      this.sentAt = this.now() - this.limits.summaryMs + Math.min(RETRY.cap, this.limits.summaryMs * 2 ** Math.min(this.flushFails, 10)); this.setAt = this.now();
    };
    try {
      let blob: string | null = null;
      if (!next.forget) {
        try { blob = next.blob || (next.blob = await this.sealSummary(next.body)); } catch (ex) {
          // A key or member that does not load fails the same way every time: wait as for a failed send.
          backoff();
          this.emit('error', { text: `Yes Chef could not seal this Mac's summary: ${clean(String((ex as Error)?.message || ex), 200)}` });
          return;
        }
        // Sealing waits on WebCrypto. A project dropped, or a Viewer made, while it ran replaced this summary or ended
        // sharing: it goes nowhere, and the newer one or the check above decides what does.
        if (this.next !== next || !(this.me && shares(this.me.role)) || !this.state.shared?.length) return;
      }
      const r = next.forget ? await this.say({ t: 'forget' }) : await this.say({ t: 'summary', blob });
      if (r.t === 'ok') {
        this.sentId = next.forget ? null : next.id; this.sentAt = this.now(); this.setAt = this.now(); this.flushFails = 0;
        if (this.state.dropped && next.drop === this.state.dropped) { delete this.state.dropped; this.save(); }
        if (this.next === next) this.next = null;
      } else if (r.code === 'slow') {
        this.sentAt = this.now() - this.limits.summaryMs + (Number(r.retryAfter) || this.limits.summaryMs); this.setAt = this.now();
      } else if (r.code === 'bad') {
        // The relay will never take this one: drop it and say so, rather than send it again.
        if (this.next === next) this.next = null;
        this.emit('error', { text: `The relay refused this Mac's summary: ${clean(r.text, 200)}` });
      } else {
        // Offline, a timeout, the cap: try again later, waiting longer each time, up to five minutes. The relay may have
        // taken it, so what it holds is not known: the next summary goes even if it matches the last one taken.
        this.sentId = null;
        backoff();
      }
    } finally {
      this.flushing = false;
      if (this.next) this.flush();
    }
  },

  /** Seal a summary, and halve its tickets until the sealed blob fits the relay's limit: names in any script are
   *  measured as the bytes they seal to. */
  async sealSummary(body: OwnSummary): Promise<string> {
    const me = await this.member();
    const key = await this.teamKey();
    // The order is a revision, kept on disk and only going up, even when the clock goes back, so a replacement built
    // from the same board (a dropped project) is always newer and the relay cannot hand back the one it replaced. On
    // disk before any summary carries it: a restart never reuses a revision teammates already took.
    const rev = Math.max(this.now(), (Number(this.state.summaryRev) || 0) + 1);
    this.state.summaryRev = rev;
    if (!(await this.saveNow())) throw new Error('This Mac could not save the summary\'s revision, so it did not send it.');
    for (let b = body; ; ) {
      const blob = await sealSigned(key!, me, { ...b, rev }, aad.summary(this.state.team, me.id));
      if (blob.length <= this.limits.summaryMax || !b.tickets.length) return blob;
      const n = Math.floor(b.tickets.length / 2);
      b = { ...b, tickets: b.tickets.slice(0, n), more: (b.more || 0) + b.tickets.length - n };
    }
  },

  /** Nothing more goes out, and the relay's copy goes. */
  unshare(): void { this.next = { forget: true, drop: this.state.dropped }; this.flush(); },

  /** The dev changed which projects they share. Sharing nothing drops the relay's copy. Dropping a project rebuilds the
   *  waiting summary from the last board at once, so a summary queued before the change never carries that project's
   *  tickets. Resolves false when the new list did not reach the disk. It is in use here all the same. */
  async share(projectIds: unknown[]): Promise<boolean> {
    const before = new Set(this.state.shared || []);
    this.state.shared = [...new Set(projectIds.map(String))];
    // A project dropped is kept on disk as owed until the relay takes a summary or forget built after it: a restart
    // before then still replaces the relay's copy.
    if ([...before].some((id) => !this.state.shared.includes(id))) this.state.dropped = (Number(this.state.dropped) || 0) + 1;
    this.shareNow(before);
    return this.saveNow();
  },
  shareNow(before: Set<string | null>): void {
    if (!this.state.shared.length) { this.unshare(); return; }
    const dropped = [...before].some((id) => !this.state.shared.includes(id as string));
    // Only added: the summary changes, so it goes as any change does.
    if (!dropped) { this.publish(); return; }
    if (this.lastBoard && this.me && shares(this.me.role)) {
      const body = this.summaryBody();
      this.next = { id: identity(body), body, drop: this.state.dropped };
      this.flush();
    } else this.unshare();
  },
} satisfies ThisType<Team>;

// ---- the summary's fields (3b PR 4, agreed with step 4: client/open-kitchen.ts cleanTicket and cleanBase read them) ----
const FILES_MAX = 150, RANGES_MAX = 24, BASES_MAX = 10, SEEN_MAX = 100, SEEN_MS = 24 * 3600000, SEEN_BYTES = 8192;
// A time as epoch ms, or null. T3 and GitHub give ISO strings; the summary sends numbers.
const time = (v: unknown): number | null => { const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const sha = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f]{7,64}$/i.test(v) ? v.toLowerCase() : null);
const count = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 ? v as number : null);
const name = (v: unknown, n: number): string | null => (typeof v === 'string' && v.trim() ? clean(v, n) : null);
const firstLine = (v: unknown, n: number): string | null => name(String(v || '').split('\n').map((l) => l.trim()).find(Boolean), n);

/** At most n line ranges for a file: the two neighbours with the smallest gap between them merge, until n are left.
 *  Every changed line stays inside a range. */
export function fewerRanges(list: readonly (readonly [number, number, ...unknown[]])[], n = RANGES_MAX): [number, number][] {
  const r = list.map(([a, b]): [number, number] => [a, b]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  while (r.length > n) {
    let best = 0;
    for (let i = 1; i < r.length - 1; i++) if (r[i + 1]![0] - r[i]![1] < r[best + 1]![0] - r[best]![1]) best = i;
    r.splice(best, 2, [r[best]![0], Math.max(r[best]![1], r[best + 1]![1])]);
  }
  return r;
}

/** A thread's changed files (client/changes.ts readChanges) as the summary sends them. Ranges are on the base side,
 *  the one coordinate two devs share. Unknown stays null, never 0 or []. At most 150 files, the most lines changed
 *  first (a file of unknown size counts as large); `more` counts the files left out, plus one when git's own list was
 *  cut. Lockfiles and generated files carry `x: 1` and stay out of `size`. */
export function summaryChanges(r: ChangesIn | null | undefined) {
  if (!r || typeof r !== 'object') return null;
  if (r.state !== 'checked') return { state: 'not-checked' as const, why: name(r.why, 200) || 'Not read yet.', at: time(r.at) };
  const lines = (f: FileIn): number => (count(f.added) === null || count(f.removed) === null ? Infinity : (f.added as number) + (f.removed as number));
  const all = ((Array.isArray(r.files) ? r.files : []) as (FileIn | null)[]).filter((f) => f && typeof f.path === 'string') as FileIn[];
  const files = [...all].sort((a, b) => lines(b) - lines(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, FILES_MAX).map((f) => {
    const out: { p: string; r: [number, number][] | null; a: number | null; d: number | null; x?: 1 } = { p: clean(f.path, 300), r: Array.isArray(f.hunks) && f.hunks.length ? fewerRanges(rangesOf(f as Pick<ChangedFile, 'hunks'>, 'old')) : null, a: count(f.added), d: count(f.removed) };
    if (f.lock || f.generated) out.x = 1;
    return out;
  });
  return {
    state: 'checked' as const, at: time(r.at), repo: name(r.remote?.repo, 100), base: name(r.base?.branch, 100), mergeBase: sha(r.base?.commit), head: sha(r.head), headAt: time(r.headAt),
    files, more: all.length - files.length + (r.truncated ? 1 : 0),
    size: { files: count(r.size?.files), added: count(r.size?.added), removed: count(r.size?.removed) },
  };
}

/** A PR's check runs as the summary sends them (client/pr-runs.ts): the head's result, how many runs failed in a
 *  row, and the last 10 runs, oldest first. */
export function summaryChecks(c: ChecksIn | null | undefined) {
  if (!c || typeof c !== 'object') return null;
  return { result: name(c.result, 20), redRuns: count(c.redRuns), at: time(c.at),
    runs: ((Array.isArray(c.runs) ? c.runs : []) as ({ at?: unknown; sha?: unknown; title?: unknown; result?: unknown } | null)[]).slice(-10).map((r) => ({ at: time(r?.at), sha: sha(r?.sha), title: name(r?.title, 80), result: name(r?.result, 20) })) };
}

/** A PR as the summary sends it: T3's link (state, target branch, draft, merge time), and what the board server read
 *  from GitHub (client/github.ts readPrFacts). Open: the size (null when GitHub's file list was partial), the check
 *  runs, when it was marked ready and who reviews it (client/reviewers.ts). Merged: its merge commit. A fact not read is left out, never a guess. */
export function summaryPr(p: PullRequestLink, read: PrIn | null | undefined): SummaryPr {
  const out: SummaryPr = { repo: clean(p.repository, 100), n: p.number, state: p.state, url: typeof p.url === 'string' && /^https:\/\//.test(p.url) ? p.url.slice(0, 300) : null,
    base: name(p.base, 100), draft: typeof p.draft === 'boolean' ? p.draft : null, mergedAt: time(p.mergedAt) };
  // Draft unknown stays null, never "not a draft" (PR-Agent r1 on #27).
  if (read?.state === 'checked' && p.state === 'open') {
    if (typeof read.draft === 'boolean') out.draft = read.draft;
    if (name(read.base, 100)) out.base = name(read.base, 100);
    out.size = read.size ? { files: count(read.size.files), added: count(read.size.added), removed: count(read.size.removed), at: time(read.at) } : null;
    if (read.runs?.state === 'checked') {
      out.readyAt = time(read.runs.readyAt); out.checks = summaryChecks(read.runs.checks); out.reviewers = cleanReviewers(read.runs.reviewers);
    }
  }
  if (read?.state === 'checked' && p.state === 'merged') out.mergeSha = sha(read.mergeSha);
  return out;
}

/** The first open question on a ticket: a T3 question, else a call in the agent's hand-back (client/calls.ts). `at`
 *  is when the thread stopped to ask; `n` how many are open. */
export function summaryAsk(k: Pick<Ticket, 'asks' | 'call' | 'thread'>) {
  const qs = (k.asks || []).flatMap((a) => (a.items || []).map((it) => ({ it, at: a.thread?.updatedAt })));
  if (qs.length) {
    const { it, at } = qs[0]!;
    return { at: time(at), q: name(it.question, 200) || 'A question', rec: null, n: qs.length,
      options: (Array.isArray(it.options) ? it.options : []).slice(0, 6).map((o) => ({ k: name(o?.label, 40), t: name(o?.description || o?.label, 120) })) };
  }
  const calls = k.call?.calls || [];
  if (!calls.length) return null;
  const c = calls[0]!;
  return { at: time(k.thread?.updatedAt), q: name(c.question, 200) || 'Your call', rec: name(c.recommend, 4), n: calls.length,
    options: (Array.isArray(c.options) ? c.options : []).slice(0, 6).map((o) => ({ k: name(o?.letter, 4), t: name(o?.text, 120) })) };
}

/** One base branch's checks as the summary sends it (client/github.ts readBaseChecks). `failing`: up to 5 names. */
export function summaryBase(b: BaseIn) {
  return { repo: name(b.repo, 100), branch: name(b.branch, 100), sha: sha(b.sha), title: name(b.title, 120), committedAt: time(b.committedAt),
    result: name(b.result, 20), requiredResult: name(b.requiredResult, 20), redSha: sha(b.red?.redSha), redSince: time(b.red?.redSince),
    failing: ((Array.isArray(b.checks) ? b.checks : []) as ({ state?: unknown; name?: unknown } | null)[]).filter((c) => c?.state === 'failing').map((c) => name(c!.name, 80)).filter(Boolean).slice(0, 5),
    at: time(b.at) };
}

/** The calls this dev opened on their own Pass in the last day, at most 100 and 8 KiB as UTF-8, the newest kept: the
 *  summary's other fields keep their room under the relay's limit (PR-Agent r2 on #27). */
export function keepSeen(seen: unknown, now: number): Record<string, number> {
  const list = (Object.entries(seen && typeof seen === 'object' ? seen : {}) as [string, number][])
    .filter(([id, at]) => typeof id === 'string' && id.length <= 300 && Number.isFinite(at) && at <= now + 60000 && now - at < SEEN_MS)
    .sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX);
  const out: [string, number][] = [];
  let used = 2;
  for (const [id, at] of list) {
    used += new TextEncoder().encode(JSON.stringify(id)).length + String(at).length + 2;
    if (used > SEEN_BYTES) break;
    out.push([id, at]);
  }
  return Object.fromEntries(out);
}

/** This dev's summary for the team: the tickets in the projects they share, newest first, the ones waiting on a person
 *  first. What a teammate's calls need (docs/team-relay-v0_1.md): the first line of the agent's last message, the open
 *  question, the changed files with their line ranges, the PRs and the base checks. No code and no whole messages.
 *  readers, from the board server, all optional: changes(threadId), pr({ host, repo, number }), base(threadId), each
 *  giving that reader's last result; seen (callId -> time); over (PR -> when this Mac first saw it too big) and
 *  keepOver(map), which takes the new one; now. A reader left out reads "Not checked" on the lead's
 *  screen, never a guess. It fits the relay's limit with room for the seal: the changed files of the least recent
 *  tickets go first, then whole tickets. */
export function summarize(board: Pick<Board, 'tickets'> | null | undefined, shared: readonly string[] | null | undefined, max = 65536, readers: Readers = {}) {
  const keep = new Set<string | undefined>(shared || []);
  const get = <A extends unknown[], R>(f: ((...a: A) => R) | null | undefined, ...a: A): R | null => { try { return typeof f === 'function' ? f(...a) : null; } catch { return null; } };
  const now = Number.isFinite(readers.now) ? readers.now! : Date.now();
  // Too big's age: when this Mac first saw each open PR over the limit, kept while it stays over (3b PR 4b).
  const overBefore = (readers.over && typeof readers.over === 'object' ? readers.over : {}) as Record<string, unknown>, over: Record<string, number> = {};
  // Keyed like the reads, host and all (PR-Agent r2 on #28).
  const withOver = (pr: SummaryPr, host: string | undefined): SummaryPr => {
    const s = pr.size, key = `${String(host || 'github.com').toLowerCase()}/${String(pr.repo).toLowerCase()}#${pr.n}`, was = overBefore[key];
    if (pr.state !== 'open') return pr;
    // Size unknown (not read yet, GitHub refused, a partial list): the first time over is kept, not lost (PR-Agent
    // r1 on #28). It goes only when a read shows the PR under the limit, or the PR leaves the board or closes.
    if (!s || s.added === null || s.removed === null || s.files === null) {
      if (Number.isFinite(was) && (was as number) <= now) over[key] = was as number;
      return pr;
    }
    if (s.added + s.removed <= RULES.bigLines && s.files <= RULES.bigFiles) return pr;
    over[key] = Number.isFinite(was) && (was as number) <= now ? was as number : now;
    s.overAt = over[key];
    return pr;
  };
  const picked = (board?.tickets || [])
    .filter((k) => keep.has(k.thread.projectId) && k.place !== 'Coordinators')
    .sort((a, b) => (+b.atPass - +a.atPass) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const tickets = picked.map((k) => {
    // Each open or merged PR's read, once: its facts and what its description says it waits on.
    const reads = k.prs.map((p) => (p.state === 'open' || p.state === 'merged' ? get(readers.pr, { host: p.host || 'github.com', repo: p.repository, number: p.number }) : null));
    const t: SummaryTicket = {
      thread: k.thread.threadId, title: clean(k.thread.title, 160), project: clean(k.project, 80), place: k.place,
      atPass: !!k.atPass, working: k.working || 0, asks: k.asks.length, call: !!k.call,
      // Every PR keeps its Too big age, also past the 5 the summary carries (PR-Agent r3 on #28).
      prs: k.prs.map((p, i) => withOver(summaryPr(p, reads[i]), p.host)).slice(0, 5),
      updatedAt: k.updatedAt || null, startedAt: time(k.thread.createdAt), last: firstLine(k.lastWords, 160), ask: summaryAsk(k),
    };
    // Its feature (step 7, Dan 3A, 2026-11-13): the Linear project of the tickets its threads read. Left out when no
    // ticket was read (not checked); null when they were and none is in a project.
    const f = featureOf(k.linear);
    if (f !== undefined) t.feature = f && { id: f.id, name: clean(f.name, 80) };
    // Blocked (3C, 2026-11-13): a Linear "blocked by" ticket a read shows still open. One whose status no read gave is
    // not checked, so it raises nothing. at: when the relation was read.
    const blocked = (k.linear || []).flatMap((l) => (l.state === 'read' ? (l.blockedBy || []).filter((b) => b.open === true).map((b) => ({ id: b.id, title: b.title ? clean(b.title, 120) : null, at: l.at })) : []));
    // And an open PR whose description says it waits on an issue or PR that GitHub shows open ("owner/repo#N").
    for (const [i, p] of k.prs.entries()) {
      if (p.state !== 'open') continue;
      const r = reads[i];
      const at = time(r?.at);
      if (r?.state !== 'checked' || at === null || !Array.isArray(r.blockedBy)) continue;
      for (const b of r.blockedBy as { repo?: unknown; n?: unknown; open?: unknown }[]) {
        if (b?.open === true && typeof b.repo === 'string' && Number.isInteger(b.n)) blocked.push({ id: `${clean(b.repo, 200)}#${b.n as number}`, title: null, at });
      }
    }
    if (blocked.length) t.blocked = [...new Map(blocked.map((b) => [b.id, b])).values()].slice(0, BLOCKERS_MAX);
    const c = summaryChanges(get(readers.changes, k.thread.threadId));
    if (c) t.changes = c;
    return t;
  });
  const bases = new Map<string, ReturnType<typeof summaryBase>>();
  for (const k of picked) {
    const b = get(readers.base, k.thread.threadId);
    if (b?.state !== 'checked' || bases.size >= BASES_MAX) continue;
    const key = `${String(b.host || 'github.com').toLowerCase()}/${String(b.repo).toLowerCase()}@${b.branch}`;
    if (!bases.has(key)) bases.set(key, summaryBase(b));
  }
  get(readers.keepOver, over);
  // Each feature this Mac's tickets are in, with what its agents read of the Linear project: the lead (Ship's target,
  // 2A) and the whole ticket list (Ready for your look, 1A).
  const features: SummaryFeature[] = [];
  for (const id of [...new Set(tickets.flatMap((t) => (t.feature ? [t.feature.id] : [])))].slice(0, FEATURES_MAX)) {
    const p = get(readers.project, id);
    const out: SummaryFeature = { id, name: tickets.find((t) => t.feature?.id === id)!.feature!.name };
    if (p && p.lead !== undefined && Number.isFinite(p.leadAt)) { out.lead = p.lead === null ? null : clean(p.lead, 80); out.leadAt = p.leadAt!; }
    if (p?.tickets && Number.isFinite(p.listAt)) {
      out.list = { n: p.tickets.length, closed: p.tickets.filter((x) => x.statusType !== null && CLOSED.has(x.statusType)).length,
        unread: p.tickets.filter((x) => x.statusType === null).length, at: p.listAt! };
    }
    features.push(out);
  }
  // gh: this Mac's GitHub login, or null when gh's sign-in was not read (not checked).
  const top = { gh: loginOf(get(readers.login)), bases: [...bases.values()], seen: keepSeen(readers.seen, now), fine: keepSeen(readers.fine, now), features };
  let n = Math.min(tickets.length, SUMMARY_TICKETS);
  // A sealed summary is about 4/3 of its JSON's UTF-8 bytes plus the signature. Shed the changed files of the least
  // recent tickets first (a ticket without them reads "Not checked"), then halve the list until it fits. Sealing checks
  // the real size again (sealSummary).
  const bytes = (x: unknown): number => new TextEncoder().encode(JSON.stringify(x)).length;
  const fits = () => (bytes({ ...top, tickets: tickets.slice(0, n) }) * 4) / 3 + 600 <= max;
  const byAge = tickets.slice(0, n).map((t, i) => i).filter((i) => tickets[i]!.changes)
    .sort((a, b) => String(tickets[a]!.updatedAt || '').localeCompare(String(tickets[b]!.updatedAt || '')) || b - a);
  for (const i of byAge) { if (fits()) break; delete tickets[i]!.changes; }
  while (n > 0 && !fits()) n = Math.floor(n / 2);
  // Last, and only for a limit far below the relay's: the base branches go too, so the summary always fits.
  while (top.bases.length && !fits()) top.bases.pop();
  return { v: 1, tickets: tickets.slice(0, n), more: tickets.length - n, ...top };
}
