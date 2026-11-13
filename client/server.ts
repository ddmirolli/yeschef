// The Pass web prototype (docs/pass-product-brief-v1_0.md, Dan's 1a and 2a, 2026-11-06).
// Read-only. It follows one T3 environment's live stream (client/t3live.ts) and reads the rest as an outside MCP
// client, and pushes each change to the page. It stores nothing: the keys live in this process, and every fact
// comes from T3.
// Run: BRIGADE_PASS_ORIGIN=<this page's https address> BRIGADE_ALLOW=<allow-list file> node client/server.ts <t3-origin> [port]
// The desktop app (desktop/main.ts) starts it with the T3 origin only: it opens no port and takes actions over its pipe.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { onScale } from './scale.ts';
import { mkdtempSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn, connect } from './t3mcp.ts';
import type { SignedIn } from './t3mcp.ts';
import type { Project, QuestionItem, T3Caller, ThreadRead, ThreadRow } from './contracts.ts';
import type { Shell } from './shells.ts';
import type { ProjectShell } from './t3live.ts';
import type { ChangesRead } from './changes.ts';
import type { Board, Handback, Status } from './board.ts';
import type { RunsEntry, WaitEntry } from './you.ts';
import type { ActInput, ActResult, Answered } from './actions.ts';
import type { Readers } from './team-summaries.ts';
import type { TeamState } from './team.ts';
import type { HostProject, TeamStore } from './teamhost.ts';
import { createKeys, createLive } from './t3live.ts';
import { boardThreads, changeTargets, githubTargets } from './shells.ts';
import { createChanges } from './changes.ts';
import { createBaseChecks, createPrSizes, ghGet, prKey, readBaseFacts, readPrFacts } from './github.ts';
import { loginOf } from './reviewers.ts';
import { buildBoard, renderApp, kitchenPane, pickedFrom, ICON } from './board.ts';
import { fitFrom } from './flow.ts';
import { readRuns, dayStart, trackWaits, mayRunToday } from './you.ts';
import { normalize as normalRules, change as changeRule } from './kitchen.ts';
import { parseCalls, callKey, imagesIn, imageId, shotPath, isShot, SHOT_TYPES } from './calls.ts';
import { act } from './actions.ts';
import { refuse } from './guard.ts';
import { BAR_CSS, BAR_HTML, SPRING, barCore, installBar } from './bar.ts';
import { onTheme, miniCss, minis, MINI_CSS } from './theme.ts';
import { keysCore } from './keys.ts';
import { passScript } from './page.ts';
import { appendFileSync } from 'node:fs';
import { teamHost } from './teamhost.ts';
import { createDiffs, diffRoute } from './diffs.ts';
import type { PrRef } from './diffs.ts';
import { openKitchen } from './open-kitchen.ts';

/** A message from the desktop app over the pipe (desktop/main.ts). Each handler checks the fields it reads. */
interface AppMessage { type?: unknown; id?: unknown; body?: unknown; path?: unknown; state?: unknown; error?: unknown; auth?: unknown }
type Hear = (m: AppMessage | null | undefined) => void;
/** The desktop app's pipe: send a message to the app, and listen for its messages. */
interface Pipe { send(m: object): void; on(fn: Hear): void; off(fn: Hear): void }
/** Electron's port to the app in a utility process (Electron's process.parentPort; Node's types do not have it). */
interface ParentPort { on(event: 'message', fn: (e: { data: AppMessage }) => void): void; postMessage(m: unknown): void }

// The desktop app's pipe. In the app this runs in an Electron utility process and talks over process.parentPort;
// started by Node with an IPC channel it uses process.send. Alone (node client/server.ts) it has neither: the web prototype.
function appPipe(): Pipe | null {
  const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
  if (parentPort) {
    const hear = new Set<Hear>();
    parentPort.on('message', (e) => { for (const fn of [...hear]) fn(e.data); });
    return { send: (m) => parentPort.postMessage(m), on: (fn) => hear.add(fn), off: (fn) => hear.delete(fn) };
  }
  const send = process.send?.bind(process);
  if (typeof send === 'function') {
    return { send: (m) => { if (process.connected) send(m); }, on: (fn) => process.on('message', fn), off: (fn) => process.off('message', fn) };
  }
  return null;
}
const pipe = process.env.YESCHEF_DESKTOP === '1' ? appPipe() : null;
const DESKTOP = !!pipe;
const ORIGIN = (process.argv[2] || '').replace(/\/$/, '');
const PORT = Number(process.argv[3] || 8620);
// The page hears from the board at least this often, live or not: each beat rebuilds the board from what the
// stream holds (no T3 call unless a thread changed) and says whether that data is live.
const BEAT_MS = 5000;
// Actions on the web prototype: only through the tailnet, from an allowed device, on this page (client/guard.ts).
// The page's address and the allow list come from the environment: the code carries nobody's address or files.
const PAGE_ORIGIN = process.env.BRIGADE_PASS_ORIGIN || '';
const ALLOW = process.env.BRIGADE_ALLOW || '';
const missing = [!ORIGIN && 'the T3 origin (first argument)', !DESKTOP && !PAGE_ORIGIN && 'BRIGADE_PASS_ORIGIN', !DESKTOP && !ALLOW && 'BRIGADE_ALLOW'].filter(Boolean);
if (missing.length) {
  console.error(`The Pass needs ${missing.join(', ')}.\nRun: BRIGADE_PASS_ORIGIN=<this page's https address> BRIGADE_ALLOW=<allow-list file> node client/server.ts <t3-origin> [port]`);
  process.exit(2);
}
const HERE = dirname(fileURLToPath(import.meta.url));
// The Pass's base stylesheet (client/pass.css); the app's own rules follow it (APP_CSS).
const CSS = readFileSync(join(HERE, 'pass.css'), 'utf8');
const OUT = mkdtempSync(join(tmpdir(), 'the-pass-'));
// Rules (client/kitchen.ts), set in Settings. The desktop app keeps them in its data folder
// (YESCHEF_RULES_FILE); the web prototype keeps them in this run's temp folder.
const RULES_FILE = process.env.YESCHEF_RULES_FILE || join(OUT, 'kitchen-rules.json');
let rules = normalRules(null);
// No file yet means the defaults. A file Yes Chef cannot read is not guessed at (PR-Agent on #49): Settings says
// so, and Launch waits until a save from Settings replaces it.
let rulesError = '';
const rulesSeq = new Map<string, number>(); // [page id, scope, rule] -> the newest save count taken for it
// Each saved set has a revision that only goes up, even across restarts, so a page keeps the newest copy it has seen
// whatever order answers and refreshes reach it (PR-Agent r10 on #49).
let rulesRev = Date.now();
const rulesNow = () => ({ ...rules, rev: rulesRev });
try { rules = normalRules(JSON.parse(readFileSync(RULES_FILE, 'utf8'))); }
catch (ex) { const code = (ex as Fault).code; if (code !== 'ENOENT') rulesError = `Yes Chef could not read your rules (kitchen-rules.json: ${code || 'not valid JSON'}).`; }
let authLost = false;

let t3: T3Caller | null = null, canOperate = false, envId: string | null = null, projects: ShownProject[] = [], projectsAt = 0;
let board: Board = { tickets: [], verifiedToday: 0, runsChecked: false };
/** Call a T3 Code tool. Every caller runs once the sign-in is ready. Its reply is read as T: typed, not checked
 *  (client/contracts.ts). */
const tool = <T>(name: string, args: Record<string, unknown>): Promise<T> => t3!.call(name, args) as Promise<T>;
/** An error as the server reads it: a file error's code, T3 Code's refusal of the sign-in, or a form over the limit. */
type Fault = Error & { code?: string; auth?: boolean; tooLarge?: boolean };
/** A row of t3_project_list: a project and the icon file T3 Code names for it. */
type ProjectRow = Project & { faviconPath?: string | null };
/** A project as the board shows it: its icon is an address on this server, or none. */
type ShownProject = ProjectRow & { icon: string | null };
/** One message of a thread, and a page of them (t3_thread_read, view messages). */
interface MessageItem { itemId: string; position: number; type: string; text?: string; textTruncated?: boolean }
interface MessagesPage { items?: MessageItem[]; hasMore?: boolean; nextPosition?: number }
// Project icons: T3 gives only a file path. The Pass can show it when it runs on T3's own machine.
const ICON_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
/** An icon read and checked: its type and bytes. */
type Icon = { type: string; body: Buffer };
let iconFiles = new Map<string, Icon>();
// An icon is served only when its real path (symlinks resolved) sits inside the project's folder or T3's own
// project-icons folder, has an image extension, and its bytes start like an image. Anything else gets the letter.
const T3_ICONS = join(homedir(), '.t3', 'userdata', 'project-icons');
const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };
const inside = (file: string, root: string | null): boolean => !!root && (file === root || file.startsWith(root.endsWith(sep) ? root : root + sep));
function looksLikeImage(bytes: Buffer): boolean {
  const b = bytes.subarray(0, 512);
  const head = b.toString('latin1');
  return head.startsWith('\x89PNG') || (b[0] === 0xff && b[1] === 0xd8) || (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP')
    || (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(b.toString('utf8'));
}
function iconPath(p: ProjectRow): Icon | null {
  if (!p.faviconPath) return null;
  const file = real(isAbsolute(p.faviconPath) ? p.faviconPath : join(p.workspaceRoot || '/nonexistent', p.faviconPath));
  if (!file || !ICON_TYPES[extname(file).toLowerCase()]) return null;
  if (!inside(file, real(p.workspaceRoot || '')) && !inside(file, real(T3_ICONS))) return null;
  // Read once and keep the bytes that passed: the route serves these, never the path again (no swap after the check).
  try {
    if (!statSync(file).isFile() || statSync(file).size >= 512 * 1024) return null;
    const body = readFileSync(file);
    return looksLikeImage(body) ? { type: ICON_TYPES[extname(file).toLowerCase()]!, body } : null;
  } catch { return null; }
}
function withIcons(list: ProjectRow[]): ShownProject[] {
  iconFiles = new Map();
  return list.map((p) => {
    const icon = iconPath(p);
    if (icon) iconFiles.set(p.id, icon);
    return { ...p, icon: icon ? `/icon/${encodeURIComponent(p.id)}` : null };
  });
}
// The agent's hand-back on each ticket that gave the turn back, kept until the thread runs again: its latest
// message, and its call (lettered options, client/calls.ts) if it asked one since the last message it received.
// PR bot pings start runs too ("checks passed"); they post no user message, so a call before them stays open.
const handbackCache = new Map<string, { key: string; value: Handback }>();
async function handback(t: ThreadRow): Promise<Handback> {
  const key = `${t.threadId}|${t.latestRunId}|${t.updatedAt}`;
  if (handbackCache.get(t.threadId)?.key === key) return handbackCache.get(t.threadId)!.value;
  let latest: Handback['latest'] = null, call: Handback['call'] = null, cut = false, stop = false, end = t.itemCount || 0;
  // Step back a window at a time, newest first, until a user message (the agent got new input after it) or both are found.
  for (let w = 0, size = 10; w < 14 && !stop && end > 0; w++, size = 40) {
    const after = Math.max(0, end - size), items: MessageItem[] = [];
    let at = after;
    for (let i = 0; i < 6; i++) {
      const page = await tool<MessagesPage>('t3_thread_read', { threadId: t.threadId, view: 'messages', afterPosition: at, limit: 50, maxCharsPerItem: 20000 });
      items.push(...(page.items || []).filter((x) => x.position > after && x.position <= end));
      if (!page.hasMore || (page.items || []).some((x) => x.position > end)) break;
      at = page.nextPosition!;
    }
    for (const item of items.sort((a, b) => b.position - a.position)) {
      if (item.type === 'user_message') { stop = true; break; }
      if (item.type !== 'assistant_message' || !item.text) continue;
      const text = item.text + (item.textTruncated ? '\n\n[The message continues in T3.]' : '');
      if (!latest) latest = { itemId: item.itemId, text };
      // A message T3 cut off may hide decisions, so the Pass cannot know the current call: it shows the message,
      // offers no answer form, and stops there rather than fall back to an older call (PR-Agent r3, r4 on #17).
      if (item.textTruncated) { cut = true; stop = true; break; }
      const calls = parseCalls(item.text);
      if (calls.length) { call = { key: callKey(item.itemId, calls), itemId: item.itemId, text, calls }; stop = true; break; }
    }
    end = after;
  }
  // Out of windows before a user message or a call: whether a call waits further back is not checked (PR-Agent r6 on #17).
  if (!stop && end > 0) cut = true;
  const value = { latest, call, cut };
  handbackCache.set(t.threadId, { key, value });
  return value;
}
// Screenshots the board shows, by id. Only a path an agent's message names is ever served (see /img below).
let shotFiles = new Map<string, string>();
const SHOT_ROOTS = [homedir(), '/tmp', tmpdir()].map(real).filter((r): r is string => !!r);
let status: Status = { ok: false, error: 'signing in to T3', at: Date.now(), ms: 0 };
const clients = new Set<ServerResponse>();

// The thread address T3 gives this sign-in (its hosted link), without the thread id, which T3 URL-encodes in it.
// Read once at start.
let linkBase: string | null = null;
const link = (t: ThreadRow): string => (t.link && t.link.startsWith('http') ? t.link : `${ORIGIN}/${envId}/${t.threadId}`);
const linkFor = (id: string): string | null => (linkBase ? linkBase + encodeURIComponent(id) : null);

// The live stream: a read-only key of its own, T3 Code's /ws, and the shell it keeps current (client/t3live.ts).
const keys = createKeys({ origin: ORIGIN, ...(process.env.YESCHEF_T3_BIN ? { bin: process.env.YESCHEF_T3_BIN } : {}) });
// Reads the stream does not carry, kept until what they depend on changes: a parent the stream does not have
// (until the next snapshot, or until the stream names it), and a thread's waiting questions (until its pending
// request or its update time moves).
const parentCache = new Map<string, ThreadRow>();
// How often the stream has named each thread: a parent read that the stream named while it was on its way is used
// once, never cached (PR-Agent r2 on #76).
const parentMoves = new Map<string, number>();
const live = createLive({ origin: ORIGIN, keys, log: (m) => console.log(m), onChange: (change) => {
  // A parent the stream names again has moved (restored, edited, archived), so its cached read is old (PR-Agent r1 on #76).
  for (const id of change.ids) { parentCache.delete(id); parentMoves.set(id, (parentMoves.get(id) || 0) + 1); }
  // The board stops being current the moment the stream does, even while a refresh is still reading.
  if (!change.live && status.ok) { status = { ok: false, at: Date.now(), ms: 0, error: String(live.why()).slice(0, 200) }; tick(); }
  refreshSoon();
} });
let parentGeneration = -1, projectsRev = -1;
const questionCache = new Map<string, { key: string | null; items: QuestionItem[] }>();
// Changed files and line ranges per thread: a read-only git diff in each thread's folder (client/changes.ts).
// Nothing on the board shows them yet; the team summary and the Overlap and Too big calls read them with
// changes.get(threadId) and changes.subscribe(fn).
const changes = createChanges({ log: (m) => console.log(m) });
// The checks on each followed thread's base branch, and the size of each open PR, from GitHub through the gh CLI
// this Mac is signed in to, read only (client/github.ts). No gh, no answer: "not checked". Nothing shows them yet;
// readers use baseChecks.get(threadId) and prSizes.get(prKey({ host, repo, number })), and subscribe(fn) on each.
const baseChecks = createBaseChecks({ log: (m) => console.log(m), read: (a) => readBaseFacts(a) });
const prSizes = createPrSizes({ log: (m) => console.log(m), read: (a) => readPrFacts(a) });

// Run times for the You view (Dan, 2026-11-10): each thread that ran today, read once per run state. t3_thread_read
// lists a thread's recent runs with their start and end times (runLimit, read on 2026-11-10). A read that fails, or
// more threads than one update reads, leaves run times "not checked" for this update; the board itself stays good,
// and the next update carries on from what it already has.
const runCache = new Map<string, { key: string; value: RunsEntry }>();
// Today's waits on questions, seen update by update: T3's run times hold them (client/you.ts trackWaits).
const waitLog = new Map<string, WaitEntry>();
const RUN_READS = 40;
async function runTimes(threads: ThreadRow[], now: number): Promise<Map<string, RunsEntry> | null> {
  const t0 = dayStart(now);
  const want = threads.filter((t) => mayRunToday(t, t0));
  const out = new Map<string, RunsEntry>();
  let reads = 0, short = false;
  for (const t of want) {
    const key = `${t.latestRunId}|${t.status}`, hit = runCache.get(t.threadId);
    if (hit?.key === key) { out.set(t.threadId, hit.value); continue; }
    if (reads >= RUN_READS) { short = true; continue; }
    reads++;
    try {
      const read = await tool<ThreadRead | null>('t3_thread_read', { threadId: t.threadId, limit: 1, maxCharsPerItem: 1, runLimit: 50 });
      if (!Array.isArray(read?.recentRuns)) { short = true; continue; }
      const value = readRuns(read);
      runCache.set(t.threadId, { key, value });
      out.set(t.threadId, value);
    } catch (ex) {
      if ((ex as Fault).auth) throw ex;
      short = true;
    }
  }
  const keep = new Set(want.map((t) => t.threadId));
  for (const id of [...runCache.keys()]) if (!keep.has(id)) runCache.delete(id);
  return short ? null : out;
}

async function refresh(): Promise<void> {
  const t0 = Date.now();
  try {
    // A cache is never shown as live: without a live, synchronized stream the board says "Not checked".
    if (!live.live()) throw new Error(String(live.why()));
    if (live.projectsRev() !== projectsRev) {
      const rev = live.projectsRev();
      projects = withIcons((await tool<{ projects?: ProjectRow[] }>('t3_project_list', { limit: 100 })).projects || []);
      projectsRev = rev;
    }
    // The board is built from one snapshot generation. If the stream resynchronizes while the reads below wait,
    // this board is from the old one and is not published (PR-Agent r2 on #76).
    const generation = live.generation();
    if (generation !== parentGeneration) { parentCache.clear(); parentMoves.clear(); parentGeneration = generation; }
    // The stream's shells are T3 Code's thread shells: typed as the board reads them (client/shells.ts), not checked.
    const shells = new Map(live.threads().map((s) => [s.id, s as unknown as Shell]));
    const picked = boardThreads([...shells.values()], { now: t0, link: linkFor });
    const byId = new Map(picked.threads.map((t) => [t.threadId, t]));
    // A thread with no project gets null: the stream's project map has no undefined key.
    const followed = changeTargets(picked.threads, shells, live.project as (id: string | undefined) => ProjectShell | null);
    changes.want(followed);
    // A thread the follower has not read yet is a not-checked read, which githubTargets reads as one.
    const github = githubTargets(followed, shells, changes.get as (id: string) => ChangesRead);
    baseChecks.want(github.base);
    prSizes.want(github.prs);
    // A running or waiting station needs its ticket even when that ticket settled long ago. The stream carries
    // every active thread; a parent it lacks is read over MCP, as before. If any stays unresolved, the board
    // is incomplete and the page says "not checked".
    for (let reads = 0; ; ) {
      const missing = [...new Set([...byId.values()].map((t) => t.parentThreadId).filter((id): id is string => !!id && !byId.has(id)))];
      if (!missing.length) break;
      if (reads + missing.length > 200) throw new Error(`${missing.length} parent threads still unread after ${reads} reads`);
      for (const threadId of missing) {
        let row = parentCache.get(threadId);
        if (!row) {
          const moves = parentMoves.get(threadId) || 0;
          const read = await tool<ThreadRead | null>('t3_thread_read', { threadId, limit: 1, maxCharsPerItem: 1 });
          reads++;
          if (!read?.thread) throw new Error(`parent thread ${threadId} could not be read`);
          row = read.thread;
          if ((parentMoves.get(threadId) || 0) === moves) parentCache.set(threadId, row);
        }
        byId.set(threadId, row);
      }
    }
    const threads = [...byId.values()];
    // Pending questions: T3 lists them per thread, and a thread that waits on one still reads "running".
    // Ask for every top-level thread that is not settled and has a run going, plus any marked waiting, but only
    // when its shell says a request is pending, and only again when that request or the thread changes.
    const questions = new Map<string, QuestionItem[]>();
    for (const t of threads.filter((x) => x.status === 'waiting' || (!x.parentThreadId && !x.settled && ['running', 'starting', 'queued', 'preparing'].includes(x.status)))) {
      const shell = shells.get(t.threadId);
      if (shell && !shell.pendingRuntimeRequest) { questionCache.delete(t.threadId); continue; }
      const key = shell ? `${(shell.pendingRuntimeRequest as { id?: unknown }).id}|${shell.updatedAt}` : null;
      let hit = key && questionCache.get(t.threadId);
      if (!hit || hit.key !== key) {
        const ids = (await tool<{ requestIds?: string[] }>('t3_pending_request', { action: 'list', threadId: t.threadId })).requestIds || [];
        const items: QuestionItem[] = [];
        for (const requestId of ids.slice(0, 3)) items.push(...((await tool<{ questions?: Omit<QuestionItem, 'requestId'>[] }>('t3_pending_request', { action: 'read', threadId: t.threadId, requestId })).questions || []).map((q) => ({ ...q, requestId })));
        hit = { key, items };
        if (key) questionCache.set(t.threadId, hit);
      }
      if (hit.items.length) questions.set(t.threadId, hit.items);
    }
    for (const id of questionCache.keys()) if (!shells.has(id)) questionCache.delete(id);
    const words = new Map<string, Handback>();
    // A ticket waiting on Dan's answer to a T3 question also gets its last message, so the question has its
    // context (hill climb r4, Opus and Fable). The walk stops at the last user message, as for hand-backs.
    for (const t of threads.filter((x) => !x.parentThreadId && !x.settled && !x.snoozed && x.latestRunId && (['completed', 'interrupted', 'idle'].includes(x.status) || questions.has(x.threadId)))) {
      words.set(t.threadId, await handback(t));
    }
    const runs = await runTimes(threads, t0);
    // The stream may have dropped, or dropped and come back with a new snapshot, while the reads above waited:
    // then this board is not current either. The refresh that change queued builds the next one.
    if (!live.live()) throw new Error(String(live.why()));
    if (live.generation() !== generation) throw new Error('T3 Code sent a new snapshot during this update; reading it again');
    const waits = trackWaits(waitLog, threads, questions, t0);
    board = buildBoard({ projects, threads, questions, lastWords: words, runs, waits });
    shotFiles = new Map(board.tickets.flatMap((k) => [k.lastWords, k.call?.text]).filter(Boolean)
      .flatMap((text) => imagesIn(text)).filter((im) => !/^https:/i.test(im.src)).map((im) => [imageId(im.src), im.src] as const));
    status = { ok: true, at: Date.now(), ms: Date.now() - t0 };
  } catch (ex) {
    status = { ok: false, at: Date.now(), ms: Date.now() - t0, error: String((ex as Fault).message).slice(0, 200) };
    if ((ex as Fault).auth && pipe && !authLost) { authLost = true; pipe.send({ type: 'auth-lost' }); }
  }
  tick();
}
function tick(): void {
  const data = JSON.stringify({ ok: status.ok, at: status.at, error: status.error || null });
  for (const res of clients) res.write(`event: tick\ndata: ${data}\n\n`);
  if (pipe) pipe.send({ type: 'tick', data });
  // The team's summary follows each board read, and a failed read is news too: it publishes only on change.
  if (status.ok) team.board(board, teamReaders); else team.health(false);
}
// What the team summary reads beside the board (3b PR 4): each thread's changed files, its base branch's checks, and
// each open PR's size. A reader's news republishes the summary, only when it changed.
// This Mac's GitHub login rides in the team summary (French Brigade matches a PR's reviewers to teammates by it). It is
// read from gh's sign-in the first time a summary asks, so a Mac with no team never asks; a failed read is asked again
// on a summary 10 minutes on. Until it is read, the summary says null: not checked.
let ghLogin: string | null = null, ghAskedAt = -Infinity;
const login = (): string | null => {
  if (ghLogin === null && Date.now() - ghAskedAt > 600_000) {
    ghAskedAt = Date.now();
    ghGet('user').then((u) => { ghLogin = loginOf(u && typeof u === 'object' ? (u as { login?: unknown }).login : null); if (ghLogin) team?.readersMoved?.(); }, () => {});
  }
  return ghLogin;
};
const teamReaders: Readers = { changes: (id) => changes.get(id), base: (id) => baseChecks.get(id), pr: (x) => prSizes.get(prKey(x)), login };
for (const r of [changes, baseChecks, prSizes]) r.subscribe(() => team?.readersMoved?.());

// Never two refreshes at once: a change during one queues one more. A burst of changes is gathered for 150 ms.
let refreshing: Promise<void> | null = null, again = false, soonTimer: NodeJS.Timeout | null = null;
function kick(): void {
  if (!t3) return;  // still signing in: the first refresh runs once the MCP sign-in is ready
  if (refreshing) { again = true; return; }
  refreshing = refresh().finally(() => { refreshing = null; if (again) { again = false; kick(); } });
}
function refreshSoon(): void { if (!soonTimer) soonTimer = setTimeout(() => { soonTimer = null; kick(); }, 150); }

// The prototype's own rules, after the base sheet (client/pass.css).
const APP_CSS = `
/* No phone build (Dan, 2026-11-11): at phone width the page shows one screen that points to the Mac app or a computer.
   The Mac app's window never gets this narrow (desktop/main.ts, minWidth 960). */
.only-phone{display:none}
@media (max-width:760px){
  body.pass-app>:not(.only-phone){display:none!important}
  .only-phone{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;min-height:100dvh;padding:24px 16px;text-align:center}
  .only-phone .op-logo{display:grid;place-items:center;width:64px;height:64px;margin-bottom:8px;border-radius:15px;color:#fff;background:linear-gradient(180deg,#3B9BFF,#0066D6);box-shadow:inset 0 0 0 .5px rgba(0,0,0,.12)}
  .only-phone .op-logo svg{width:36px;height:36px}
  .only-phone h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-.01em}
  .only-phone .btn{margin-top:8px;min-width:220px;text-decoration:none}
  .only-phone p{margin:0;font-size:15px;color:var(--label2)}
}
.pm.pimg{object-fit:contain;background:transparent;border-radius:4px}
.call-tile .ct-top .chip{margin-left:2px}
.prose.last{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;padding:10px 12px;border-radius:10px;background:var(--card);font-size:14px;max-height:320px;overflow:auto}
.prose.last code{font:12px var(--mono);padding:1px 4px;border-radius:4px;background:var(--fill)}
.prose.last ul{margin:2px 0 10px;padding-left:1.2em;white-space:normal;list-style:disc}
.rows .prose.last li,.rows .prose.last li+li{padding:0;border-top:0;margin:2px 0}
form.act{display:flex;flex-direction:column;gap:10px;margin-top:10px}
.q-set{margin:0;padding:0;border:0;display:flex;flex-direction:column;gap:8px}
.q-set legend{margin-bottom:6px;font-weight:600}
label.opt{gap:12px;cursor:pointer}
label.opt input[type=radio]{width:18px;height:18px;margin:0;accent-color:var(--accent);flex:none}
label.opt:has(input:checked){background:var(--blue-t);box-shadow:inset 0 0 0 2px var(--accent)}
label.opt .custom{flex:1;min-width:0;border:0;background:transparent;font:inherit;color:inherit}
.acts{display:flex;flex-wrap:wrap;gap:8px}
.acts .btn{min-height:44px}
.plate-foot{flex:none;padding:12px 32px 16px;border-top:.5px solid var(--sep);background:var(--card)}
.plate-foot form.act{margin-top:0}
.plate-foot .note textarea{background:var(--fill);box-shadow:inset 0 0 0 .5px var(--sep)}
.gate-top{display:none}
.head-b{overflow-x:hidden}
.plate .prose.last.full{max-height:none}
.prose.last a{color:var(--link)}
.prose.last a .ic{width:12px;height:12px;vertical-align:-1px}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin:4px 0 12px}
.shot{display:flex;flex-direction:column;gap:6px;color:var(--label2);font-size:12px;line-height:1.35;text-decoration:none}
.shot img{display:block;width:100%;height:220px;object-fit:contain;border-radius:8px;background:var(--fill);box-shadow:inset 0 0 0 .5px var(--sep)}
.shot:hover img{box-shadow:inset 0 0 0 2px var(--accent)}
.by-msg .rec{margin-left:6px;vertical-align:1px}
.by-msg form.act .note textarea{background:var(--fill)}
.since .row-h b,.msg-h b{font-size:13px;font-weight:500;color:var(--label2)}
.by-msg .shots{margin-top:12px}
.msg-h{margin-top:16px}
.call-tile .q,.call-tile .pick{overflow-wrap:anywhere;min-width:0}
.call-tile .ct-foot .gate{flex:none}
body>.netstrip{position:sticky;top:0;z-index:8;margin:0 24px}
/* ===== Yes Chef desktop round 1 (Dan, 2026-11-07): two views, one ticket view, no page scroll. ===== */
/* Scroll bars: thin, and only while something scrolls (the page script adds .scrolling for a moment). */
*::-webkit-scrollbar{width:7px;height:7px;background:transparent}
*::-webkit-scrollbar-track,*::-webkit-scrollbar-corner{background:transparent}
*::-webkit-scrollbar-thumb{border:2px solid transparent;border-radius:4px;background:transparent;background-clip:padding-box}
.scrolling::-webkit-scrollbar-thumb,*::-webkit-scrollbar-thumb:active{background-color:rgba(128,128,128,.6)}
/* "hidden" always hides, whatever display a class sets (council 1b, Fable: .folder{display:flex} beat it). */
[hidden]{display:none!important}
/* Lists fade out toward their bottom edge while more waits below, and each card recedes as it nears that edge.
   Council 1b: gentler, so the next ticket stays readable. */
.fade-end{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 44px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 44px),transparent)}
/* The message fades over 28 px, so a screenshot caption near the end stays readable (Fable r6, Sol r6). */
.plate-scroll.fade-end{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 28px),transparent)}
@supports (animation-timeline:view()){
  @media (prefers-reduced-motion:no-preference){
    .folder>.tile{animation:recede linear both;animation-timeline:view();animation-range:entry 0% entry 100%}
  }
}
@keyframes recede{from{opacity:.55}}
.folder>.tile{scroll-margin-bottom:48px}
@media (hover:none){.btn kbd,.head-keys{display:none}}
/* The logo is the view switch: white on blue at the pass, blue on white in the full kitchen. */
.brand{display:flex}
.logo{position:relative;width:34px;height:34px;padding:0;border:0;border-radius:9px;background:none;box-shadow:none;cursor:pointer;perspective:240px}
.logo:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.flip{position:absolute;inset:0;transform-style:preserve-3d}
.face{position:absolute;inset:0;display:grid;place-items:center;border-radius:9px;-webkit-backface-visibility:hidden;backface-visibility:hidden}
/* The cloche spans 70% of the tile, as on the app icon (Dan, 2026-11-07). The cloche sits 1.075 units below the middle
   of its 24-unit box, so the box is lifted to centre the cloche itself, as the Dock icon and Apple's own app icons do
   (measured 2026-11-08). 1.5 px, not 1.39: a whole step on a 2x screen keeps the edges as sharp as before. */
.face .ic{position:relative;top:-1.5px;width:31px;height:31px}
.f-pass{color:#fff;background:linear-gradient(180deg,#3B9BFF,#0066D6);box-shadow:inset 0 0 0 .5px rgba(0,0,0,.12)}
.f-kitchen{color:#0071E3;background:#fff;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.14);transform:rotateY(180deg)}
.v-kitchen .flip{transform:rotateY(180deg)}
/* One ticket view, wherever it shows. */
.plate{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;width:auto;max-width:none;max-height:none;padding:0;border:0;border-radius:0;background:none;box-shadow:none;overflow:hidden;container-type:inline-size;animation:none}
.plate-main{flex:1;min-height:0;display:flex;flex-direction:column}
.plate-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:22px 28px 28px}
.plate-t{margin:0 0 14px;font-size:24px;line-height:1.18;font-weight:700;letter-spacing:-.022em}
.msg .prose.last{margin:0 0 14px;padding:0;background:none;max-height:none;overflow:visible;font-size:14.5px;line-height:1.55}
.msg .msg-h{margin:0 0 10px;font-size:13px;color:var(--label2)}
.msg .msg-h b{color:var(--label);font-weight:600}
.msg .msg-h a{margin-left:6px}
.more{margin-top:14px;border-top:.5px solid var(--sep);padding-top:10px}
.more summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--label2);list-style-position:inside}
.links{display:flex;flex-direction:column;gap:8px;margin:10px 0 0;padding:0;list-style:none;font-size:14px}
.links li{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}
.links .muted{font-size:12px}
.dock{flex:none;max-height:60%;overflow-y:auto;overscroll-behavior:contain;padding:14px 28px 16px;border-top:.5px solid var(--sep);background:var(--card)}
.dock-k{margin:0 0 8px}
.dock-who{margin:0 0 6px;font-size:13px;color:var(--label2)}
.dock-done{margin:0;font-size:14px;color:var(--green)}
.dock form.act{margin-top:0;gap:12px}
.dock form.act+form.act{margin-top:16px;padding-top:16px;border-top:.5px solid var(--sep)}
/* A Retry box over the second question form takes the line between the forms, so it reads as that form's (hill climb 2 r9). */
.dock form.act+.retry{margin:12px 0 0}
.dock .retry+form.act{margin-top:16px;padding-top:16px;border-top:.5px solid var(--sep)}
.dock form.act.held .abar{display:none}
/* While another form's Retry holds the ticket, a free form's send is not filled, so one blue action shows (hill climb 2 r11). */
.dock:has(form.act.held) form.act:not(.held) .ab.fill.primary{background:var(--fill);color:var(--label)}
/* With two free forms, only the one the keys go to is filled and shows its keys (r14, Sol and Astra). */
.dock form.act.aside .ab.fill{background:var(--fill);color:var(--label)}
/* With the Retry held, focus in a free form moves the blue there from the Retry box, with Cmd+Enter (r15, Astra). */
.dock:has(form.act.held) form.act.keyto .ab.fill.primary{background:var(--accent);color:#fff}
.dock:has(form.act.keyto) .retry .btn.fill{background:var(--fill);color:var(--label)}
.dock form.act.aside .tip kbd,.dock form.act.aside .tip .or{display:none}
.dock .q-set legend{margin-bottom:8px;font-size:16px;font-weight:600;line-height:1.3;color:var(--label)}
.dock label.opt{padding:10px 12px;border-radius:10px;background:var(--card2);font-size:14px;line-height:1.4}
.dock .note textarea{min-height:52px;background:var(--fill)}
.btn.quiet{background:none;color:var(--label2);padding:0 10px}
.btn.quiet:hover{background:var(--fill);color:var(--label)}
.dock .result:empty{display:none}
.dock .result{margin:0;font-size:13px}
#plates{display:none}
.retry{display:flex;flex-direction:column;gap:8px;margin:0 0 14px}
.retry .result{margin:0;font-size:13px}
/* The Retry button is as wide as its words, like the send it repeats, not the whole dock (r15, Fable). */
.retry>[data-retry]{align-self:flex-start}
.is-stale .head-b>.folder,.is-stale .fx-wrap,.is-stale .segbar{visibility:hidden}
.is-stale .stats b,.is-stale .nf .n,.is-stale .head .badge,.is-stale .pmenu-l .n{visibility:hidden}
/* The hidden list says why it is empty. */
.is-stale .head-b::before{content:"Not checked. The list returns with the next update.";display:block;padding:24px 12px;text-align:center;font-size:13px;color:var(--label2)}
.tile.sel,.call-tile.sel{box-shadow:inset 0 0 0 2px var(--accent)}
.tile.gone{display:none}
/* A list a refresh just redrew (the page script's prime()): its cards take their hover at once, with no fade. */
.fresh .tile{transition:none}
/* The open ticket over the kitchen. */
dialog.sheet{width:min(1120px,calc(100vw - 48px));height:min(920px,calc(100dvh - 48px));max-width:none;max-height:none;padding:0;border:0;border-radius:22px;background:var(--card);color:var(--label);box-shadow:var(--sh4);overflow:hidden}
dialog.sheet[open]{display:flex;flex-direction:column;animation:rise .28s cubic-bezier(.2,.8,.2,1)}
dialog.sheet::backdrop{background:rgba(0,0,0,.36);-webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px)}
.reader .plate .close{display:none}
/* Screenshots open here, not in the browser. */
#viewer{--v-bg:rgba(0,0,0,.9);--v-fg:#fff;--v-cap:rgba(255,255,255,.85);--v-btn:rgba(255,255,255,.14);--v-btn-hover:rgba(255,255,255,.24);--v-key:rgba(255,255,255,.6);width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:var(--v-bg);color:var(--v-fg)}
#viewer[open]{display:grid;grid-template-rows:minmax(0,1fr) auto}
#viewer::backdrop{background:transparent}
#viewer img{width:100%;height:100%;object-fit:contain;padding:28px 72px 8px;box-sizing:border-box}
/* Previous, caption and next sit centred under the image; keys and close sit at the right (hill climb 2 r7, Opus). */
#viewer .v-bar{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,max-content) auto minmax(0,1fr);align-items:center;gap:16px;padding:10px 24px 18px;font-size:14px}
#viewer .v-bar [data-v=prev]{grid-column:2}
#viewer .v-cap{grid-column:3;min-width:0;text-align:center;color:var(--v-cap)}
#viewer .v-bar [data-v=next]{grid-column:4}
#viewer .v-end{grid-column:5;justify-self:end;display:flex;align-items:center;gap:16px}
#viewer .v-keys{font-size:12px;color:var(--v-key);white-space:nowrap}
#viewer .v-keys kbd{font:inherit;padding:1px 5px;border-radius:6px;background:var(--v-btn);color:var(--v-fg)}
#viewer button{min-width:40px;height:40px;border:0;border-radius:20px;background:var(--v-btn);color:var(--v-fg);font:inherit;font-size:18px;cursor:pointer}
#viewer button:hover{background:var(--v-btn-hover)}
#viewer button[hidden]{visibility:hidden;display:inline-block}
/* Sends wait here a few seconds with Undo, then report. */
.btn.armed{box-shadow:inset 0 0 0 2px var(--accent)}
/* Round 1c (Dan, 2026-11-07): Settings like Gmail's. Density for the lists. */
.gear{display:grid;place-items:center;width:36px;height:36px;margin-left:8px;padding:0;border:0;border-radius:10px;background:var(--fill);color:var(--label2);cursor:pointer}
.gear:hover{color:var(--label)}
.gear .ic{width:19px;height:19px}
#settings{border:0;border-radius:18px;background:var(--card);color:var(--label);box-shadow:var(--sh4)}
#settings::backdrop{background:rgba(0,0,0,.36);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
#settings h2{margin:0 0 14px;font-size:17px}
#settings fieldset{margin:0 0 18px;padding:0;border:0}
#settings legend{margin-bottom:8px;font-size:13px;font-weight:600;color:var(--label2)}
#settings .set-done{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:var(--label2)}
/* Density: Comfortable shows one summary line; Compact shows the title alone. */
html.d-comfortable .call-tile{gap:6px;padding:11px 14px 10px}
html.d-comfortable .call-tile .pick{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden}
html.d-compact .call-tile{gap:3px;padding:8px 12px}
html.d-compact .call-tile .ct-foot{display:none}
html.d-compact .call-tile .q{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden;font-size:14.5px}
html.d-compact .folder{gap:6px}
html.d-compact .folder>.tile:not(.call-tile) .meta{display:none}
/* The note folds away until R, F, N, Note, or an armed Reply or Request changes asks for it. */
.dock form.act:not(.noting) .note{display:none}
/* Every ticket's actions sit in one bar under the message (Dan, 2026-11-10: the Side panel layout is gone). */
html .plate .plate-main{display:flex;flex-direction:column}
html .plate .dock{max-height:55%;border-left:0;border-top:.5px solid var(--sep);padding:12px 28px 14px}
.plate .dock-plain .dock-k{display:none}
/* Options as equal cards in a row (they wrap to more rows as they need). */
html .plate .dock .q-set{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px}
html .plate .dock .q-set legend{width:100%}
/* With the full width, screenshots show larger. */
html .plate .shots{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
html .plate .shot img{height:340px}
.okey{font-weight:600;color:var(--label2);margin-right:2px}
#toast{inset:auto auto 44px 18px;margin:0;display:none;align-items:center;gap:14px;max-width:min(560px,calc(100vw - 32px));padding:10px 10px 10px 16px;border:0;border-radius:12px;background:var(--toast-bg);color:var(--toast-fg);box-shadow:0 10px 30px rgba(0,0,0,.35),0 0 0 .5px var(--toast-line);font-size:14px;line-height:1.35}
#toast:popover-open{display:flex}
/* Its own open ticket shows the same Retry in its box, so the toast steps aside there (hill climb 2 r12). */
#toast.mine:popover-open{display:none}
#toast .t-msg{flex:1}
#toast.counting::after{content:"";position:absolute;left:14px;right:14px;bottom:5px;height:2px;border-radius:1px;background:var(--toast-bar);transform-origin:left center;animation:undo-left var(--undo-ms,4000ms) linear forwards}
@keyframes undo-left{to{transform:scaleX(0)}}
/* The toast is a dark surface in both themes, so it takes the dark values of the red and link tokens (hill climb 2 r4, Astra). */
#toast{--red:#FF938A;--link:#5AA9FF;--toast-bg:#2C2C2E;--toast-fg:#F5F5F7;--toast-line:rgba(255,255,255,.12);--toast-hover:rgba(255,255,255,.1);--toast-key:rgba(255,255,255,.16);--toast-bar:rgba(255,255,255,.35)}
#toast.bad .t-msg{color:var(--red)}
#toast button{flex:none;min-height:32px;padding:0 10px;border:0;border-radius:8px;background:none;color:var(--link);font:inherit;font-weight:600;cursor:pointer}
#toast button:hover{background:var(--toast-hover)}
#toast button kbd{margin-left:8px;background:var(--toast-key);color:var(--toast-fg)}
/* The stage list beside the pass. */
.stagenav{display:none}
.nf{display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:0 12px;border:0;border-radius:10px;background:none;color:var(--label);font:inherit;font-size:14px;font-weight:500;text-align:left;cursor:pointer}
.nf:hover{background:var(--fill)}
.nf[aria-current]{background:var(--fill);font-weight:600}
.nf .ic{width:18px;height:18px;color:var(--pass);flex:none}
.nf .gd{flex:none;margin:0 5px}
.nf .n{margin-left:auto;font-size:13px;color:var(--label2);font-variant-numeric:tabular-nums}
/* An empty stage steps back, so the eye goes to the stages with work. */
.nf.zero{color:var(--label2)}
.nf.zero .gd{opacity:.45}
.nf.zero .n{opacity:.5}
.nf[data-folder=pass]{margin-bottom:8px;font-weight:600}
/* Round 1b (Dan, 2026-11-07): the line in one card, Merged nearest the pass; off the line in its own card. */
.nav-card{display:flex;flex-direction:column;gap:2px;margin-bottom:12px;padding:6px;border-radius:14px;background:var(--card);box-shadow:inset 0 0 0 .5px var(--sep)}
.nav-card .nf{min-height:34px}
/* Tables in an agent's message. */
.prose table.md{display:block;max-width:100%;overflow-x:auto;margin:6px 0 14px;border-collapse:collapse;white-space:normal;font-size:13.5px}
.prose table.md th,.prose table.md td{padding:6px 12px 6px 0;border-bottom:.5px solid var(--sep);text-align:left;vertical-align:top}
.prose table.md th{font-weight:600;color:var(--label2);font-size:12.5px}
/* Tickets in a list stand apart. */
.folder{display:flex;flex-direction:column;gap:8px}
/* Every action shows its key. */
.btn kbd{display:inline-block;margin-left:8px;padding:0 5px;border-radius:5px;background:var(--fill);font:600 11px/18px var(--sans);color:var(--label2);letter-spacing:.02em}
.btn.fill kbd{background:rgba(255,255,255,.22);color:#fff}
#toast kbd{display:inline-block;min-width:20px;padding:0 5px;border-radius:5px;background:var(--fill);font:600 11px/20px var(--sans);text-align:center;color:var(--label)}
.reader{display:none}
.reader-empty[hidden]{display:none}
.reader-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--label2)}
.reader-empty .ic{width:40px;height:40px}
/* Desktop: the page fits the window like a mail client. Nothing scrolls but the lists inside it. */
@media (min-width:761px){
  html,body{height:100%}
  body{overflow:hidden}
  #app{height:100vh;height:100dvh;display:flex;flex-direction:column}
  .bar{flex:none}
  .board{flex:1;min-height:0;padding:6px 24px 10px}
  .head{height:auto;min-height:0}
  /* 300 px up to 1366 px; over 1366 px a later rule makes it 19.5vw (about 281 px at 1440), so the stages get room for 4-line titles (hill climb 2 r12 and r13, Opus, Fable). */
  /* You, expanded (Dan, 2026-11-10, views mock v4): the stage list stays on the left; your threads fill the middle, The Pass sits right. */
  .v-kitchen .board{display:grid;grid-template-columns:208px minmax(0,1fr) clamp(300px,22vw,360px);grid-template-rows:minmax(0,1fr);grid-template-areas:"nav you head";gap:0 16px}
  .v-kitchen .you{grid-area:you;min-width:0;min-height:0}
  .v-kitchen .team-wait{grid-area:you}
  .v-kitchen .head{grid-area:head}
  /* 208 px, not 200: "Ready to merge" (dev words, 2026-11-10) needs 106 px in the Mac's font, and 200 wrapped it. */
  .v-pass .board{display:grid;grid-template-columns:208px minmax(300px,380px) minmax(0,1fr);grid-template-rows:minmax(0,1fr);grid-template-areas:"nav list read";gap:0}
  :is(.v-pass,.v-kitchen) .stagenav{margin-right:16px}
  /* The pass and the open ticket are one window: no gap, one frame; the selected ticket joins the reader. */
  .v-pass .head{border-radius:22px 0 0 22px;background:var(--inset);box-shadow:inset 0 0 0 .5px var(--sep)}
  /* The seam is the list's own right edge, painted under the cards, so the selected card covers it and runs into the reader. */
  /* The list's scroll bar sits on its left edge, so the right edge stays free for the selected card to meet the reader. */
  .v-pass .head-b{padding:0 0 12px 12px;direction:rtl}
  .v-pass .head-b>*{direction:ltr}
  .v-pass .head-h{padding-right:22px}
  .v-pass .folder>.tile{width:auto;margin-right:12px;background:var(--card);box-shadow:inset 0 0 0 .5px var(--sep)}
  .v-pass .folder>.tile.sel{position:relative;margin-right:0;border-radius:14px 0 0 14px;background:var(--card);box-shadow:inset 3px 0 0 var(--accent),inset 0 .5px 0 var(--sep),inset 0 -.5px 0 var(--sep)}
  .v-pass .head-keys{padding-right:22px}
  :is(.v-pass,.v-kitchen) .stagenav{grid-area:nav}
  .v-pass .head{grid-area:list}
  .v-pass .reader{grid-area:read}
  .v-pass .you,.v-pass .team-wait{display:none}
  :is(.v-pass,.v-kitchen) .stagenav{display:flex;flex-direction:column;gap:2px;min-height:0;overflow-y:auto;padding-top:4px}
  .v-pass .reader{display:flex;min-width:0;min-height:0;border-radius:0 22px 22px 0;background:var(--card);box-shadow:inset 0 .5px 0 var(--sep),inset -.5px 0 0 var(--sep),inset 0 -.5px 0 var(--sep);overflow:hidden}
  .v-pass .head::before{display:none}
}
/* ===== Round 2 (Dan, 2026-11-07): fewer nested colours, Linear-style rounded cards, one settings window. ===== */
/* The pass and the open ticket are one panel; ticket cards take the app's own background, so colours do not stack. */
@media (min-width:761px){
  .v-pass .head{background:var(--card);box-shadow:inset 0 0 0 .5px var(--sep)}
  .v-pass .folder>.tile{background:var(--bg);box-shadow:inset 0 0 0 .5px var(--sep)}
  .v-pass .folder>.tile:hover{box-shadow:inset 0 0 0 .5px var(--sep),var(--sh1)}
  .v-pass .folder>.tile.sel{background:var(--card);box-shadow:inset 3px 0 0 var(--accent),inset 0 .5px 0 var(--sep),inset 0 -.5px 0 var(--sep)}
  .v-pass .head-b{padding-bottom:12px}
}
/* The open ticket: no full-width rules. The header floats, sections are rounded cards inset from the panel edge,
   and the actions sit in a rounded card of their own (radius 16 inside the panel's 22, with a 12 px inset). */
.plate-bar{border-bottom:0;min-height:0;padding:16px 16px 4px 28px}
.plate-scroll{padding:12px 28px 20px}
.more{margin-top:16px;padding:10px 14px;border:0;border-radius:14px;background:var(--bg)}
.more[open]{padding-bottom:14px}
.dock label.opt{background:var(--card)}
.dock .note textarea{background:var(--card)}
dialog.sheet .plate-bar{padding-right:12px}
/* The kitchen's Merged column: Verified is pinned to its foot, folded by default, with full-width cards. */
/* Settings: sections on the left, like Linear. */
#settings{width:min(720px,calc(100vw - 32px));padding:0}
.set-wrap{display:grid;grid-template-columns:170px minmax(0,1fr);height:min(640px,80vh)}
.set-nav{display:flex;flex-direction:column;gap:2px;padding:20px 10px;background:var(--bg);border-radius:18px 0 0 0}
.set-nav h2{margin:0 10px 12px;font-size:15px}
.set-tab{padding:8px 10px;border:0;border-radius:8px;background:none;color:var(--label);font:inherit;font-size:14px;text-align:left;cursor:pointer}
.set-tab:hover{background:var(--fill)}
.set-tab[aria-current]{background:var(--fill2);font-weight:600}
.set-panes{padding:20px 22px;max-height:min(640px,80vh);overflow-y:auto}
.keylist{display:grid;grid-template-columns:84px 1fr;gap:10px 16px;margin:0;font-size:14px}
.kgroup{margin:0 0 10px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--label2)}
.keylist+.kgroup{margin-top:20px}
.keylist dt{white-space:nowrap}.keylist dd{margin:0;color:var(--label2)}
.keylist kbd{display:inline-block;min-width:20px;padding:0 5px;border-radius:5px;background:var(--fill);font:600 11px/20px var(--sans);text-align:center;color:var(--label)}
#settings .set-done{margin:0;padding:12px 22px 14px;border-top:.5px solid var(--sep)}
/* New thread in T3 Code. */
#launch{width:min(620px,calc(100vw - 32px));padding:20px 22px 16px;border:0;border-radius:18px;background:var(--card);color:var(--label);box-shadow:var(--sh4)}
#launch::backdrop{background:rgba(0,0,0,.36);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
#launch h2{margin:0 0 14px;font-size:17px}
#launch form{display:flex;flex-direction:column;gap:12px;margin:0}
.lf{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600;color:var(--label2)}
.lf select,.lf textarea,.lf input{padding:9px 12px;border:0;border-radius:10px;background:var(--bg);color:var(--label);font:15px/1.4 var(--sans);box-shadow:inset 0 0 0 .5px var(--sep)}
.lf textarea{min-height:140px;resize:vertical}
.lf-ws{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0;padding:0;border:0;font-size:14px}
.lf-ws legend{width:100%;margin-bottom:6px;padding:0;font-size:13px;font-weight:600;color:var(--label2)}
.lf-ws label{display:flex;align-items:center;gap:7px}
.lf-ws input{accent-color:var(--accent)}
#launch .acts .primary{flex:0 0 auto;min-width:140px}
#launch .result:empty{display:none}
.lf-note{margin:0;font-size:12px}
/* ===== Hill climb round 1 (council: Opus, Fable, Sol, Astra) ===== */
/* Names ellipsise instead of being cut; titles wrap anywhere; facts are spaced, never joined by dots. */
.proj{min-width:0}
.proj .pn{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tile .t{overflow-wrap:anywhere}
.tile .meta{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px}
/* Pass cards: the stage in the top row with its dot, the summary in two lines, no repeated header line. */
@media (min-width:761px){
  .call-tile .ct-top .gate-top{display:inline-flex;align-items:center;gap:6px;margin-left:auto;font-size:12px;color:var(--label2);white-space:nowrap}
  .call-tile .ct-top .gate-top .gd{margin:0}
  .call-tile .ct-top .gate-top+.age{margin-left:10px}
  .call-tile .ct-foot .gate{display:none}
  html.d-default .call-tile .pick{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
  .v-pass .head-h>.muted{display:none}
  .v-pass .head-h{padding-bottom:10px}
  .v-pass .board{grid-template-columns:208px clamp(300px,27vw,380px) minmax(0,1fr)}
  .v-pass .head-b,.plate-scroll{scrollbar-gutter:stable}
}
/* The pull requests sit under the title as chips; a ticket still cooking says where it stands. */
.pr-row{display:flex;flex-wrap:wrap;gap:8px;margin:-4px 0 14px}
.prc{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;background:var(--bg);box-shadow:inset 0 0 0 .5px var(--sep);font-size:13px;font-weight:500;color:var(--label);text-decoration:none}
.prc:hover{box-shadow:inset 0 0 0 .5px var(--sep),var(--sh1)}
.prc i{width:7px;height:7px;border-radius:50%;background:var(--gray)}
.prc.t-amber i{background:var(--orange)}.prc.t-green i{background:var(--green)}
.prc span{color:var(--label2);font-weight:400}
.prc .ic{width:12px;height:12px;color:var(--label2)}
.status-line{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 14px;font-size:14px;color:var(--label2)}
/* Actions follow a short message instead of waiting at the window's foot; a long one pushes them to the bottom. */
html .plate .plate-scroll{flex:0 1 auto}
/* Hill climb r5 (Opus): a question card's recommendation on one line, its ticket on its own quiet line. */
.call-tile .ct-rec{display:block;font-size:13px;line-height:1.35;color:var(--label);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.call-tile .pick.ct-title{display:block;-webkit-line-clamp:unset;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px;color:var(--label2)}
/* A screenshot that cannot load says so instead of a broken box. */
.shot-missing{display:block;margin:6px 0 10px;padding:10px 12px;border-radius:10px;background:var(--fill);font-size:12px;white-space:nowrap;color:var(--label2)}
/* The reader's stage reads like the cards': a dot and the word. */
.plate-bar .stg{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--label2)}
.plate-bar .stg .gd{margin:0}
/* Three options fit one row where they can; reading lines stop near 80 characters ("ch" is a zero's width, wider than the average letter). */
html .plate .dock .q-set{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.msg .prose.last{max-width:60ch}
/* A screenshot inside the message, where the agent put it. */
.prose .shot{max-width:min(100%,560px);margin:8px 0 12px;white-space:normal}
.prose .shot img{height:auto;max-height:min(420px,40vh);object-fit:contain;object-position:left top}
.prose .shot span{color:var(--label2)}
/* An option's description sits on its own line under the label and chip, at every width (Fable r4). */
label.opt .opt-t .muted{display:block;margin-top:2px;font-size:13px;font-weight:400;line-height:1.35}
/* Header counts live in the kitchen; the pass view's stage list already carries them (Opus r4). */
@media (min-width:761px){ :is(.v-pass,.v-kitchen) .bar .stats{visibility:hidden} }
/* Header counts are plain text, not chips: they do nothing when clicked (Fable). */
@media (min-width:761px){ .stats .stat{padding:0;background:none} .stats{gap:18px} }
/* The link blue reads at 5.7:1 on the cards in dark mode; the accent was 3:1 (Astra r6). */
.recs{color:var(--label);font-weight:600}
.prose.last code{font-size:13px}
/* An option never runs past its card (a long address wraps). */
label.opt{min-width:0;max-width:100%}
.opt-t{min-width:0;overflow-wrap:anywhere}
.opt-t a{color:var(--link)}
/* A ticket sheet fits its content. */
dialog.sheet{height:fit-content;max-height:min(920px,calc(100dvh - 48px))}
/* The kitchen in the same style as the pass: one card look, no glow. */
.v-kitchen .head::before{display:none}
.v-kitchen .head .call-tile{background:var(--bg);box-shadow:inset 0 0 0 .5px var(--sep)}
@media (min-width:1367px){ .v-kitchen .board{grid-template-columns:208px minmax(0,1fr) clamp(280px,19.5vw,360px)} }
/* A card's model shows whole or not at all: a column too narrow for it drew "O." (Dan's screenshot, 2026-11-10). */
@container (max-width:150px){ .tile .tile-top .mdl{display:none} }
.status-why{margin:-6px 0 14px;font-size:14px;color:var(--label2)}
.btn.armed.fill{box-shadow:none}
.dock .btn.quiet.fill,.btn.quiet.fill{background:var(--accent);color:#fff}
.btn.quiet.fill kbd{background:rgba(255,255,255,.22);color:#fff}
/* Round 2 polish (council). */
.lf .muted{font-weight:400}
.lf select{-webkit-appearance:none;appearance:none;padding-right:36px;background:var(--bg) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238e8e93' stroke-width='2'><path d='m6 9 6 6 6-6'/></svg>") no-repeat right 12px center/16px}
.tile .tile-top .age{margin-left:auto;font-size:12px;color:var(--label2);white-space:nowrap}
.tile .tile-top .age+.at-ic{margin-left:6px}
.more-st{margin-top:8px}
.more-st summary{cursor:pointer;font-size:13px;color:var(--link)}
/* The views morph into each other after the logo turns. */
.head{view-transition-name:pass}
.reader{view-transition-name:reader}
/* One curve and one length for every part of the change, the logo's turn included (MOTION_MS in the script). */
::view-transition-group(*){animation-duration:.7s;animation-timing-function:cubic-bezier(.65,0,.35,1)}
/* Snapshots are clipped to their moving boxes, never stretched (a stage name must not balloon into a column).
   The old view fades out over the first half; the new one fades in under it, overlapping, so nothing doubles up. */
::view-transition-group(*){overflow:hidden}
::view-transition-old(*),::view-transition-new(*){height:100%;width:100%;object-fit:none;object-position:left top}
@keyframes vt-out{to{opacity:0}}
@keyframes vt-in{from{opacity:0}}
::view-transition-old(*){animation:vt-out .32s cubic-bezier(.4,0,1,1) both}
::view-transition-new(*){animation:vt-in .46s cubic-bezier(0,0,.2,1) .22s both}
::view-transition-old(root),::view-transition-new(root){object-fit:fill}
/* The logo is live during the change: no snapshot, no cross-fade, so its turn shows as it happens. */
.logo{view-transition-name:logo}
::view-transition-old(logo){display:none}
::view-transition-new(logo){animation:none}
::view-transition-group(logo){animation:none}
@media (prefers-reduced-motion:reduce){::view-transition-group(*){animation-duration:0s}}
/* ===== Hill climb 2, round 1 (rubric v1.1 and Dan's directions, 2026-11-07) ===== */
/* One green: an open pull request, a working station and Verified share it. One colour per pull request state. */
:root{--open:var(--green);--open-t:var(--green-t)}
/* One blue for "needs you": the cloche, the stage dot, the chip and the count share it (hill climb 2 r4, Fable). */
:root{--pass:var(--blue)}
.t-open{color:var(--open)}
.prc.t-open i{background:var(--open)}.prc.t-merged i{background:var(--merged)}.prc.t-closed i{background:var(--closed)}
/* AA contrast: the key on a filled button (was 3.3:1) and an empty stage's count (was 2.1:1). */
.btn.fill kbd,.btn.quiet.fill kbd{background:rgba(0,0,0,.26);color:#fff}
.nf.zero .n{opacity:1}
/* No glow behind the pass; "The Pass" is a small label, so the open ticket's title is the one headline. */
.head::before{display:none}
.head-h h2{gap:6px;font-size:14px;font-weight:600;letter-spacing:0;color:var(--label2)}
.head-h h2 .ic{width:16px;height:16px;color:var(--pass)}
.head .badge{min-width:20px;height:20px;padding:0 6px;border-radius:999px;font-size:12px}
/* No full-width lines: the Verified fold and the Settings foot stand apart by space. */
/* Settings sits in the middle of the window, as T3 Code's dialogs do (16 px clear on every side), and never runs past
   its edge (Dan, 2026-11-10). It keeps one height for every tab, so switching never moves it; the tab scrolls inside,
   with a fade at its foot while more waits below. */
#settings[open]{display:grid;grid-template-columns:168px minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;height:min(720px,calc(100dvh - 32px));max-height:calc(100dvh - 32px);margin:auto}
#settings .set-wrap{display:contents}
#settings .set-nav{grid-row:1/3;border-radius:16px 0 0 16px}
#settings .set-panes{grid-column:2;min-height:0;max-height:none;padding:20px 24px 8px}
#settings .set-done{grid-column:2;padding:8px 24px 20px;border-top:0}
/* Native controls, styled: round options, no resize grips, one chevron for every fold. */
label.opt input[type=radio],.lf-ws input[type=radio]{-webkit-appearance:none;appearance:none;flex:none;width:18px;height:18px;margin:0;border-radius:50%;background:var(--card);box-shadow:inset 0 0 0 1.5px var(--label2);cursor:pointer;transition:box-shadow .15s}
label.opt input[type=radio]:checked,.lf-ws input[type=radio]:checked{background:#fff;box-shadow:inset 0 0 0 5px var(--accent)}
label.opt input[type=radio]:focus-visible,.lf-ws input[type=radio]:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.more>summary,.more-st>summary{display:flex;align-items:center;gap:6px;list-style:none}
.more>summary::-webkit-details-marker,.more-st>summary::-webkit-details-marker{display:none}
.more>summary::before,.more-st>summary::before{content:"";flex:none;width:12px;height:12px;background:currentColor;-webkit-mask:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><path d='m9 6 6 6-6 6'/></svg>") center/contain no-repeat;mask:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><path d='m9 6 6 6-6 6'/></svg>") center/contain no-repeat;transition:transform .2s}
.more[open]>summary::before,.more-st[open]>summary::before{transform:rotate(90deg)}
/* Keys show where they apply: Open in T3 (O). */
.plate-bar .open-t3{display:inline-flex;align-items:center;gap:4px}
.plate-bar .open-t3 kbd{margin-left:4px;padding:0 5px;border-radius:6px;background:var(--fill);font:600 12px/18px var(--sans);color:var(--label2)}
@media (hover:none){.plate-bar .open-t3 kbd{display:none}}
/* The question leads the reader, under the title (and is not said again over the options). */
.lead{display:flex;flex-direction:column;gap:4px;margin:-4px 0 16px}
.lead .lead-k{align-self:flex-start}
.lead-q{font-size:16px;line-height:24px;font-weight:600;color:var(--label);overflow-wrap:anywhere}
.dock .q-set>legend.said{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* Screenshots: attachments at one size under the title, labelled, before and after side by side. */
.atts{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,216px));gap:12px;margin:0 0 16px}
.att{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:12px;line-height:16px;color:var(--label2);text-decoration:none}
.att-img{display:grid;place-items:center;aspect-ratio:16/10;overflow:hidden;border-radius:10px;background:var(--fill);box-shadow:inset 0 0 0 .5px var(--sep)}
.att-img img{display:block;width:100%;height:100%;object-fit:cover;object-position:top center}
a.att:hover .att-img{outline:2px solid var(--accent);outline-offset:-2px}
a.att:focus-visible{outline:none}
a.att:focus-visible .att-img{outline:2px solid var(--focus);outline-offset:2px}
.att-cap{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.att.missing .att-img{font-size:12px;color:var(--label2)}
/* The open ticket's surfaces: the ticket on the app's background, its controls on cards; the action bar is not a
   card of its own, so three levels at most. The sheet over the kitchen matches the reader. */
.v-pass .reader>.plate,.v-pass .reader>.reader-empty,dialog.sheet{background:var(--bg)}
html .plate .dock{margin:0;padding:12px 28px 16px;border:0;border-radius:0;background:none;box-shadow:none}
.plate .more,.plate .prc,.plate label.opt,.plate .note textarea{background:var(--card)}
/* Selection by connection (Dan, 2026-11-07): the open ticket keeps the others' fill and runs into the reader,
   which sits inset in the panel like a tab, joined by two inverse corners. */
@media (min-width:761px){
  .v-pass .head-h{padding-bottom:0}
  .v-pass .head-b{padding-top:16px}
  .v-pass .reader{padding:12px 12px 12px 0}
  .v-pass .reader>.plate,.v-pass .reader>.reader-empty{border-radius:16px}
  /* The three columns' first lines share one line (hill climb 2 r1, Opus): the stage list starts level with the
     reader tab, and the reader's bar sits on the list's heading. */
  :is(.v-pass,.v-kitchen) .stagenav{margin-top:8px}
  .v-pass .reader .plate-bar{padding-top:8px}
  .v-pass .folder>.tile,.v-pass .folder>.tile.sel{background:var(--bg);box-shadow:none}
  .v-pass .folder>.tile:hover{box-shadow:var(--sh1)}
  .v-pass .folder>.tile.sel:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
}
/* Titles show in full in every list (no clamp, no ellipsis). */
.tile .t,.tile.quiet .t{display:block;-webkit-line-clamp:unset;overflow:visible}
.call-tile .pick.ct-title{white-space:normal;overflow:visible;text-overflow:clip}
/* Input is never blocked while the views change. */
::view-transition{pointer-events:none}
/* Round 1 capture fixes. The list and the reader share one frame: no line where they meet. */
@media (min-width:761px){ .v-pass .head{box-shadow:inset 0 .5px 0 var(--sep),inset .5px 0 0 var(--sep),inset 0 -.5px 0 var(--sep)} }
.plate:has(.lead) .dock .dock-k{display:none}
/* Attachments sit in one row at one size; more scroll sideways, so the message stays in view. */
.atts{display:flex;gap:12px;overflow-x:auto;padding-bottom:4px}
.att{flex:0 0 176px}
.atts.fade-right{-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 40px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 40px),transparent)}
/* The frame sits over the picture, so a dark shot on dark (or light on light) keeps its edge. */
.att-img{position:relative}
.att-img::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px var(--sep);pointer-events:none}
/* A short window gives the message the height: smaller attachments. */
@media (min-width:761px) and (max-height:760px){ .att{flex-basis:136px} }
/* An open pull request's chip carries its state in the dot; its words stay in the text colour. */
.prc.t-open{color:var(--label)}
.plate kbd.yield,.plate kbd.taken{visibility:hidden}
/* A form waiting out its Undo or its post shows no key hint: the key goes to the next free form (r14, from shot 48). */
.plate form.act[data-busy] button kbd{visibility:hidden}
#toast button kbd.yield{display:none}
.th.nc{color:var(--label2);align-self:flex-start}.th.nc i{background:var(--red)}
/* One group heading style in Settings: Shortcuts matches Layout (hill climb 2 r3, Fable). */
#settings .kgroup{margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--label2)}
#settings .keylist+.kgroup{margin-top:20px}
/* Verified is a check in the stage list, as at the foot of Merged in the kitchen. */
.nf .ic.vd{width:16px;height:16px;margin:0 1px;color:var(--green)}
/* In the kitchen the pass panel nests like the stages: a well holding raised cards. */
.v-kitchen .head{background:var(--well);box-shadow:none}
/* On the light well the badge's blue tint leaves its number at 4.5:1; a deeper blue gives it 5.3:1 (hill climb 2 r12, Fable). */
@media (prefers-color-scheme:light){ .v-kitchen .head .badge{--blue:#0052AB} }
.v-kitchen .head .call-tile,.v-kitchen .head .tile{background:var(--card);box-shadow:var(--sh1)}
.call-tile .ct-top .age{white-space:nowrap}
/* A narrow pass card keeps the recommendation whole and the project's mark, not a cut name (hill climb 2 r2, Sol). */
.call-tile{container:ctile/inline-size}
.call-tile .ct-rec{white-space:normal;overflow:visible}
@container ctile (max-width:290px){ .call-tile .ct-top .pn{display:none} }
/* Hill climb 2 r2 (Opus). A card's pull request reads like the ticket's PR chip: a state dot, words in the text colour. */
.th.pr-open,.th.pr-merged,.th.pr-closed{color:var(--label2)}
.th.pr-open i{background:var(--open)}.th.pr-merged i{background:var(--merged)}.th.pr-closed i{background:var(--closed)}
/* At 1280 all six kitchen columns fit: a narrower pass panel and 140px stages. */
@media (min-width:761px) and (max-width:1366px){
  .v-kitchen .board{grid-template-columns:208px minmax(0,1fr) 280px}
}
/* The kitchen's pass heading sits on the stage headings' line. */
/* The kitchen pass header reads like a stage header: its line under the title is hint-sized, and the first card lines up with the stages' first cards (hill climb 2 r8, Opus). Under 1636 px only its first sentence shows, on one line. */
@media (min-width:761px){ .v-kitchen .head-h{padding-top:13px;padding-bottom:10px} .v-kitchen .head-h>.muted{font-size:12px} }
/* Under 1636 px the kitchen pass panel is under 360 px, so its subtitle keeps one line (hill climb 2 r12). */
@media (min-width:761px) and (max-width:1635px){ .v-kitchen .head-h .sub2{display:none} }
/* Hill climb 2 r2 (Fable). The open ticket ends at its content. */
@media (min-width:761px){
  .v-pass .reader{align-items:flex-start}
  .v-pass .reader>.plate{max-height:100%}
  .v-pass .reader>.reader-empty{align-self:stretch}
  .v-pass .reader{position:relative}
  /* One card treatment in both views: a flat card one fill step off its container, a shadow only on hover. */
  .v-kitchen .tile:not(.sel),.v-kitchen .head .call-tile:not(.sel),.v-kitchen .head .tile:not(.sel){box-shadow:none}
  .v-kitchen .tile:not(.sel):hover{box-shadow:var(--sh1)}
  /* The toast sits in the bottom bar's row, clear of the panels. */
  #toast{inset:auto auto 5px 50%;transform:translateX(-50%);padding:4px 6px 4px 14px;width:max-content;max-width:min(900px,calc(100vw - 300px))}
  #toast button{min-height:30px}
  #toast.counting::after{bottom:2px}
}
/* On a short window "Asks you" shares the question's line, so the message gets the height. */
@media (min-width:761px) and (max-height:760px){
  .lead{flex-direction:row;align-items:baseline;gap:8px}
  .lead .lead-k{align-self:auto;flex:none}
}
textarea{resize:none!important}
/* ===== Dan, 2026-11-08: light mirrors dark, the list's name shows once, no footer. ===== */
/* Light mirrors dark: a white page, grey panels, white cards inside them. */
@media (prefers-color-scheme:light){:root{--bg:#FFFFFF;--well:#F2F2F7;--card:#F2F2F7;--card2:#EBEBF0;--inset:#FFFFFF;--mat:rgba(255,255,255,.8);--matsheet:rgba(255,255,255,.86)}.v-kitchen .rail .tile,.v-kitchen .head .tile{background:#FFFFFF}}
/* The highlighted stage-list item names the open list, so the list has no title of its own. */
.v-pass .head-h{display:none}
/* The project menu, Live and Settings sit under the stage list, pinned to the foot of the column (Dan, 2026-11-09,
   from the team mock). No rule above them: pinned low, the space separates them from the stages (Dan, 2026-11-09). In a short window they follow the stages and scroll with them. */
.nav-foot{display:none}
/* Under The Pass, the stages and the foot scroll as one in a short window; The Pass stays on the logo's row. */
.nav-scroll{display:contents}
@media (min-width:761px){
  :is(.v-pass,.v-kitchen) .stagenav{overflow:visible}
  :is(.v-pass,.v-kitchen) .nav-scroll{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
  :is(.v-pass,.v-kitchen) .nav-foot{display:flex;flex-direction:column;gap:10px;margin:auto 0 0;padding-top:12px}
  :is(.v-pass,.v-kitchen) .nav-foot .pmenu{margin:0}
  :is(.v-pass,.v-kitchen) .nav-foot .pmenu summary{width:100%}
  :is(.v-pass,.v-kitchen) .nav-foot .pmenu summary>span:first-of-type:not(.vi){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* The stage list scrolls in a short window, so its project menu is a fixed layer that placeNavMenu sets by its button. */
  :is(.v-pass,.v-kitchen) .nav-foot .pmenu-l{position:fixed;top:auto;right:auto;bottom:auto;left:auto;overflow-y:auto;overscroll-behavior:contain}
  /* Live and Settings: two equal boxes on one line (Dan, 2026-11-08). */
  :is(.v-pass,.v-kitchen) .nav-foot-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  :is(.v-pass,.v-kitchen) .nav-foot .lamps{display:flex;align-items:center;justify-content:center;height:36px;margin:0;padding:0;border-radius:10px;background:var(--fill);font-size:12px;white-space:nowrap;color:var(--label2)}
  :is(.v-pass,.v-kitchen) .nav-foot .gear{width:auto;height:36px;margin-left:0}
  html:is(.v-pass,.v-kitchen) #app{padding-bottom:16px}
  /* No empty top bar in the Pass (Dan, 2026-11-08): the logo sits on The Pass's row, the columns start at the top,
     and a red strip shows under them. The logo stays the view switch. */
  html:is(.v-pass,.v-kitchen) #app{position:relative}
  :is(.v-pass,.v-kitchen) .bar{position:absolute;top:29px;left:24px;z-index:4;min-height:0;padding:0;pointer-events:none}
  :is(.v-pass,.v-kitchen) .bar .stats{display:none}
  :is(.v-pass,.v-kitchen) .bar .logo{pointer-events:auto}
  html:is(.v-pass,.v-kitchen) .board{padding-top:16px}
  :is(.v-pass,.v-kitchen) .stagenav>.nf[data-folder=pass]{width:auto;margin-left:44px}
  html:is(.v-pass,.v-kitchen) #app>.strip{order:1;margin:10px 24px 0}
}
.lamps li{cursor:default}
/* ===== Dan, 2026-11-08 (2): a scrolling ticket column, a reader of its own, one logo line. ===== */
@media (min-width:761px){
  /* The logo, The Pass and both panels share one top line, in both views (the kitchen's logo sits at 18 px). */
  :is(.v-pass,.v-kitchen) .bar{top:18px}
  html:is(.v-pass,.v-kitchen) .board{padding-top:18px}
  :is(.v-pass,.v-kitchen) .stagenav{margin-top:0;padding-top:0}
  :is(.v-pass,.v-kitchen) .stagenav>.nf[data-folder=pass]{height:34px;min-height:34px}
  /* The tickets scroll in their own rounded column; the reader is a separate panel beside it. */
  .v-pass .head{margin-right:12px;padding:12px 0 0;border-radius:22px;background:var(--card);box-shadow:inset 0 0 0 .5px var(--sep)}
  .v-pass .head-b{padding:0 12px 12px;direction:ltr;scrollbar-gutter:auto}
  .v-pass .folder>.tile{margin-right:0;border-radius:16px}
  /* The open ticket's card: a blue left edge, in light and dark. */
  .v-pass .folder>.tile.sel,.v-pass .folder>.tile.sel:hover{box-shadow:inset 3px 0 0 var(--accent),inset 0 0 0 .5px color-mix(in srgb,var(--accent) 45%,transparent)}
  .v-pass .reader{align-items:stretch;padding:12px;border-radius:22px;box-shadow:inset 0 0 0 .5px var(--sep)}
  .v-pass .reader>.plate{max-height:none}
  /* Nothing open: a blank sheet with one quiet line. */
  .v-pass .reader-empty .ic{display:none}
  .v-pass .reader-empty p{font-size:13px}
}
/* The ticket's head (title, the ask, pull requests, screenshots) stays pinned while the message scrolls under it. */
@media (min-width:761px) and (min-height:640px){
  .plate-head{position:sticky;top:-12px;z-index:2;margin:-12px -28px 0;padding:12px 28px 4px;background:var(--bg)}
  .plate-head.stuck{box-shadow:0 .5px 0 var(--sep)}
  .plate-head.unpin{position:static;box-shadow:none}
  .plate-head+.msg{margin-top:12px}
}
/* Quieter chrome: Open in T3 is a plain control, not a blue link. */
.plate-bar .open-t3{color:var(--label2)}
.plate-bar .open-t3:hover{color:var(--label)}
/* The red strip heads the ticket's pinned part, in line with the title. */
.plate-head>.netstrip{margin:0 0 12px}
/* Lost: every count waits for the next update, Verified's and On hold's too. */
.is-stale .pmenu summary .n{visibility:hidden}
/* ===== Dan, 2026-11-08 (3): calmer cards, a full reader with its actions at the bottom. ===== */
@media (min-width:761px){
  /* The open card keeps all four round corners (an older rule squared its right side for the joined tab). */
  .v-pass .folder>.tile.sel{margin-right:0;border-radius:16px}
  /* The cards sit 12 px from both sides of their column, with or without a scroll bar. */
  .v-pass .head-b{scrollbar-gutter:stable both-edges;padding-left:5px;padding-right:5px}
  /* The reader is the open ticket, framed only by a thick border in the column's colour. */
  .v-pass .reader{box-shadow:none}
  .v-pass .reader>.plate,.v-pass .reader>.reader-empty{border-radius:12px}
}
/* The actions stay pinned to the bottom of the open ticket, like Gmail's Reply and Forward; the message scrolls above. */
html.v-pass .reader .plate .plate-scroll,html dialog.sheet .plate .plate-scroll{flex:1 1 auto}
html .plate .plate-scroll.fade-end~.dock{box-shadow:0 -.5px 0 var(--sep)}
/* On cards the project shows as its icon only; the icon's tooltip names it. */
.v-pass .head .tile .proj .pn{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* Open in T3's key shows on hover or keyboard focus, as a small badge, like Superhuman. The bar's keys are in its tooltips. */
@media (hover:hover){
  .plate-bar .open-t3{position:relative}
  .plate-bar .open-t3 kbd{position:absolute;top:-8px;right:-6px;z-index:1;margin:0;background:var(--card2);box-shadow:0 0 0 .5px var(--sep),var(--sh1);opacity:0;transform:scale(.9);transition:opacity .12s,transform .12s;pointer-events:none}
  .plate-bar .open-t3:hover kbd,.plate-bar .open-t3:focus-visible kbd{opacity:1;transform:none}
}
/* ===== Rules (Dan, 2026-11-08): T3 Code's settings rows. A title and a line on the left, the control on the right. ===== */
#settings .kr-top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;margin:0 0 18px}
#settings .kr-intro{flex:1 1 220px;margin:0;font-size:13px;line-height:1.45;color:var(--label2)}
#settings .kr-scope{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--label2)}
#settings .kr-group{margin:0 0 20px;border-radius:14px;background:var(--bg);box-shadow:inset 0 0 0 .5px var(--sep)}
#settings .kr-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px 24px;padding:12px 14px}
#settings .kr-row+.kr-row{box-shadow:inset 0 .5px 0 var(--sep)}
#settings .kr-h{display:flex;align-items:center;gap:8px;min-height:20px}
#settings .kr-l h4{margin:0;font-size:14px;font-weight:600;color:var(--label)}
#settings .kr-l p{margin:2px 0 0;font-size:12px;line-height:1.4;color:var(--label2)}
#settings .kr-reset{display:none;padding:0 6px;border:0;border-radius:6px;background:var(--fill);color:var(--accent);font:600 11px/18px var(--sans);cursor:pointer}
#settings .kr-over .kr-reset{display:inline-block}
#settings .kr-over .kr-l h4::after{content:"";display:inline-block;width:6px;height:6px;margin-left:6px;border-radius:50%;background:var(--accent);vertical-align:middle}
#settings .kr-sel,#settings .kr-scope select{max-width:240px;padding:6px 28px 6px 10px;border:0;border-radius:8px;background:var(--card) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 10px center;color:var(--label);font:13px/1.3 var(--sans);box-shadow:inset 0 0 0 .5px var(--sep);-webkit-appearance:none;appearance:none;cursor:pointer}
#settings .kr-sw{position:relative;display:inline-block;width:36px;height:22px;cursor:pointer}
#settings .kr-sw input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
#settings .kr-sw i{position:absolute;inset:0;border-radius:11px;background:var(--fill2,var(--fill));box-shadow:inset 0 0 0 .5px var(--sep);transition:background .15s;pointer-events:none}
#settings .kr-sw i::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s}
#settings .kr-sw input:checked+i{background:var(--accent)}
#settings .kr-sw input:checked+i::after{transform:translateX(14px)}
#settings .kr-sw input:focus-visible+i{outline:2px solid var(--accent);outline-offset:2px}
#settings .kr-row.kr-off{opacity:.5}
#settings .kr-notes{grid-template-columns:1fr}
#settings .kr-notes textarea{width:100%;box-sizing:border-box;min-height:72px;padding:8px 10px;border:0;border-radius:8px;background:var(--card);color:var(--label);font:13px/1.45 var(--sans);box-shadow:inset 0 0 0 .5px var(--sep);resize:vertical}
#settings .set-done span.bad{color:var(--red)}
/* ===== Shortcuts (⌘K bar PR 4, mock v3): Rules' rows, with the keys and Change on the right. Recording and a clash
   show in the row itself; the keys are keycaps, never a form field. ===== */
#settings .kx-top{margin:0 0 18px}
#settings .kx-q{display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;border-radius:9px;background:var(--bg);box-shadow:inset 0 0 0 .5px var(--sep);color:var(--label2);cursor:text}
#settings .kx-q svg{flex:none;width:14px;height:14px}
#settings .kx-q input{flex:1;min-width:0;height:100%;padding:0;border:0;background:none;color:var(--label);font:13px/1.3 var(--sans);outline:none;-webkit-appearance:none;appearance:none}
#settings .kx-q input::-webkit-search-cancel-button{-webkit-appearance:none}
#settings .kx-q:focus-within{box-shadow:inset 0 0 0 .5px var(--sep),0 0 0 3px var(--focus)}
#settings .kx-group{overflow:hidden}
#settings .kx-row{transition:background .15s}
#settings .kx-c{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-height:28px}
#settings .kx-k{display:inline-flex;gap:3px}
#settings .kx-c kbd{display:inline-block;box-sizing:border-box;min-width:22px;height:22px;padding:0 6px;border-radius:6px;background:var(--fill);box-shadow:inset 0 -.5px 0 var(--sep);font:600 12px/22px var(--sans);text-align:center;color:var(--label)}
#settings .kx-or,#settings .kx-no{font-size:12px;color:var(--label2)}
#settings .kx-ed{margin-left:4px;padding:4px 8px;border:0;border-radius:6px;background:none;color:var(--accent);font:600 12.5px/1.2 var(--sans);cursor:pointer}
#settings .kx-ed:hover{background:var(--fill)}
#settings .kx-row.kx-rec{background:var(--blue-t);outline:none}
#settings .kx-row.kx-rec .kr-l p{color:var(--accent)}
#settings .recbox{display:inline-flex;align-items:center;height:28px;padding:0 10px;border-radius:7px;border:1.5px dashed var(--accent);color:var(--accent);font:600 12.5px/1 var(--sans);white-space:nowrap}
#settings .kx-row.kx-clash{background:var(--orange-t)}
#settings .kx-msg{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;font-size:13px;color:var(--label2)}
#settings .kx-msg b{color:var(--orange);font-weight:700}
#settings .kx-hint{grid-column:1/-1;margin:0;font-size:12px;color:var(--orange)}
#settings .kx-b{min-height:28px;height:28px;padding:0 12px;border-radius:7px;font-size:12.5px;font-weight:600;color:var(--label)}
#settings .kx-b:disabled{opacity:.45;cursor:default}
#settings .kx-foot{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;margin:0 0 18px;font-size:12px;line-height:1.45;color:var(--label2)}
#settings .kx-foot .kx-file{flex:1 1 260px;margin:0}
#settings .kx-btns{display:flex;gap:8px}
#settings .kx-note{flex-basis:100%;margin:0;color:var(--orange)}
#settings .kx-none{margin:28px 0;text-align:center;font-size:13px;color:var(--label2)}
#settings .kx-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* No zoom on focus: iOS zooms fields under 16px (as .note textarea does above). This comes after the rules that size
   them: the new-ticket form, the Rules menus and House notes (PR-Agent r8 on #61). */
/* The Pass's check: a visual call with no screenshots. */
.plate-head .kr-flag{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:0 0 12px;font-size:13px;color:var(--label2)}
.plate-head .kr-flag .kr-k{padding:1px 8px;border-radius:999px;background:var(--orange-t);color:var(--orange);font:600 12px/20px var(--sans)}
.plate-head .kr-flag .kr-ask{min-height:28px;padding:0 10px;font-size:13px}
.launch .lf-rules{margin:-4px 0 0;font-size:12px}
/* Tickets read like email (Dan, 2026-11-08): who (project, model), the T3 thread's title, one line of preview, labels. */
.call-tile.mail{gap:3px}
.call-tile.mail .ct-top{display:flex;align-items:center;gap:8px;min-width:0}
.mdl{font-size:12px;color:var(--label2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.call-tile.mail .ct-top .age{margin-left:auto}
/* The sender line names the project in words, as a mail client names who wrote (Dan, 2026-11-08). */
.v-pass .head .call-tile.mail .proj .pn{position:static;width:auto;height:auto;clip:auto}
.call-tile.mail .ct-top .proj{min-width:0;flex:0 1 auto}
.call-tile.mail .q{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:15px;line-height:1.3;font-weight:600}
.call-tile.mail .ct-pv{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;line-height:1.35;color:var(--label2)}
.lbs{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-top:5px;font-size:12px;color:var(--label2)}
.lbs .lb{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.lbs .lb .gd{margin:0}
html.d-compact .call-tile.mail .ct-pv{display:none}
html.d-compact .call-tile.mail .q{-webkit-line-clamp:1}
.tile-top .mdl{margin-left:8px}
.tile-top .mdl+.age{margin-left:auto}
.plate-bar .mdl{font-size:13px}
.lead.lead-n{flex-direction:row;align-items:center;gap:8px;margin:-6px 0 14px}
/* Several questions: one card in front, the rest behind "1 of 3"; the buttons stay below (Dan, 2026-11-08). */
form.q-car .q-set:not(.q-on){display:none!important}
.q-nav{display:flex;align-items:center;gap:6px;margin:0;font-size:12.5px;color:var(--label2)}
.q-pos{font-variant-numeric:tabular-nums;font-weight:600;color:var(--label2);margin-right:4px}
.q-go{width:26px;height:26px;padding:0;border:0;border-radius:7px;background:var(--fill);color:var(--label);display:inline-grid;place-items:center;cursor:pointer}
.q-go .ic{width:15px;height:15px}
.q-go[data-qgo="-1"] .ic{transform:rotate(90deg)}
.q-go[data-qgo="1"] .ic{transform:rotate(-90deg)}
.q-go:disabled{opacity:.35;cursor:default}
.q-dots{display:inline-flex;gap:6px;margin-left:8px}
.q-dot{width:8px;height:8px;padding:0;border:0;border-radius:50%;background:var(--fill);box-shadow:inset 0 0 0 1px var(--label2);opacity:.6;cursor:pointer}
.q-dot.done{background:var(--accent);box-shadow:none;opacity:1}
.q-dot.on{opacity:1;outline:2px solid var(--accent);outline-offset:2px}
.q-why{grid-column:1/-1;margin:2px 0 0;font-size:13px;line-height:1.4;color:var(--label2)}
.q-why b{color:var(--label);font-weight:600}
/* ===== The action bar (Dan, 2026-11-10; mock v1, calls 1a, 2a and 3a). One row at the open ticket's foot in every
   view, the same at 1440 and 2560: the blue action, Changes and Reply as an icon and a word, Hold and Settle as icons
   after a thin divider, then More. Keys show only in tooltips, on hover or keyboard focus. ===== */
:root{--pop:#FFFFFF;--sh-pop:0 0 0 .5px rgba(0,0,0,.10),0 18px 48px rgba(0,0,0,.18),0 4px 12px rgba(0,0,0,.08)}
@media (prefers-color-scheme:dark){:root{--pop:#2C2C2E;--sh-pop:0 0 0 .5px rgba(255,255,255,.10),0 18px 48px rgba(0,0,0,.6),0 4px 12px rgba(0,0,0,.4)}}
html .plate .dock{padding:12px 28px 0}
/* A ticket with no question has the bar alone in its dock, so a hint or a tooltip may rise over the message. */
html .plate .dock-plain{overflow:visible}
/* The bar sticks to the dock's foot, so a long question scrolls above it. */
.dock .act-foot{position:sticky;bottom:0;z-index:3;padding:2px 0 14px;background:var(--bg)}
/* Hints (a wrong key, a refused send) sit over the bar's top edge, so the buttons never move. */
.dock .act-foot>.result{position:absolute;left:0;right:0;bottom:100%;margin:0;padding:4px 0;background:var(--bg);font-size:13px;line-height:1.35}
.dock .act-foot>.result:empty{display:none}
.abar{display:flex;align-items:center;gap:6px;min-height:36px}
.abar>button{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;height:36px;margin:0;border:0;border-radius:10px;font:inherit;cursor:pointer}
.abar .ab{gap:7px;padding:0 14px 0 11px;background:var(--fill);color:var(--label);font-size:14px;font-weight:600;white-space:nowrap}
.abar .ab:hover{background:var(--fill2)}
.abar .ab.fill{background:var(--accent);color:#fff}
.abar .ab.fill:hover{background:#0068D1}
.abar .ib{width:36px;padding:0;background:none;color:var(--label2)}
.abar .ib:hover,.abar .ib.on{background:var(--fill);color:var(--label)}
.abar .ic{width:18px;height:18px;flex:none}
.abar .ib .ic{width:19px;height:19px}
.abar button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.abar button:disabled{opacity:.45;cursor:default}
.abar .vr{flex:none;width:1px;height:20px;margin:0 4px;background:var(--sep)}
.abar .mw{display:none}
/* The tooltip: the full name, then the key ("Merge: the agent merges it  M or ⌘↵"). */
.abar .tip{position:absolute;bottom:calc(100% + 8px);left:50%;z-index:5;display:flex;align-items:center;gap:8px;padding:7px 8px 7px 10px;border-radius:8px;background:var(--label);color:var(--bg);font:500 12.5px/1 var(--sans);letter-spacing:0;white-space:nowrap;opacity:0;transform:translateX(-50%) translateY(3px);transition:opacity .12s,transform .12s;pointer-events:none}
.abar .tip kbd{display:inline-block;min-width:18px;padding:3px 5px;border-radius:5px;background:color-mix(in srgb,var(--bg) 18%,transparent);color:inherit;font:600 11.5px/1 var(--sans);letter-spacing:0;text-align:center}
.abar .tip .or{opacity:.6}
.abar>:first-child .tip{left:0;transform:translateY(3px)}
.abar>button:hover .tip,.abar>button:focus-visible .tip{opacity:1;transform:translateX(-50%)}
.abar>:first-child:hover .tip,.abar>:first-child:focus-visible .tip{transform:none}
.abar .more-b.on .tip{opacity:0}
/* A key that goes elsewhere right now is not shown: Cmd+Enter while R or F is armed, a letter an option takes. */
.abar .tip kbd:is(.yield,.taken,.nokey,[hidden]),.abar .tip kbd:is(.yield,.taken,.nokey,[hidden])+.or,.abar .tip .or:has(+kbd:is(.yield,.taken,.nokey,[hidden])){display:none}
/* A command left with no key in Settings → Shortcuts shows none. */
kbd.nokey{display:none!important}
@media (hover:none){.abar .tip{display:none}}
/* More: a floating card above its button, each row an icon, a word and its key. It sits in the top layer, so the
   dock's scroll never clips it; the page script places it. */
.abar .menu{position:fixed;inset:auto;min-width:236px;margin:0;padding:6px;border:0;border-radius:12px;background:var(--pop);color:var(--label);box-shadow:var(--sh-pop);overflow:visible}
.abar .menu:popover-open{display:flex;flex-direction:column}
.abar .mi{display:flex;align-items:center;gap:10px;width:100%;height:34px;margin:0;padding:0 10px;border:0;border-radius:7px;background:none;color:var(--label);font:inherit;font-size:14px;text-align:left;white-space:nowrap;cursor:pointer}
.abar .mi:hover,.abar .mi:focus-visible{background:var(--blue-t);outline:none}
.abar .mi .ic{width:18px;height:18px;flex:none;color:var(--label2)}
.abar .mi kbd{margin-left:auto;padding-left:12px;color:var(--label2);font:500 12px/1 var(--sans)}
.abar .mi-n{max-width:224px;margin:4px 10px;font-size:12px;line-height:1.35;color:var(--label2)}
.abar .mi.ph,.abar .mi-x{display:none}
/* A question's options stop at the reading width (each was about 900 px wide at 2560). */
html .plate .dock .q-set{max-width:640px}
/* A narrow ticket in a wide window (a slim window gives the Pass's reader about 340 px at 920): the row never clips
   (PR-Agent r1 on #72). By the ticket's own width: under 560 px Changes and Reply keep only their icons, under 420 px
   Hold and Settle move into More, and under 300 px the row wraps. Tooltips keep every name and key, and
   a word that steps aside stays the button's name for screen readers. */
@media (min-width:761px){
  @container (max-width:560px){
    .abar .ab:not(.primary){width:36px;padding:0}
    .abar .ab:not(.primary) .bl{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
  }
  @container (max-width:420px){
    .abar .ib:not(.more-b),.abar .vr{display:none}
    .abar .mi.ph{display:flex}
  }
  @container (max-width:300px){ .abar{flex-wrap:wrap;row-gap:6px} }
}
/* ===== You (Dan, 2026-11-10, views mock v4) ===== */
/* Stage colours: a gray ramp up the line (Backlog lightest, In progress darkest), then green, blue and purple.
   In progress is gray, never orange: orange says something is wrong. */
:root{--st-backlog:#AEAEB2;--st-planned:#8E8E93;--st-prog:#636366;--st-review:var(--open);--st-ready:var(--pass);--st-merged:var(--merged)}
@media (prefers-color-scheme:dark){:root{--st-backlog:#636366;--st-planned:#8E8E93;--st-prog:#AEAEB2}}
.gd.c-backlog{background:var(--st-backlog)}.gd.c-planned{background:var(--st-planned)}.gd.c-prog{background:var(--st-prog)}
/* The rail's top card: the person, then one piece per thread in its stage's colour. */
.idrow{display:flex;align-items:center;gap:8px;padding:4px 8px 8px 6px;color:var(--label2)}
.idrow .who{flex:none;width:24px;height:24px}
.segbar{flex:1;display:flex;gap:2px;min-width:0;height:8px}
.segbar:empty{border-radius:2px;background:var(--fill)}
.segbar i{flex:1 1 0;min-width:2px;border-radius:2px}
.segbar i.c-backlog{background:var(--st-backlog)}.segbar i.c-planned{background:var(--st-planned)}.segbar i.c-prog{background:var(--st-prog)}
.segbar i.c-open{background:var(--st-review)}.segbar i.c-blue{background:var(--st-ready)}.segbar i.c-merged{background:var(--st-merged)}
/* You, expanded (Dan, 2026-11-11, flow mock v3.3): the header picker over the solo Sankey (client/flow.ts), which took
   the place of the stage columns. The chart keeps its size and scrolls inside the view when the window is narrow or the
   line is long. Gray steps are time since the last change; dark mode inverts them, so old is bright. One hover colour:
   the logo's blue in light, white in dark. No red, orange or yellow, and no mark at rest for what waits on you: The
   Pass lists it, and hover links each card to its thread (Dan, 2026-11-12). */
:root{--fx-a0:#D6D6DB;--fx-a1:#A6A6AB;--fx-a2:#636366;--fx-hov:#0071E3;--fx-zone-a:rgba(118,118,128,.035);--fx-zone-b:rgba(118,118,128,.085);--fx-dot:rgba(60,60,67,.2)}
@media (prefers-color-scheme:dark){:root{--fx-a0:#48484A;--fx-a1:#7C7C80;--fx-a2:#C7C7CC;--fx-hov:#FFFFFF;--fx-zone-a:rgba(255,255,255,.015);--fx-zone-b:rgba(255,255,255,.05);--fx-dot:rgba(235,235,245,.16)}}
.you,.team-wait{display:none}
@media (min-width:761px){
  .v-kitchen .you{display:flex;flex-direction:column;min-height:0}
  .v-kitchen .you-b{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
  .v-kitchen .team-wait{align-self:start}
}
.fx-wrap{position:relative;min-width:640px}
.fx{display:block;width:100%;height:auto;clip-path:inset(0 round 18px)}
.fx .fx-body *{vector-effect:non-scaling-stroke}
.fx text{font-size:11.5px}
.fx .dot{fill:var(--fx-dot)}
.fx .zone.z0{fill:var(--fx-zone-a)}.fx .zone.z1{fill:var(--fx-zone-b)}
.fx .zline{stroke:var(--sep);stroke-dasharray:3 4}
.fx .zlbl{font-weight:600;fill:var(--label2)}
.fx .zcount{font-weight:400;fill:var(--label2)}
.fx .band{stroke:var(--bg);stroke-width:.6;transition:fill .15s,opacity .15s}
.fx .band.a0{fill:var(--fx-a0)}.fx .band.a1{fill:var(--fx-a1)}.fx .band.a2{fill:var(--fx-a2)}
/* Dashed, with no fill, yet its whole ribbon answers the pointer (PR-Agent r3 on #49). */
.fx .band.anc{fill:none;stroke:var(--fx-a1);stroke-dasharray:3 2;pointer-events:all}
.fx .band.lit{fill:var(--fx-hov)}
.fx .strand{fill:none;stroke:var(--bg);stroke-width:1px;vector-effect:non-scaling-stroke;pointer-events:none}
.fx-focus .fx .band:not(.lit){opacity:.5}
.fx [data-drill],.fx .band[data-plate]{cursor:pointer}
.fx [tabindex]{outline:none}
.fx [tabindex]:focus-visible{outline:2px solid var(--fx-hov);outline-offset:2px}
.fx .glogo{filter:grayscale(1);opacity:.75;transition:filter .15s,opacity .15s}
.fx .glogo.lit{filter:none;opacity:1}
.fx .glogo .pml{fill:#fff;font-size:12px;font-weight:700}
.fx .fanl{fill:none;stroke-width:1.1;pointer-events:none;transition:stroke .15s,opacity .15s}
.fx .fanl.a0{stroke:var(--fx-a0)}.fx .fanl.a1{stroke:var(--fx-a1)}.fx .fanl.a2{stroke:var(--fx-a2)}.fx .fanl.anc{stroke:var(--fx-a1)}
.fx .fanl.lit{stroke:var(--fx-hov)}
.fx-focus .fx .fanl:not(.lit){opacity:.5}
.fx .fanhit{fill:transparent}
.head .call-tile.lit{outline:1.5px solid var(--fx-hov);outline-offset:-1.5px}
.fx-tip{position:absolute;z-index:5;max-width:260px;padding:8px 10px;border-radius:8px;background:var(--card);box-shadow:0 0 0 .5px var(--sep),0 8px 24px rgba(0,0,0,.18);font-size:12px;line-height:1.4;color:var(--label);pointer-events:none}
.fx-tip .m{color:var(--label2)}
.fx-tip .alarm{display:flex;align-items:center;gap:5px;font-weight:600}
.fx-tip .alarm .ic{width:14px;height:14px;color:var(--pass);stroke-width:2.2}
.fx-key{position:absolute;right:16px;bottom:14px;display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--label2);white-space:nowrap;pointer-events:none}
.fx-back{display:grid;flex:none;place-items:center;width:30px;height:30px;margin-left:6px;padding:0;border:0;border-radius:9px;background:var(--fill);color:var(--label2);cursor:pointer}
.fx-back:hover{color:var(--label)}
.fx-back .ic{width:16px;height:16px;transform:rotate(90deg)}
/* Expanded, The Pass is the right column, so its row at the top left gives way to the picker (Dan, 2026-11-12): the
   picker sits beside the logo, and the chart starts at the top, level with The Pass. The row keeps its height. */
@media (min-width:761px){
  .v-kitchen .stagenav>.nf[data-folder=pass]{visibility:hidden}
  .v-kitchen :is(.you,.tboard,.team-wait)>.you-h{position:absolute;top:16px;left:68px;z-index:4;max-width:176px;padding:0}
  .v-kitchen .you-h .vhead summary{min-height:36px;font-size:17px}
}
.fx-chip{display:inline-flex;align-items:center;gap:6px}
.fx-chip .sw{width:10px;height:10px;border-radius:2px}
.fx-chip .sw.a0{background:var(--fx-a0)}.fx-chip .sw.a1{background:var(--fx-a1)}.fx-chip .sw.a2{background:var(--fx-a2)}
.fx-empty{padding:48px 12px;text-align:center}
/* The footer chip and its menu (Dan, 2026-11-10, view menu mock a). The chip: the person, or the toque for Team, then
   All projects or the picked projects' icons fanned like cards. The menu: check boxes, then the toggle. No "You" or
   "Team" word in the chip or the toggle (Dan, 2026-11-11): the icon's tooltip and hidden label carry it. */
.vmenu{--cbon:#007AFF;--cboff:#FFFFFF;--cbline:rgba(0,0,0,.26);--segon:var(--card)}
@media (prefers-color-scheme:dark){.vmenu{--cbon:#0A84FF;--cboff:rgba(255,255,255,.07);--cbline:rgba(255,255,255,.32);--segon:#636366}}
.vmenu summary .ic.who{width:24px;height:24px}
.vmenu summary .vi{display:flex;flex:none}
.vmenu summary .vi-team,html.s-team .vmenu summary .vi-you{display:none}
html.s-team .vmenu summary .vi-team{display:flex}
.vmenu summary .vp{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The fan: each card steps right and turns a little more, and both shrink as the count grows, so ten still fit.
   When the chip is short of room, the fan gives way and its cards step by the width it
   has (100cqw), so the dot and the chevron keep their places. */
.vmenu .fan{--adv:min(12px,calc(40px / max(var(--n) - 1,1)));--step:min(8deg,calc(34deg / max(var(--n) - 1,1)));--mid:calc((var(--n) - 1) / 2);
  container-type:inline-size;position:relative;flex:0 1 auto;min-width:0;margin-right:auto;width:calc(40px + (var(--n) - 1) * var(--adv));height:26px}
.vmenu .fan .card{position:absolute;left:calc(10px + var(--i) * max(0px,min(var(--adv),(100cqw - 40px) / max(var(--n) - 1,1))));top:3px;width:20px;height:20px;border-radius:6px;background:var(--card);
  box-shadow:0 0 0 1.5px var(--card),0 1px 3px rgba(0,0,0,.28);transform:rotate(calc((var(--i) - var(--mid)) * var(--step)));transform-origin:50% 170%;
  transition:transform .35s cubic-bezier(.32,1.25,.5,1)}
.vmenu .fan .card .pm{display:grid;width:20px;height:20px;border-radius:6px;font-size:11px}
.vmenu summary:hover .fan .card{transform:rotate(calc((var(--i) - var(--mid)) * var(--step) * 1.25))}
.vmenu .pmenu-l{width:300px}
.vmenu .pmenu-l hr{flex:none;margin:6px 4px;border:0;border-top:.5px solid var(--sep)}
.vmenu .pmenu-l button{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border:0;border-radius:6px;background:none;font:inherit;font-size:14px;color:var(--label);text-align:left;cursor:pointer}
.vmenu .pmenu-l button:hover{background:var(--fill)}
.vmenu .pmenu-l .pk{flex:none;gap:12px;min-height:40px;font-weight:400}
.vmenu .pmenu-l .pk.all{font-weight:600}
.vmenu .pk .vn{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vmenu .pk-nc{margin:2px 10px 4px;font-size:12px;color:var(--label2)}
/* A check box: 18 px, rounded, a tick drawn in (or a dash for some) on system blue, as on a Mac. */
.vmenu .cb{flex:none;position:relative;width:18px;height:18px;border-radius:5px;background:var(--cboff);box-shadow:inset 0 0 0 1px var(--cbline),0 .5px 1px rgba(0,0,0,.06);transition:background-color .15s,box-shadow .15s,transform .1s}
.vmenu .cb svg{position:absolute;inset:0;width:18px;height:18px;fill:none;stroke:#FFFFFF;stroke-width:2.25;stroke-linecap:round;stroke-linejoin:round}
.vmenu .cb .tick{stroke-dasharray:13;stroke-dashoffset:13;transition:stroke-dashoffset .2s ease-out .03s}
.vmenu .cb .dash{opacity:0;transition:opacity .12s}
.vmenu [aria-checked=true]>.cb,.vmenu [aria-checked=mixed]>.cb{background:var(--cbon) linear-gradient(rgba(255,255,255,.16),rgba(255,255,255,0));box-shadow:inset 0 0 0 .5px rgba(0,0,0,.14),0 .5px 1.5px rgba(0,0,0,.14)}
.vmenu [aria-checked=true]>.cb .tick{stroke-dashoffset:0}
.vmenu [aria-checked=mixed]>.cb .dash{opacity:1}
.vmenu .pk:hover[aria-checked=false]>.cb{box-shadow:inset 0 0 0 1.5px var(--cbon)}
.vmenu .pk:active>.cb{transform:scale(.9)}
/* The last ticked box cannot be unticked: it shakes. */
.vmenu .pk.no>.cb{animation:yc-no .32s}
@keyframes yc-no{20%,60%{transform:translateX(-3px)}40%,80%{transform:translateX(3px)}}
/* The toggle, one line at the bottom: You | Team, a thumb that slides with the app's 0.5 s spring. */
.vmenu .pmenu-l .seg{position:relative;display:flex;flex:none;padding:3px;border-radius:11px;background:var(--fill)}
.vmenu .pmenu-l .seg::before{content:"";position:absolute;top:3px;bottom:3px;left:3px;width:calc(50% - 3px);border-radius:8px;background:var(--segon);box-shadow:0 1px 3px rgba(0,0,0,.16),0 0 0 .5px var(--sep);transition:transform 735ms ${SPRING}}
html.s-team .vmenu .pmenu-l .seg::before{transform:translateX(100%)}
.vmenu .pmenu-l .seg button{position:relative;z-index:1;flex:1 1 0;justify-content:center;gap:8px;width:auto;min-height:0;height:40px;padding:0 8px;border-radius:8px;background:none;font-size:15px;font-weight:600;color:var(--label2);transition:color .25s}
.vmenu .pmenu-l .seg button:hover{background:none;color:var(--label)}
.vmenu .pmenu-l .seg [aria-checked=true]{color:var(--label)}
.vmenu .pmenu-l .seg .ic{flex:none;width:24px;height:24px}
/* The expanded view's header is its picker (Dan, 2026-11-11): the view's icon, then All projects or the fan a size up,
   then the chevron, with no fill until hovered. The menu drops below it. The rail's chip goes in the expanded view. */
.v-kitchen .nav-foot .vmenu{display:none}
.vhead{margin:0}
.vhead summary{gap:8px;min-height:38px;margin-left:-8px;padding:3px 10px 3px 8px;border-radius:9px;background:none;font-size:20px;font-weight:700;letter-spacing:-.01em}
.vhead summary:hover,.vhead[open] summary{background:var(--fill)}
.vhead summary .ic.who{color:var(--label2)}
.vhead summary>.ic:last-child{flex:none;width:16px;height:16px;color:var(--label3)}
.vhead summary .vp{flex:0 1 auto}
.vhead .fan{--adv:min(15px,calc(52px / max(var(--n) - 1,1)));flex:none;margin-right:0;width:calc(34px + (var(--n) - 1) * var(--adv));height:32px}
.vhead .fan .card{left:calc(4px + var(--i) * var(--adv));top:3px;width:26px;height:26px;border-radius:7px}
.vhead .fan .card .pm{width:26px;height:26px;border-radius:7px;font-size:13px}
.vhead .pmenu-l{top:46px;right:auto;left:-8px}
@media (prefers-reduced-motion:reduce){.vmenu .pmenu-l .seg::before,.vmenu .cb .tick,.vmenu .fan .card{transition:none}}
html.s-team .you{display:none}
/* The Pass follows the view: in Your team it says what it cannot show yet, and none of your own calls. */
.team-pass,html.s-team .head-b>.folder,html.s-team .head .badge,html.s-team .head-h>.muted{display:none}
html.s-team .head-b>.team-pass{display:flex}
html.s-team.v-kitchen .team-wait{display:block}
.team-wait .tw-b{padding:16px 18px;border-radius:16px;background:var(--card);box-shadow:inset 0 0 0 .5px var(--sep)}
/* Your team, Open kitchen (step 4; mock v2, round 2, Dan 2026-11-10). The team's card replaces yours in the rail, and
   The Pass holds the team's calls with a quiet line under them. */
.team-card,.tpn{display:none}
html.s-team .stagenav:has(.team-card) .nav-card:not(.team-card){display:none}
html.s-team .team-card{display:flex}
html.s-team .stagenav>.nf[data-folder=pass]:has(.tpn) .n:not(.tpn){display:none}
html.s-team .stagenav>.nf[data-folder=pass] .tpn{display:block}
.team-card .tst{margin:0;cursor:default}
.gd.c-red{background:var(--red)}.gd.c-nc{background:none;box-shadow:inset 0 0 0 1.5px var(--gray)}
.segbar i.c-amber{background:var(--orange)}.segbar i.c-gray{background:var(--gray)}.segbar i.c-green{background:var(--green)}.segbar i.c-nc{background:var(--fill2)}
html.s-team .head-b>.team-pass.tp-live{display:block;padding:0;text-align:left}
.tp-live .lb.tsg{color:var(--label2)}.tp-live .lb.tsg b{font-weight:600;color:var(--label)}
.tcalm{display:flex;gap:9px;align-items:flex-start;margin:14px 12px 4px 4px;font-size:13px;line-height:1.45;color:var(--label2)}
.tcalm .ic{flex:none;width:18px;height:18px;color:var(--green)}
html.s-team .bar .stats{display:none}
/* The reader: Seen, the evidence, then Suggested. */
.tv{font-size:14px}
.tv .tvis{position:relative;margin-top:14px;padding:14px 16px;border-radius:12px;background:var(--card)}
.tv .vl{display:flex;align-items:baseline;gap:10px;margin-bottom:10px;font-size:12px;font-weight:600;color:var(--label2)}
.tv .vl>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* A long path keeps its file name: it cuts from the start. */
.tv .vl>span:has(>.mono){direction:rtl;text-align:left}
.tv .vl b{margin-left:auto;font-size:12.5px;color:var(--label);font-weight:600;white-space:nowrap}
.tv .vl b.red{color:var(--red)}
.tv .mono{font:500 12px var(--mono);color:var(--label2)}
.tv .kvs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 20px}
.tv .kv span{display:block;font-size:11.5px;color:var(--label2)}
.tv .kv b{display:block;font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tv .kv b.mono{font-size:12px;color:var(--label)}
/* The reader's bar says whether they have seen it, Not seen in red (docs/pass-definitions-v1_0.md); a PR the words
   name links in place (Dan, 2026-11-12: one place). */
.plate-bar .tsn{font-size:12px;color:var(--label2)}.plate-bar .tsn.no{color:var(--red);font-weight:600}
.team-plate .prl{color:inherit;text-decoration:underline;text-decoration-color:var(--sep);text-decoration-thickness:1px;text-underline-offset:.15em}
.team-plate .prl:hover{text-decoration-color:currentColor}
.tv .tquiet{display:flex;gap:10px;align-items:flex-start;margin:0 0 12px;padding:10px 12px;border-radius:10px;background:var(--fill);font-size:13px;line-height:1.45;color:var(--label2)}
.tv .tquiet b{color:var(--label);font-weight:600}
.tv .hz{flex:none;display:inline-block;width:22px;height:12px;margin-top:2px;border-radius:3px;background:repeating-linear-gradient(135deg,var(--fill2) 0 2px,transparent 2px 5px);box-shadow:inset 0 0 0 1px var(--fill2)}
.tv .raxis{display:flex;justify-content:space-between;margin-top:6px;font-size:11.5px;color:var(--label2);font-variant-numeric:tabular-nums}
.tv .wlg{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;font-size:11.5px;color:var(--label2)}
.tv .wlg span{display:inline-flex;align-items:center;gap:6px}
.tv .wlg i{display:inline-block;width:14px;height:8px;border-radius:2px;background:var(--fx-a1)}
.tv .wlg i.r{background:var(--red)}.tv .wlg i.a{background:none;box-shadow:inset 0 0 0 1.5px var(--red)}
.tv .tmore{margin:10px 0 0;font-size:12.5px;color:var(--label2)}
/* Main broken: the team's merges today, gray, red at the break (Dan, 2026-11-11: gray at rest, colour for the alarm), then the PRs that wait. */
.tv .ribbon{display:flex;flex-wrap:wrap;gap:3px;align-items:flex-end}
.tv .ribbon i{width:14px;height:22px;border-radius:3px;background:var(--fx-a1)}
.tv .ribbon i.r{background:var(--red);opacity:1;height:30px}
.tv .ribbon i.a{background:none;box-shadow:inset 0 0 0 1.5px var(--red);opacity:1}
.tv .tprs{display:flex;flex-wrap:wrap;gap:6px}
.tv .tpr{display:inline-flex;align-items:center;gap:6px;padding:3px 9px 3px 4px;border-radius:999px;background:var(--bg);box-shadow:inset 0 0 0 .5px var(--sep);font-size:12.5px;font-weight:600}
/* Failing: T3 Code's checks list, one red run a row. Stuck: the agent's last message. */
.tv .truns{list-style:none;margin:0;padding:0}
.tv .truns li{display:grid;grid-template-columns:14px minmax(0,1fr) auto auto;gap:10px;align-items:center;min-height:28px;font-size:13px}
.tv .truns .ic{width:14px;height:14px;color:var(--red)}
.tv .truns span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tv .truns code{font:11.5px var(--mono);color:var(--label2)}
.tv .truns time{min-width:5ch;text-align:right;font-size:12px;color:var(--label2);font-variant-numeric:tabular-nums}
.tv .tmsg{margin:0;font-size:14px;line-height:1.5}
.tv :is(.truns span,.tmsg).nc{color:var(--label2)}
/* Too big's diff panel: T3 Code's inline right panel (PreviewPanelShell.tsx, usePreviewPanelInlineSize.ts). The bar's
   toggle opens it beside the reader, which narrows; it does not cover it. 540 px by default, at least 360, at most 70%
   of the window, and the reader keeps 360; its left edge drags (RightPanelResizeHandle.tsx). It opens at once, as T3
   Code's panels do by default (panel animation 0 ms). A reader too narrow for both shows the panel alone, under the bar
   and its toggle. */
.plate-bar .dp-t{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;margin-left:auto;padding:0;border:0;border-radius:6px;background:transparent;color:var(--label2);cursor:pointer}
.plate-bar .dp-t:hover{background:var(--fill);color:var(--label)}
.plate-bar .dp-t[aria-pressed="true"]{background:var(--fill);color:var(--label)}
.plate-bar .dp-t .ic{width:16px;height:16px}
.dp{display:none}
.team-plate.dp-on{display:grid;grid-template:auto minmax(0,1fr)/minmax(0,1fr) auto}
.team-plate.dp-on>.plate-bar{grid-column:1/-1}
/* The reader's column is the action bar's container while the panel is open, so the bar fits the column, not the plate. */
.team-plate.dp-on>.plate-main{grid-area:2/1;min-width:0;container-type:inline-size}
.team-plate.dp-on>.dp{position:relative;grid-area:2/2;display:flex;flex-direction:column;min-height:0;width:min(var(--dpw,540px),max(360px,min(70vw,100cqw - 360px)));border-left:.5px solid var(--sep)}
/* At 980 px or less, T3 Code's right panel is its sheet (rightPanelLayout.ts, RightPanelSheet.tsx, ui/sheet.tsx): modal
   at the window's right edge, over the page at 60% and blurred, 42% of the window wide up to 28rem and at least 20rem.
   (T3's narrower sheet from 760 px down never shows here: at that width the page is the phone screen.) No resize edge,
   and no slide: T3's panel animations are off by default. */
dialog.dp-sheet{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;color:inherit;display:flex;justify-content:flex-end;overflow:hidden}
dialog.dp-sheet:not([open]){display:none}
dialog.dp-sheet::backdrop{background:color-mix(in srgb,var(--bg) 60%,transparent);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
dialog.dp-sheet>.dp{display:flex;flex-direction:column;min-height:0;height:100%;width:min(42vw,28rem);min-width:20rem;max-width:28rem;background:var(--pop);border-left:.5px solid var(--sep);box-shadow:0 10px 15px -3px rgba(0,0,0,.05),0 4px 6px -4px rgba(0,0,0,.05)}
dialog.dp-sheet .dp-rz{display:none}
.dp-rz{position:absolute;top:0;bottom:0;left:0;z-index:2;width:4px;cursor:col-resize;touch-action:none;user-select:none}
.dp-rz::after{content:"";position:absolute;top:0;bottom:0;left:0;width:1px;transform:translateX(-50%);transition:background-color .15s}
.dp-rz:hover::after,.dp-rz:active::after{background:var(--sep)}
.team-plate .dst{display:inline-flex;gap:4px;font:11px var(--mono);font-variant-numeric:tabular-nums}
.team-plate .dst .a{color:var(--green)}.team-plate .dst .d{color:var(--red)}
.dp-h{display:flex;align-items:center;gap:8px;flex:none;height:40px;padding:0 8px 0 16px;border-bottom:.5px solid var(--sep);font-size:13px}
.dp-h>:not(.base,.dp-sp){flex:none}.dp-h .vs{color:var(--label2)}
.dp-h .base{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px var(--mono)}
.dp-sp{flex:1}
.dp-i{display:inline-flex;align-items:center;justify-content:center;width:28px;height:24px;border-radius:6px;color:var(--label2)}
.dp-i:hover{background:var(--fill);color:var(--label)}
.dp-i .ic{width:13px;height:13px}
/* T3's header switches (DiffPanel.tsx): ghost icon buttons, pressed when on; the chevrons show what a click does. */
button.dp-i{padding:0;border:0;background:transparent;font:inherit;cursor:pointer}
button.dp-i .ic{width:14px;height:14px}
button.dp-i[aria-pressed=true]{background:var(--fill);color:var(--label)}
button.dp-i:focus-visible,.dpt:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
[data-dp-all] .dp-co,[data-dp-all][data-open] .dp-ex{display:none}[data-dp-all][data-open] .dp-co{display:block}
/* T3's PR code tab's "N test files hidden": a link-style button that shows them again. */
.dpt{display:block;margin:4px 16px 0;padding:2px 0;border:0;background:none;font:12px var(--sans);color:var(--label2);cursor:pointer;text-underline-offset:4px}
.dpt:hover{color:var(--label);text-decoration:underline}
.dp-l{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:4px 0}
.dp-l:focus{outline:none}.dp-l:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
/* The code, as T3 Code's diff panel draws it: @pierre/diffs's own styles in the host's shadow root, on the panel's
   surface and in the board's fonts, as T3 sets them (index.css), light or dark with the board. */
.dpv{color-scheme:light dark;--diffs-font-family:var(--mono);--diffs-header-font-family:var(--sans);--diffs-bg:var(--card);--diffs-light-bg:var(--card);--diffs-dark-bg:var(--card)}
dialog.dp-sheet .dpv{--diffs-bg:var(--pop);--diffs-light-bg:var(--pop);--diffs-dark-bg:var(--pop)}
:root[data-theme=dark] .dpv{color-scheme:dark}:root[data-theme=light] .dpv{color-scheme:light}
.dpr{display:flex;align-items:center;gap:8px;height:32px;padding:0 16px;font-size:13px}
.dpr>.ic{flex:none;width:14px;height:14px;color:var(--label2)}
.dpr .pa{display:flex;flex:1;min-width:0;overflow:hidden;white-space:nowrap}
.dpr :is(.dir,.fn){min-width:0;overflow:hidden;text-overflow:ellipsis}
.dpr .dir{flex:0 1000 auto}.dpr .fn{flex:0 1 auto}
.dpr .dst{flex:none}
.dpr.x{opacity:.45}
.dpm{display:inline-flex;align-items:center;height:24px;margin:4px 8px;padding:0 8px;border-radius:6px;font-size:12px;font-weight:500;color:var(--label2);text-decoration:none}
.dpm:hover{background:var(--fill);color:var(--label)}
.dpn{margin:8px 16px;font-size:12.5px;color:var(--label2)}
/* Overlap: the two threads, then the file's line map with the shared lines boxed. */
.tv .duo{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.tv .tcard{padding:12px 14px;border-radius:12px;background:var(--card)}
.tv .tcard .h{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}
.tv .tcard .h .lb{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:500;color:var(--label2)}
.tv .tcard .t{margin-top:6px;font-size:14px;font-weight:600}
.tv .tcard .m{margin-top:2px;font-size:12.5px;color:var(--label2)}
.tv .fmap{position:relative;margin-top:4px}
.tv .fmap .tr{display:grid;grid-template-columns:52px 1fr;align-items:center;gap:10px;height:26px;font-size:12.5px;font-weight:600}
.tv .fmap .tr>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tv .fmap .lane{position:relative;height:12px;border-radius:3px;background:var(--fill)}
.tv .fmap .lane i{position:absolute;top:0;bottom:0;min-width:2px;border-radius:3px;background:var(--label2)}
.tv .fmap .band{position:absolute;top:-3px;height:58px;min-width:3px;border-radius:5px;background:var(--red-t);box-shadow:inset 0 0 0 1.5px var(--red)}
.tv .fmap .ticks{display:grid;grid-template-columns:52px 1fr;gap:10px;margin-top:4px;font-size:11px;color:var(--label2)}
.tv .fmap .ticks div{display:flex;justify-content:space-between;font-variant-numeric:tabular-nums}
/* Faces: initials on a colour from the name. */
.av{display:inline-grid;place-items:center;flex:none;width:22px;height:22px;border-radius:50%;background:hsl(var(--h) 52% 46%);font:700 9.5px/1 var(--sans);color:#fff;letter-spacing:.02em}
.av.sm{width:18px;height:18px;font-size:8px}
/* Your team, expanded: the rows' panel, scoped to the team board. */
/* The header (You and Your team, expanded): the picker alone. */
:is(.you,.tboard,.team-wait)>.you-h{display:flex;flex:none;align-items:center;padding:6px 2px 14px}
.tboard .you-b{display:flex;flex-direction:column;gap:12px;container-type:inline-size}
.tboard .you-b>*{min-width:0}
.tboard .pnl{min-width:0;padding:12px 14px 14px;border-radius:16px;background:var(--card);box-shadow:inset 0 0 0 .5px var(--sep)}
/* The rows fill the column down to The Pass's foot (Dan, 2026-11-12), the key at their foot as in the mock. */
.tboard .ok-p{display:flex;flex:1 0 auto;flex-direction:column}
.ok-foot{display:flex;flex-direction:column;gap:6px;margin-top:auto;padding-top:10px;font-size:12px;color:var(--label2)}
.ok-foot .lg{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0;font-weight:500}
.ok-foot .lg>span{display:inline-flex;align-items:center;gap:5px}
.tboard .nc-l{margin:0;font-size:14px;line-height:1.45;color:var(--label2)}
.tboard .nc-l b{font-weight:600;color:var(--label)}
/* Your team, expanded (step 4 PR B; mock v2, approved 2026-11-10): the board in the middle, The Pass as a column of
   cards on the right, each with its suggestion and Open. */
.tboard,.tcol,.head-h>.tpm{display:none}
html.s-team.v-kitchen .head-h>.muted.tpm{display:block}
html.s-team.v-kitchen .tboard{display:flex;flex-direction:column;grid-area:you;min-width:0;min-height:0}
@media (min-width:761px){html.s-team.v-kitchen .tboard .you-b{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 2px}}
html.v-kitchen .tp-live .folder[data-folder=team]{display:none}
html.v-kitchen .tp-live .tcol{display:flex;flex-direction:column;gap:8px}
.xc{padding:11px 13px 12px;border-radius:14px;background:var(--card);box-shadow:inset 0 0 0 .5px var(--sep);cursor:pointer}
.xc:hover{box-shadow:inset 0 0 0 .5px var(--sep),var(--sh1)}
.xk{display:flex;align-items:baseline;gap:8px;margin:0;font-size:12px;font-weight:600}
.xk .t-red{color:var(--red)}.xk .t-amber{color:var(--orange)}.xk .t-blue{color:var(--pass)}
.xk .age{margin-left:auto;font-weight:500;color:var(--label2);font-variant-numeric:tabular-nums}
.xt{margin:4px 0 0;font-size:14px;font-weight:600;line-height:1.3}
.xw{margin:2px 0 0;font-size:12.5px;color:var(--label2)}
.xa{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.xb{display:inline-flex;align-items:center;min-height:30px;padding:0 12px;border:0;border-radius:8px;background:var(--fill);font:600 13px/1.2 var(--sans);color:var(--label);cursor:pointer}
.xb:hover{background:var(--fill2)}
.xb.fill{background:var(--accent);color:#fff}
.xb.fill:hover{background:#0068D1}
/* Open kitchen's rows (flow mock round 3.3): agents as squares, code areas as cells, merged today. Red and amber are
   calls and nothing else; gray steps count agents, and dark mode turns them so more is brighter. */
.sw{display:inline-block;width:14px;height:8px;border-radius:2px;background:var(--fill2)}
.ok-box{position:relative}.ok-wrap{overflow-x:auto;overscroll-behavior-x:contain}
.okr{display:block;width:100%;min-width:640px;height:auto;font-size:12px}
.okr .dot{fill:var(--fx-dot)}
.okr .zlbl{font-size:11.5px;font-weight:600;fill:var(--label2)}
.okr .zlbl.col.lit{fill:var(--label)}
.okr .pjname{font-size:11px;font-weight:700;fill:var(--label)}
.okr .pjrule{stroke:var(--sep);stroke-width:1}
.okr .rowname{font-size:12.5px;font-weight:600;fill:var(--label)}
.okr .rowname.strong{font-weight:700}.okr .rowname.muted{fill:var(--label2)}
.okr [data-fold],.okr [data-team-open],.okr [data-drill]{cursor:pointer}
.okr .need{font-weight:600;fill:var(--red)}
/* French Brigade (client/brigade.ts): names at the left and over each sign-off node; leads above you outlined. */
.fbr .fbg{cursor:pointer;transition:fill .15s}.fbr .fbg.lit{fill:var(--fx-hov)}
.fbr .fbn text{font-size:11.5px;font-weight:600;fill:var(--label);transition:fill .15s}
.fbr .fbn.lit text{fill:var(--fx-hov)}
.fbr .fbn text{paint-order:stroke;stroke:var(--card);stroke-width:3px;stroke-linejoin:round}
.fbr .fbn.r-above text{fill:var(--label2)}.fbr .fbn.r-above rect{fill:none;stroke:var(--label3,var(--label2));stroke-width:1}
.fbr .fbn:not(.r-above) rect{fill:var(--card);stroke:var(--sep);stroke-width:1}
/* A person opened: one band per thread, packed, so the line between two threads is the same 1 px hairline the
   full chart draws inside a bundle (.strand). */
.fb-one .band{stroke-width:1px;vector-effect:non-scaling-stroke}
.you-who{margin-left:10px;font-size:17px;font-weight:600;color:var(--label);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fbr .band[data-who],.fbr [data-team-open]{cursor:pointer}
.fx-chip .sw.up{background:none;box-shadow:inset 0 0 0 1px var(--label2)}
.okr .podband{fill:var(--fx-zone-b)}
.okr .mnum{font-size:11.5px;fill:var(--label2);font-variant-numeric:tabular-nums}
.okr .mnum.strong{fill:var(--label);font-weight:600}
.okr .ag{stroke-width:1.5;transition:fill .15s,stroke .15s,opacity .15s}
.okr .ag.working{fill:var(--fx-a1)}.okr .ag.idle{fill:none;stroke:var(--fx-a1)}
.okr .ag.red{fill:var(--red)}.okr .ag.amber{fill:var(--orange)}
.okr .ag.out{fill:none;stroke:var(--fx-a1);stroke-dasharray:2 2}
.okr .cell{transition:fill .15s,opacity .15s}
.okr .cell.n1{fill:var(--fx-a0)}.okr .cell.n2{fill:var(--fx-a1)}.okr .cell.n3{fill:var(--fx-a2)}.okr .cell.red{fill:var(--red)}
.okr .mbar{fill:var(--merged);transition:fill .15s,opacity .15s}
.okr .olink{stroke:var(--red);stroke-width:3;stroke-linecap:round}
.okr .olink.halo{stroke:var(--card);stroke-width:7;pointer-events:none}
.okr .ag.working.lit,.okr .cell.lit:not(.red),.okr .mbar.lit{fill:var(--fx-hov)}
.okr .ag.lit{stroke:var(--fx-hov);stroke-width:2}
.okr .cell.red.lit{stroke:var(--fx-hov);stroke-width:2}
.fx-focus .okr .ag:not(.lit),.fx-focus .okr .cell:not(.lit),.fx-focus .okr .mbar:not(.lit){opacity:.45}
.okr [tabindex]:focus-visible{outline:2px solid var(--fx-hov);outline-offset:2px}
.okk .sq{display:inline-block;width:10px;height:10px;border-radius:2.5px;box-sizing:border-box}
.okk .sq.working{background:var(--fx-a1)}.okk .sq.idle{box-shadow:inset 0 0 0 1.5px var(--fx-a1)}
.okk .sq.red{background:var(--red)}.okk .sq.amber{background:var(--orange)}.okk .sq.out{border:1.5px dashed var(--fx-a1)}
.okk .sq.n1{background:var(--fx-a0)}.okk .sq.n2{background:var(--fx-a1)}.okk .sq.n3{background:var(--fx-a2)}
.tcol .xc.lit{outline:1.5px solid var(--fx-hov);outline-offset:-1.5px}
`;
// Appearance (theme.ts): every dark and light rule also answers to the html element's data-theme.
// The pictures in Settings → Layout and the ⌘K bar's Appearance and Density steps (theme.ts).
const MINIS = minis();
const tile = (name: string, value: keyof typeof MINIS, label: string): string => `<label class="look"><input type="radio" name="${name}" value="${value}" aria-label="${label}">${MINIS[value]}<span class="look-n">${label}</span></label>`;
const STYLE = onScale(onTheme(CSS + APP_CSS + BAR_CSS + MINI_CSS) + miniCss(CSS + APP_CSS + BAR_CSS));


const page = (body: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>Yes Chef</title>
<script>(function(){var c='v-pass d-default';try{var s=localStorage;c=(s.getItem('yc.view')==='kitchen'?'v-kitchen':'v-pass')+' d-'+({comfortable:1,compact:1}[s.getItem('yc.density')]?s.getItem('yc.density'):'default');var t=s.getItem('yc.theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}document.documentElement.className=c})()</script><style>${STYLE}</style></head><body class="pass-app"><section class="only-phone" aria-labelledby="op-t"><span class="op-logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON.cloche}</svg></span><h1 id="op-t">Yes Chef runs on your Mac</h1><a class="btn fill" href="https://yeschef.codes/download" target="_top" rel="noopener">Get the Mac app</a><p>Or open this page on a computer.</p></section><main id="app">${body}</main>
<dialog class="sheet" id="sheet" aria-label="Ticket"></dialog>
<dialog id="viewer" aria-label="Screenshot"><img alt=""><div class="v-bar"><button type="button" data-v="prev" aria-label="Previous screenshot">‹</button><span class="v-cap"></span><button type="button" data-v="next" aria-label="Next screenshot">›</button><span class="v-end"><span class="v-keys"><span class="v-arrows"><kbd>←</kbd> <kbd>→</kbd> move&nbsp;&nbsp;</span><kbd>esc</kbd> close</span><button type="button" data-v="close" aria-label="Close">✕</button></span></div></dialog>
<div id="toast" popover="manual" role="status"><span class="t-msg"></span><span class="t-acts"></span></div>
<dialog id="settings" aria-labelledby="settings-t"><div class="set-wrap">
<nav class="set-nav" aria-label="Settings sections"><h2 id="settings-t">Settings</h2>
<button type="button" class="set-tab" data-tab="layout" aria-current="true">Layout</button>
<button type="button" class="set-tab" data-tab="rules">Rules</button>
<button type="button" class="set-tab" data-tab="keys">Shortcuts</button></nav>
<div class="set-panes">
<section class="set-pane" data-pane="layout">
<fieldset class="looks"><legend>Appearance</legend>
${tile('theme', 'system', 'System')}${tile('theme', 'light', 'Light')}${tile('theme', 'dark', 'Dark')}
</fieldset>
<fieldset class="looks"><legend>Density</legend>
${tile('density', 'default', 'Default')}${tile('density', 'comfortable', 'Comfortable')}${tile('density', 'compact', 'Compact')}
</fieldset>
</section>
${kitchenPane({ rules, projects, error: rulesError })}
<section class="set-pane" data-pane="keys" hidden><div class="kx-top"><label class="kx-q"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><input type="search" id="kx-q" placeholder="Search shortcuts" aria-label="Search shortcuts" autocomplete="off" spellcheck="false"></label></div>
<div id="kx-list"></div><p class="kx-live" role="status" aria-live="polite"></p>
<div class="kx-foot"><p class="kx-file">Your shortcuts, in the shape of T3 Code’s keybindings.json and with its rules: a key, a command, and when it applies.</p><span class="kx-btns"><button type="button" class="btn kx-b" data-kx-file hidden>Open the file</button><button type="button" class="btn kx-b" data-kx-resetall>Reset all</button></span><p class="kx-note" role="status" hidden></p></div></section>
</div></div>
<p class="set-done"><span role="status">Saved on this Mac.</span><button type="button" class="btn fill" data-settings-done><span class="bl">Done</span><kbd>esc</kbd></button></p></dialog>
<dialog id="launch" aria-labelledby="launch-t"><form class="act launch" method="post" action="/act">
<input type="hidden" name="nonce" value="">
<h2 id="launch-t">New thread in T3 Code</h2>
<label class="lf"><span>Project</span><select name="project" required></select></label>
<label class="lf"><span>What should the agent do?</span><textarea name="prompt" rows="6" maxlength="60000" placeholder="The task, as you would write it in T3 Code"></textarea></label>
<label class="lf"><span>Title <span class="muted">optional, else the first line</span></span><input type="text" name="title" maxlength="120"></label>
<fieldset class="lf-ws"><legend>Workspace</legend>
<label><input type="radio" name="workspace" value="worktree" checked> New worktree <span class="muted">its own branch and folder</span></label>
<label><input type="radio" name="workspace" value="root"> Project checkout</label></fieldset>
<div class="acts"><button type="submit" name="kind" value="launch" class="btn fill primary" data-what="the new thread"><span class="bl">Launch</span><kbd>⌘↵</kbd></button><button type="button" class="btn quiet" data-launch-cancel><span class="bl">Cancel</span><kbd>esc</kbd></button></div>
<p class="result" role="status"></p>
<p class="lf-note muted">T3 Code runs it with its default model, at the level you approved for the Yes Chef app. The project's rules go with it (Settings → Rules).</p>
</form></dialog>
${BAR_HTML}
<script>
(function(){
  ${keysCore}
  ${barCore}
  ${installBar}
  (${passScript})(${JSON.stringify(MINIS)});
})();
</script></body></html>`;

// A form over the limit is refused whole, never cut: a cut body could drop the field that names the action.
const MAX_FORM = 64 * 1024;
// An oversized body is drained, not destroyed, so the page gets the 413 and can let Dan shorten the note
// (PR-Agent r7 on #12). Past MAX_DRAIN the socket is cut: nobody needs to send that much.
const MAX_DRAIN = 1024 * 1024;
function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let body = '', seen = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      seen += chunk.length;
      if (seen > MAX_DRAIN) { req.destroy(); return reject(Object.assign(new Error('too large'), { tooLarge: true })); }
      if (seen <= MAX_FORM) body += chunk;
    });
    req.on('end', () => seen > MAX_FORM ? reject(Object.assign(new Error('too large'), { tooLarge: true })) : resolve(Object.fromEntries(new URLSearchParams(body))));
    req.on('error', reject);
  });
}
// A Hold keeps the time it was first given, so a retry after midnight does not add a day (PR-Agent r7 on #12).
const holds = new Map<string, string>();
// Calls answered from this Pass, so the sheet shows the answer until the agent picks it up.
const answered = new Map<string, Answered>();
/** One line of the action log: who asked for what, and what came of it. */
type AuditLine = Record<string, unknown>;
const audit = (line: AuditLine): void => { try { appendFileSync(join(OUT, 'actions.jsonl'), JSON.stringify(line) + '\n', { mode: 0o600 }); } catch { /* the log never blocks an action's result */ } };

// The team (step 3b, client/teamhost.ts). Its state holds private keys: the desktop app seals it with the Keychain-held
// key (desktop/main.ts, team-please and team-save); the web prototype keeps it in memory only.
let teamMem: TeamState | null = null;
let teamSaves = 0;
const teamStore: TeamStore = pipe ? {
  load: () => new Promise<TeamState | null>((resolve, reject) => {
    const timer = setTimeout(() => { pipe.off(hear); reject(new Error('the Keychain did not answer')); }, 120000);
    function hear(m: AppMessage | null | undefined): void { if (m && m.type === 'team') { clearTimeout(timer); pipe!.off(hear); if (m.error) reject(new Error(String(m.error))); else resolve((m.state || null) as TeamState | null); } }
    pipe.on(hear);
    pipe.send({ type: 'team-please' });
  }),
  // Resolves once the app has sealed and written it, and rejects when it did not, so a teammate's action waits for its
  // saved id (PR-Agent r3 on public #7).
  save: (state) => new Promise<void>((resolve, reject) => {
    const id = ++teamSaves;
    const timer = setTimeout(() => { pipe.off(hear); reject(new Error('the Keychain did not answer')); }, 120000);
    function hear(m: AppMessage | null | undefined): void { if (m && m.type === 'team-saved' && m.id === id) { clearTimeout(timer); pipe!.off(hear); if (m.error) reject(new Error(String(m.error))); else resolve(); } }
    pipe.on(hear);
    pipe.send({ type: 'team-save', id, state });
  }),
} : { load: () => teamMem, save: (state) => { teamMem = state; } };
const team = teamHost({
  store: teamStore,
  // A teammate's action runs as one of this dev's own, through the same capped sign-in, with the sender's name on it.
  run: async (input, prefix, extra) => {
    if (!status.ok) return { status: 503, text: 'Not checked: this board is not current.' };
    if (!canOperate) return { status: 403, text: 'Not run: this Yes Chef is signed in read only.' };
    const out = await act({ board, t3: t3!, input, holds: extra?.holds || holds, answered: extra?.answered || answered, projects, rules, prefix });
    audit({ at: new Date().toISOString(), kind: input.kind, thread: input.thread, login: 'teammate', status: out.status });
    if (out.status === 200) wake?.();
    return out;
  },
  boardOf: () => ({ board, ok: status.ok, at: status.at }),
  // T3 Code's project list names each project it gives (t3_project_list).
  projectsOf: () => projects as readonly HostProject[],
  t3Ok: () => status.ok,
});

// One path for every action, whichever door it came through (the tailnet page or the desktop app).
async function runAct(input: Record<string, string>, line: AuditLine): Promise<ActResult> {
  if (input.kind === 'team') {
    const out = await team.act(input);
    audit({ ...line, team: String(input.op || '').slice(0, 20), status: out.status });
    return out;
  }
  if (input.kind === 'rules') {
    // A save of one rule older than a save of the same rule this page already sent is skipped: two saves that cross
    // on the way land in the order they were made (PR-Agent r8 on #49). Other rules are never held back by it
    // (r9). The answer is still the saved set.
    const page = String(input.page || '').slice(0, 64), seq = Number(input.seq);
    const slot = JSON.stringify([page, String(input.scope || ''), String(input.key || '')]);
    if (page && Number.isSafeInteger(seq)) {
      if (seq <= (rulesSeq.get(slot) || 0)) return { status: 200, text: JSON.stringify(rulesNow()) };
      rulesSeq.delete(slot); rulesSeq.set(slot, seq);
      if (rulesSeq.size > 500) rulesSeq.delete(rulesSeq.keys().next().value!);
    }
    // One rule at a time, on top of the saved rules; the answer is the whole saved set, for the page to show.
    const out = changeRule(rules, { scope: String(input.scope || ''), key: String(input.key || ''), value: String(input.value ?? ''), reset: input.reset === '1' });
    if (out.error) return { status: 400, text: out.error };
    // A new file, then a rename: a failed write never leaves the saved rules half written.
    const tmp = RULES_FILE + '.saving';
    try { writeFileSync(tmp, JSON.stringify(out.rules, null, 2) + '\n', { mode: 0o600 }); renameSync(tmp, RULES_FILE); }
    catch (ex) { return { status: 500, text: 'Not saved: ' + String((ex as Fault).code || (ex as Fault).message).slice(0, 80) }; }
    rules = out.rules!; rulesError = ''; rulesRev = Math.max(rulesRev + 1, Date.now());
    audit({ ...line, saved: `rule ${input.key}` });
    wake?.();
    return { status: 200, text: JSON.stringify(rulesNow()) };
  }
  if (input.kind === 'launch' && rulesError) return { status: 409, text: `Not launched: ${rulesError} Change any rule in Settings → Rules to save them again.` };
  if (!status.ok || !live.live()) return { status: 503, text: 'The board is not checked right now, so the Pass will not act. Try again after the next update.' };
  // A read-only sign-in holds no operate scope: T3 Code would refuse every action, so say why up front.
  if (!canOperate) { audit({ ...line, refused: 'read-only' }); return { status: 403, text: 'Yes Chef is signed in read only. To act, quit, start it again and approve a level that covers your threads.' }; }
  let out: ActResult;
  try { out = await act({ board, t3: t3!, input, holds, answered, projects, rules }); }
  catch (err) {
    const ex = err as Fault;
    // T3 Code refused the sign-in itself (401) before any tool ran. The board no longer polls MCP, so this is
    // often where a revoked sign-in shows first: the app asks for a new one, as a failed poll used to.
    if (ex.auth) {
      audit({ ...line, refused: 'signed-out' });
      if (pipe && !authLost) { authLost = true; pipe.send({ type: 'auth-lost' }); }
      return { status: 401, text: 'T3 Code ended Yes Chef\'s sign-in, so nothing was sent. Sign in again, then send it.' };
    }
    // T3 Code checks its limits before it changes anything: a typed denial means nothing happened.
    if (/capability_denied/.test(ex.message)) {
      audit({ ...line, refused: 'capability_denied' });
      return { status: 403, text: 'T3 Code refused: this thread runs at a higher level than Yes Chef was approved for. Nothing was sent.' };
    }
    // T3 may have taken the action before the reply failed: say "not confirmed", never "nothing changed".
    audit({ ...line, unconfirmed: String(ex.message).slice(0, 200) });
    return { status: 502, text: 'Not confirmed: T3 did not answer clearly (' + String(ex.message).slice(0, 120) + '). Check the thread in T3 before you send again.' };
  }
  audit({ ...line, status: out.status });
  if (out.status === 200) wake?.();
  return out;
}

// The desktop app's door (desktop/main.ts): actions arrive over the IPC pipe that only the app that started
// this process holds. No other process on this Mac can write to it, so the tailnet checks do not apply here.
// The HTTP /act route above keeps refusing every local caller.
if (pipe) {
  pipe.on(async (m) => {
    if (!m || m.type !== 'act' || typeof m.body !== 'string') return;
    let out: ActResult;
    if (m.body.length > MAX_FORM) out = { status: 413, text: 'That is too long to send. Shorten the note.' };
    else {
      const input = Object.fromEntries(new URLSearchParams(m.body));
      out = await runAct(input, { at: new Date().toISOString(), kind: input.kind, thread: input.thread, login: 'desktop app' });
    }
    pipe.send({ type: 'acted', id: m.id, status: out.status, text: out.text });
  });
}

/** The pages and images, for both doors: the web prototype's HTTP server and the desktop app's pipe. */
/** A page or a file: its status, headers and body. */
interface Routed { status: number; headers: Record<string, string>; body: string | Buffer }
// Too big's code, from T3 Code as its diff panel reads it, through the board's read-only key (client/diffs.ts). With
// host github.com, any T3 project can ask for any PR its GitHub sign-in sees, so the first one does.
const diffs = createDiffs({ origin: ORIGIN, keys, project: () => projects[0]?.id ?? null });
/** The PRs the Too big calls on the board name: the only ones /diff reads. */
function bigPrs(): PrRef[] {
  const v = team.view();
  const ok = openKitchen(v && { ...v, me: { ...v.me, id: v.me.id ?? null } }, { now: Date.now() });
  return ok.pass.filter((c) => c.kind === 'big').flatMap((c) => c.prs.map((pr) => ({ repo: pr.repo, n: pr.n })));
}
/** A page, a file, or a PR's code: the code is the one answer that waits on T3 Code. */
async function routeAny(url: URL): Promise<Routed> {
  return (await diffRoute(url, { diffs, shown: bigPrs })) ?? route(url);
}

function route(url: URL): Routed {
  // ?p=A&p=B: the projects picked in the view menu; no p is All projects.
  const picked = pickedFrom(url.searchParams);
  // fx=WxH: the size the page has for You's chart, so the river fills it (client/flow.ts fitFrom).
  const app = (): string => renderApp({ board, picked, link, status, origin: ORIGIN, answered, projects, rules: rulesNow(), fit: fitFrom(url.searchParams), fold: url.searchParams.getAll('fold'), who: url.searchParams.get('who') });
  const html = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  const teamPage = team.route(url);
  if (teamPage) return teamPage;
  if (url.pathname === '/') return { status: 200, headers: html, body: page(app()) };
  if (url.pathname === '/app') return { status: 200, headers: html, body: app() };
  if (url.pathname.startsWith('/icon/')) {
    // A bad address or a file that went away is a 404, never a crash.
    let icon: Icon | null | undefined = null;
    try { icon = iconFiles.get(decodeURIComponent(url.pathname.slice(6))); } catch { icon = null; }
    if (!icon) return { status: 404, headers: {}, body: '' };
    // An SVG opened directly must not run script on the Pass's origin.
    return { status: 200, headers: { 'content-type': icon.type, 'cache-control': 'max-age=300',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" }, body: icon.body };
  }
  if (url.pathname.startsWith('/img/')) {
    // A screenshot: only one an agent's message on the current board names, under the home folder or /tmp,
    // with an image extension and image bytes, up to 20 MB. Anything else is a 404.
    const src = shotFiles.get(url.pathname.slice(5));
    const file = src && shotPath(src, { home: homedir(), roots: SHOT_ROOTS });
    let body: Buffer | null = null;
    try { if (file && statSync(file).isFile() && statSync(file).size <= 20 * 1024 * 1024) body = readFileSync(file); } catch { body = null; }
    if (!body || !isShot(body)) return { status: 404, headers: {}, body: '' };
    return { status: 200, headers: { 'content-type': SHOT_TYPES[extname(file!).toLowerCase()]!, 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" }, body };
  }
  if (url.pathname === '/healthz') return { status: status.ok ? 200 : 503, headers: {}, body: status.ok ? 'ok' : String(status.error || '') };
  return { status: 404, headers: {}, body: '' };
}

// The desktop app's window asks for a page over the pipe: { type: 'get', id, path } -> { type: 'got', id, status, headers, body }.
// Only reads: actions keep their own message above.
if (pipe) {
  pipe.on((m) => {
    if (!m || m.type !== 'get' || typeof m.path !== 'string') return;
    const id = m.id;
    Promise.resolve().then(() => routeAny(new URL(m.path as string, 'http://x'))).catch((): Routed => ({ status: 500, headers: {}, body: 'The Pass could not build that page.' })).then((out) => {
      const body = Buffer.isBuffer(out.body) ? out.body : Buffer.from(String(out.body));
      pipe.send({ type: 'got', id, status: out.status, headers: out.headers, body: body.toString('base64') });
    });
  });
}

const web = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  if (req.method === 'POST' && url.pathname === '/act') {
    const reply = (status: number, text: string): ServerResponse => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(text);
    let input: Record<string, string>, line: AuditLine;
    try {
      // A socket that closed has no remote port: no netstat row matches it, so the guard refuses (client/guard.ts).
      const why = await refuse({ headers: req.headers, peerPort: req.socket.remotePort as number, serverPort: PORT, origin: PAGE_ORIGIN, allowPath: ALLOW });
      input = await readForm(req);
      line = { at: new Date().toISOString(), kind: input.kind, thread: input.thread, login: req.headers['tailscale-user-login'] || '-' };
      if (why) { audit({ ...line, refused: why }); return reply(403, why); }
    } catch (ex) {
      return reply((ex as Fault).tooLarge ? 413 : 400, (ex as Fault).tooLarge ? 'That is too long to send. Shorten the note.' : 'The Pass could not read that request.');
    }
    const out = await runAct(input, line);
    return reply(out.status, out.text);
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const out = await routeAny(url).catch((): Routed => ({ status: 500, headers: {}, body: 'The Pass could not build that page.' }));
  res.writeHead(out.status, out.headers).end(out.body);
});
// The desktop app opens no port (Dan, 2026-11-08): its window reads the pages over the IPC pipe instead
// (desktop/main.ts, the yeschef:// scheme). The web prototype keeps its local address.
if (!DESKTOP) web.listen(PORT, '127.0.0.1', () => console.log(`The Pass prototype on http://127.0.0.1:${PORT} (T3: ${ORIGIN})`));

// Stop: end the stream and revoke its key, so no read-only key outlives Yes Chef. The app asks over the pipe before
// it quits (desktop/main.ts); Ctrl-C or a kill does the same here. A run that dies without it leaves a key that the
// next start revokes (keys.sweep).
let stopping: Promise<void> | null = null;
function stopLive(): Promise<void> {
  return (stopping ??= (async () => {
    changes.stop(); baseChecks.stop(); prSizes.stop();
    await live.stop();
    try { console.log(`Revoked ${await keys.revokeMine()} read-only stream key(s).`); }
    catch (ex) { console.log(`Could not revoke the stream key: ${String((ex as Fault).message).slice(0, 120)}`); }
  })());
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => { const t = setTimeout(() => process.exit(0), 5000); stopLive().finally(() => { clearTimeout(t); process.exit(0); }); });
}
if (pipe) {
  pipe.on((m) => {
    if (m?.type === 'stop') stopLive().finally(() => pipe.send({ type: 'stopped' }));
    else if (m?.type === 'wake') live.probe('woke from sleep');
  });
}
// The stream starts before the MCP sign-in: it needs no approval, only T3 Code's CLI on this Mac.
keys.sweep().then((n) => { if (n) console.log(`Revoked ${n} read-only stream key(s) left by an earlier run.`); })
  .catch((ex: Fault) => console.log(`Could not look for old stream keys: ${String(ex.message).slice(0, 120)}`))
  .finally(() => { if (!stopping) live.start(); });

// The desktop app keeps a sign-in in the macOS Keychain (desktop/main.ts) and hands it over this pipe on request.
// The request goes out after the listener is set, so the answer cannot arrive before anything hears it.
// Two minutes: after an update macOS may ask Dan to let Yes Chef use its Keychain key before main can answer.
function savedSignIn(): Promise<SignedIn | null> {
  if (!pipe) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pipe.off(hear); resolve(null); }, 120000);
    function hear(m: AppMessage | null | undefined): void { if (m && m.type === 'auth') { clearTimeout(timer); pipe!.off(hear); resolve((m.auth || null) as SignedIn | null); } }
    pipe.on(hear);
    pipe.send({ type: 'auth-please' });
  });
}
let auth: SignedIn | null = null;
const saved = await savedSignIn();
if (saved) {
  try {
    await connect(saved).call('t3_environment_read', {});
    auth = saved;
  } catch (ex) {
    // Only T3 Code's own refusal (revoked or expired) ends a saved sign-in. T3 Code being down does not:
    // the sign-in stays saved, and this start fails at the next call, as a fresh sign-in would.
    // A saved sign-in came over the pipe, so the pipe is there.
    if ((ex as Fault).auth) { console.log('The saved sign-in was refused by T3 Code. Sign in again.'); pipe!.send({ type: 'auth-lost' }); }
    else auth = saved;
  }
}
if (auth) console.log(`Signed in. Scope: ${auth.scope} (saved sign-in)`);
else {
  // The desktop app (desktop/main.ts) names itself with its version. The callback takes any free port unless
  // YESCHEF_CALLBACK_PORT names one.
  const name = process.env.YESCHEF_CLIENT_NAME || 'The Pass (web prototype)';
  console.log(`Signing in to T3 Code at ${ORIGIN} as "${name}".`);
  auth = await signIn(ORIGIN, { name, port: Number(process.env.YESCHEF_CALLBACK_PORT || 0), onLink: (l) => {
    writeFileSync(join(OUT, 'link.txt'), l + '\n', { mode: 0o600 });
    console.log(`Sign in to T3: ${l}\n(link file: ${join(OUT, 'link.txt')})`);
  } });
  console.log(`Signed in. Scope: ${auth.scope}`);
  if (pipe) pipe.send({ type: 'auth-new', auth });
}
canOperate = String(auth.scope || '').split(' ').includes('orchestration:operate');
t3 = connect(auth);
envId = (await tool<{ environmentId: string }>('t3_environment_read', {})).environmentId;
// The address T3 gives this sign-in for a thread, so the board links where it linked when it read threads over MCP.
try {
  const row = (await tool<{ threads?: ThreadRow[] }>('t3_thread_list', { allProjects: true, includeSubagents: true, limit: 1 })).threads?.[0];
  const tail = row ? encodeURIComponent(row.threadId) : '';
  if (row && typeof row.link === 'string' && /^https?:/.test(row.link) && row.link.endsWith(tail)) linkBase = row.link.slice(0, -tail.length);
} catch (ex) { console.log(`Thread links fall back to ${ORIGIN}: ${String((ex as Fault).message).slice(0, 120)}`); }
// An action or a saved rule asks for a refresh at once; the stream brings T3's side of it.
var wake = kick;
kick();
setInterval(kick, BEAT_MS);
team.start();
