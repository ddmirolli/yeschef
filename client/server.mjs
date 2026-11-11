// The Pass web prototype (docs/pass-product-brief-v1_0.md, Dan's 1a and 2a, 2026-11-06).
// Read-only. It follows one T3 environment's live stream (client/t3live.mjs) and reads the rest as an outside MCP
// client, and pushes each change to the page. It stores nothing: the keys live in this process, and every fact
// comes from T3.
// Run: BRIGADE_PASS_ORIGIN=<this page's https address> BRIGADE_ALLOW=<allow-list file> node client/server.mjs <t3-origin> [port]
// The desktop app (desktop/main.mjs) starts it with the T3 origin only: it opens no port and takes actions over its pipe.
import { createServer } from 'node:http';
import { onScale } from './scale.mjs';
import { mkdtempSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn, connect } from './t3mcp.mjs';
import { createKeys, createLive } from './t3live.mjs';
import { boardThreads, changeTargets, githubTargets } from './shells.mjs';
import { createChanges } from './changes.mjs';
import { createBaseChecks, createPrSizes } from './github.mjs';
import { buildBoard, renderApp, kitchenPane, pickedFrom } from './board.mjs';
import { readRuns, dayStart, trackWaits, mayRunToday } from './you.mjs';
import { normalize as normalRules, change as changeRule } from './kitchen.mjs';
import { parseCalls, callKey, imagesIn, imageId, shotPath, isShot, SHOT_TYPES } from './calls.mjs';
import { act } from './actions.mjs';
import { refuse } from './guard.mjs';
import { BAR_CSS, BAR_HTML, SPRING, barCore, installBar } from './bar.mjs';
import { onTheme, miniCss, minis, MINI_CSS } from './theme.mjs';
import { keysCore } from './keys.mjs';
import { appendFileSync } from 'node:fs';

// The desktop app's pipe. In the app this runs in an Electron utility process and talks over process.parentPort;
// started by Node with an IPC channel it uses process.send. Alone (node client/server.mjs) it has neither: the web prototype.
function appPipe() {
  if (process.parentPort) {
    const hear = new Set();
    process.parentPort.on('message', (e) => { for (const fn of [...hear]) fn(e.data); });
    return { send: (m) => process.parentPort.postMessage(m), on: (fn) => hear.add(fn), off: (fn) => hear.delete(fn) };
  }
  if (typeof process.send === 'function') {
    return { send: (m) => { if (process.connected) process.send(m); }, on: (fn) => process.on('message', fn), off: (fn) => process.off('message', fn) };
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
// Actions on the web prototype: only through the tailnet, from an allowed device, on this page (client/guard.mjs).
// The page's address and the allow list come from the environment: the code carries nobody's address or files.
const PAGE_ORIGIN = process.env.BRIGADE_PASS_ORIGIN || '';
const ALLOW = process.env.BRIGADE_ALLOW || '';
const missing = [!ORIGIN && 'the T3 origin (first argument)', !DESKTOP && !PAGE_ORIGIN && 'BRIGADE_PASS_ORIGIN', !DESKTOP && !ALLOW && 'BRIGADE_ALLOW'].filter(Boolean);
if (missing.length) {
  console.error(`The Pass needs ${missing.join(', ')}.\nRun: BRIGADE_PASS_ORIGIN=<this page's https address> BRIGADE_ALLOW=<allow-list file> node client/server.mjs <t3-origin> [port]`);
  process.exit(2);
}
const HERE = dirname(fileURLToPath(import.meta.url));
// The Pass's base stylesheet (client/pass.css); the app's own rules follow it (APP_CSS).
const CSS = readFileSync(join(HERE, 'pass.css'), 'utf8');
const OUT = mkdtempSync(join(tmpdir(), 'the-pass-'));
// Rules (client/kitchen.mjs), set in Settings. The desktop app keeps them in its data folder
// (YESCHEF_RULES_FILE); the web prototype keeps them in this run's temp folder.
const RULES_FILE = process.env.YESCHEF_RULES_FILE || join(OUT, 'kitchen-rules.json');
let rules = normalRules(null);
// No file yet means the defaults. A file Yes Chef cannot read is not guessed at (PR-Agent on #49): Settings says
// so, and Launch waits until a save from Settings replaces it.
let rulesError = '';
const rulesSeq = new Map(); // [page id, scope, rule] -> the newest save count taken for it
// Each saved set has a revision that only goes up, even across restarts, so a page keeps the newest copy it has seen
// whatever order answers and refreshes reach it (PR-Agent r10 on #49).
let rulesRev = Date.now();
const rulesNow = () => ({ ...rules, rev: rulesRev });
try { rules = normalRules(JSON.parse(readFileSync(RULES_FILE, 'utf8'))); }
catch (ex) { if (ex.code !== 'ENOENT') rulesError = `Yes Chef could not read your rules (kitchen-rules.json: ${ex.code || 'not valid JSON'}).`; }
let authLost = false;

let t3 = null, canOperate = false, envId = null, projects = [], projectsAt = 0, board = { tickets: [], verifiedToday: 0 };
// Project icons: T3 gives only a file path. The Pass can show it when it runs on T3's own machine.
const ICON_TYPES = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
let iconFiles = new Map();
// An icon is served only when its real path (symlinks resolved) sits inside the project's folder or T3's own
// project-icons folder, has an image extension, and its bytes start like an image. Anything else gets the letter.
const T3_ICONS = join(homedir(), '.t3', 'userdata', 'project-icons');
const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const inside = (file, root) => !!root && (file === root || file.startsWith(root.endsWith(sep) ? root : root + sep));
function looksLikeImage(bytes) {
  const b = bytes.subarray(0, 512);
  const head = b.toString('latin1');
  return head.startsWith('\x89PNG') || (b[0] === 0xff && b[1] === 0xd8) || (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP')
    || (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(b.toString('utf8'));
}
function iconPath(p) {
  if (!p.faviconPath) return null;
  const file = real(isAbsolute(p.faviconPath) ? p.faviconPath : join(p.workspaceRoot || '/nonexistent', p.faviconPath));
  if (!file || !ICON_TYPES[extname(file).toLowerCase()]) return null;
  if (!inside(file, real(p.workspaceRoot || '')) && !inside(file, real(T3_ICONS))) return null;
  // Read once and keep the bytes that passed: the route serves these, never the path again (no swap after the check).
  try {
    if (!statSync(file).isFile() || statSync(file).size >= 512 * 1024) return null;
    const body = readFileSync(file);
    return looksLikeImage(body) ? { type: ICON_TYPES[extname(file).toLowerCase()], body } : null;
  } catch { return null; }
}
function withIcons(list) {
  iconFiles = new Map();
  return list.map((p) => {
    const icon = iconPath(p);
    if (icon) iconFiles.set(p.id, icon);
    return { ...p, icon: icon ? `/icon/${encodeURIComponent(p.id)}` : null };
  });
}
// The agent's hand-back on each ticket that gave the turn back, kept until the thread runs again: its latest
// message, and its call (lettered options, client/calls.mjs) if it asked one since the last message it received.
// PR bot pings start runs too ("checks passed"); they post no user message, so a call before them stays open.
const handbackCache = new Map();
async function handback(t) {
  const key = `${t.threadId}|${t.latestRunId}|${t.updatedAt}`;
  if (handbackCache.get(t.threadId)?.key === key) return handbackCache.get(t.threadId).value;
  let latest = null, call = null, cut = false, stop = false, end = t.itemCount || 0;
  // Step back a window at a time, newest first, until a user message (the agent got new input after it) or both are found.
  for (let w = 0, size = 10; w < 14 && !stop && end > 0; w++, size = 40) {
    const after = Math.max(0, end - size), items = [];
    let at = after;
    for (let i = 0; i < 6; i++) {
      const page = await t3.call('t3_thread_read', { threadId: t.threadId, view: 'messages', afterPosition: at, limit: 50, maxCharsPerItem: 20000 });
      items.push(...(page.items || []).filter((x) => x.position > after && x.position <= end));
      if (!page.hasMore || (page.items || []).some((x) => x.position > end)) break;
      at = page.nextPosition;
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
let shotFiles = new Map();
const SHOT_ROOTS = [homedir(), '/tmp', tmpdir()].map(real).filter(Boolean);
let status = { ok: false, error: 'signing in to T3', at: Date.now(), ms: 0 };
const clients = new Set();

// The thread address T3 gives this sign-in (its hosted link), without the thread id, which T3 URL-encodes in it.
// Read once at start.
let linkBase = null;
const link = (t) => (t.link && t.link.startsWith('http') ? t.link : `${ORIGIN}/${envId}/${t.threadId}`);
const linkFor = (id) => (linkBase ? linkBase + encodeURIComponent(id) : null);

// The live stream: a read-only key of its own, T3 Code's /ws, and the shell it keeps current (client/t3live.mjs).
const keys = createKeys({ origin: ORIGIN, ...(process.env.YESCHEF_T3_BIN ? { bin: process.env.YESCHEF_T3_BIN } : {}) });
// Reads the stream does not carry, kept until what they depend on changes: a parent the stream does not have
// (until the next snapshot, or until the stream names it), and a thread's waiting questions (until its pending
// request or its update time moves).
const parentCache = new Map();
// How often the stream has named each thread: a parent read that the stream named while it was on its way is used
// once, never cached (PR-Agent r2 on #76).
const parentMoves = new Map();
const live = createLive({ origin: ORIGIN, keys, log: (m) => console.log(m), onChange: (change) => {
  // A parent the stream names again has moved (restored, edited, archived), so its cached read is old (PR-Agent r1 on #76).
  for (const id of change.ids) { parentCache.delete(id); parentMoves.set(id, (parentMoves.get(id) || 0) + 1); }
  // The board stops being current the moment the stream does, even while a refresh is still reading.
  if (!change.live && status.ok) { status = { ok: false, at: Date.now(), ms: 0, error: String(live.why()).slice(0, 200) }; tick(); }
  refreshSoon();
} });
let parentGeneration = -1, projectsRev = -1;
const questionCache = new Map();
// Changed files and line ranges per thread: a read-only git diff in each thread's folder (client/changes.mjs).
// Nothing on the board shows them yet; the team summary and the Overlap and Too big calls read them with
// changes.get(threadId) and changes.subscribe(fn).
const changes = createChanges({ log: (m) => console.log(m) });
// The checks on each followed thread's base branch, and the size of each open PR, from GitHub through the gh CLI
// this Mac is signed in to, read only (client/github.mjs). No gh, no answer: "not checked". Nothing shows them yet;
// readers use baseChecks.get(threadId) and prSizes.get(prKey({ host, repo, number })), and subscribe(fn) on each.
const baseChecks = createBaseChecks({ log: (m) => console.log(m) });
const prSizes = createPrSizes({ log: (m) => console.log(m) });

// Run times for the You view (Dan, 2026-11-10): each thread that ran today, read once per run state. t3_thread_read
// lists a thread's recent runs with their start and end times (runLimit, read on 2026-11-10). A read that fails, or
// more threads than one update reads, leaves run times "not checked" for this update; the board itself stays good,
// and the next update carries on from what it already has.
const runCache = new Map();
// Today's waits on questions, seen update by update: T3's run times hold them (client/you.mjs trackWaits).
const waitLog = new Map();
const RUN_READS = 40;
async function runTimes(threads, now) {
  const t0 = dayStart(now);
  const want = threads.filter((t) => mayRunToday(t, t0));
  const out = new Map();
  let reads = 0, short = false;
  for (const t of want) {
    const key = `${t.latestRunId}|${t.status}`, hit = runCache.get(t.threadId);
    if (hit?.key === key) { out.set(t.threadId, hit.value); continue; }
    if (reads >= RUN_READS) { short = true; continue; }
    reads++;
    try {
      const read = await t3.call('t3_thread_read', { threadId: t.threadId, limit: 1, maxCharsPerItem: 1, runLimit: 50 });
      if (!Array.isArray(read?.recentRuns)) { short = true; continue; }
      const value = readRuns(read);
      runCache.set(t.threadId, { key, value });
      out.set(t.threadId, value);
    } catch (ex) {
      if (ex.auth) throw ex;
      short = true;
    }
  }
  const keep = new Set(want.map((t) => t.threadId));
  for (const id of [...runCache.keys()]) if (!keep.has(id)) runCache.delete(id);
  return short ? null : out;
}

async function refresh() {
  const t0 = Date.now();
  try {
    // A cache is never shown as live: without a live, synchronized stream the board says "Not checked".
    if (!live.live()) throw new Error(live.why());
    if (live.projectsRev() !== projectsRev) {
      const rev = live.projectsRev();
      projects = withIcons((await t3.call('t3_project_list', { limit: 100 })).projects || []);
      projectsRev = rev;
    }
    // The board is built from one snapshot generation. If the stream resynchronizes while the reads below wait,
    // this board is from the old one and is not published (PR-Agent r2 on #76).
    const generation = live.generation();
    if (generation !== parentGeneration) { parentCache.clear(); parentMoves.clear(); parentGeneration = generation; }
    const shells = new Map(live.threads().map((s) => [s.id, s]));
    const picked = boardThreads([...shells.values()], { now: t0, link: linkFor });
    const byId = new Map(picked.threads.map((t) => [t.threadId, t]));
    const followed = changeTargets(picked.threads, shells, live.project);
    changes.want(followed);
    const github = githubTargets(followed, shells, changes.get);
    baseChecks.want(github.base);
    prSizes.want(github.prs);
    // A running or waiting station needs its ticket even when that ticket settled long ago. The stream carries
    // every active thread; a parent it lacks is read over MCP, as before. If any stays unresolved, the board
    // is incomplete and the page says "not checked".
    for (let reads = 0; ; ) {
      const missing = [...new Set([...byId.values()].map((t) => t.parentThreadId).filter((id) => id && !byId.has(id)))];
      if (!missing.length) break;
      if (reads + missing.length > 200) throw new Error(`${missing.length} parent threads still unread after ${reads} reads`);
      for (const threadId of missing) {
        let row = parentCache.get(threadId);
        if (!row) {
          const moves = parentMoves.get(threadId) || 0;
          const read = await t3.call('t3_thread_read', { threadId, limit: 1, maxCharsPerItem: 1 });
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
    const questions = new Map();
    for (const t of threads.filter((x) => x.status === 'waiting' || (!x.parentThreadId && !x.settled && ['running', 'starting', 'queued', 'preparing'].includes(x.status)))) {
      const shell = shells.get(t.threadId);
      if (shell && !shell.pendingRuntimeRequest) { questionCache.delete(t.threadId); continue; }
      const key = shell ? `${shell.pendingRuntimeRequest.id}|${shell.updatedAt}` : null;
      let hit = key && questionCache.get(t.threadId);
      if (!hit || hit.key !== key) {
        const ids = (await t3.call('t3_pending_request', { action: 'list', threadId: t.threadId })).requestIds || [];
        const items = [];
        for (const requestId of ids.slice(0, 3)) items.push(...((await t3.call('t3_pending_request', { action: 'read', threadId: t.threadId, requestId })).questions || []).map((q) => ({ ...q, requestId })));
        hit = { key, items };
        if (key) questionCache.set(t.threadId, hit);
      }
      if (hit.items.length) questions.set(t.threadId, hit.items);
    }
    for (const id of questionCache.keys()) if (!shells.has(id)) questionCache.delete(id);
    const words = new Map();
    // A ticket waiting on Dan's answer to a T3 question also gets its last message, so the question has its
    // context (hill climb r4, Opus and Fable). The walk stops at the last user message, as for hand-backs.
    for (const t of threads.filter((x) => !x.parentThreadId && !x.settled && !x.snoozed && x.latestRunId && (['completed', 'interrupted', 'idle'].includes(x.status) || questions.has(x.threadId)))) {
      words.set(t.threadId, await handback(t));
    }
    const runs = await runTimes(threads, t0);
    // The stream may have dropped, or dropped and come back with a new snapshot, while the reads above waited:
    // then this board is not current either. The refresh that change queued builds the next one.
    if (!live.live()) throw new Error(live.why());
    if (live.generation() !== generation) throw new Error('T3 Code sent a new snapshot during this update; reading it again');
    const waits = trackWaits(waitLog, threads, questions, t0);
    board = buildBoard({ projects, threads, questions, lastWords: words, runs, waits });
    shotFiles = new Map(board.tickets.flatMap((k) => [k.lastWords, k.call?.text]).filter(Boolean)
      .flatMap((text) => imagesIn(text)).filter((im) => !/^https:/i.test(im.src)).map((im) => [imageId(im.src), im.src]));
    status = { ok: true, at: Date.now(), ms: Date.now() - t0 };
  } catch (ex) {
    status = { ok: false, at: Date.now(), ms: Date.now() - t0, error: String(ex.message).slice(0, 200) };
    if (ex.auth && DESKTOP && !authLost) { authLost = true; pipe.send({ type: 'auth-lost' }); }
  }
  tick();
}
function tick() {
  const data = JSON.stringify({ ok: status.ok, at: status.at, error: status.error || null });
  for (const res of clients) res.write(`event: tick\ndata: ${data}\n\n`);
  if (DESKTOP) pipe.send({ type: 'tick', data });
}

// Never two refreshes at once: a change during one queues one more. A burst of changes is gathered for 150 ms.
let refreshing = null, again = false, soonTimer = null;
function kick() {
  if (!t3) return;  // still signing in: the first refresh runs once the MCP sign-in is ready
  if (refreshing) { again = true; return; }
  refreshing = refresh().finally(() => { refreshing = null; if (again) { again = false; kick(); } });
}
function refreshSoon() { if (!soonTimer) soonTimer = setTimeout(() => { soonTimer = null; kick(); }, 150); }

// The prototype's own rules, after the base sheet (client/pass.css).
const APP_CSS = `
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
/* Phone layout: council round 1 (Opus 5.5, Fable 5.1, Sol 6.1), 2026-11-06. Prototype only: the live pass is unchanged. */
@media (max-width:760px){
  /* No zoom on focus: iOS zooms fields under 16px. */
  .note textarea,label.opt .custom{font-size:16px}
  /* 44px touch targets. */
  .pmenu summary,.pmenu-l a,.confirm-b .btn{min-height:44px}
  .plate .close{min-width:44px;min-height:44px;justify-content:center;padding:0}
  .plate-bar a,.plate .row-h a{display:inline-flex;align-items:center;min-height:44px}
  .plate .row-h a{margin:-11px 0}
  /* The Pass: stage in the top row, two-line summaries, flatter cards. */
  .ct-top .gate-top{display:inline;margin-left:auto;font-size:12px;color:var(--label2)}
  .ct-top .gate-top+.age{margin-left:8px}
  .ct-foot .gate{display:none}
  .ct-foot .pick{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
  .head-b{padding:0 8px 8px}
  .call-tile{padding:12px 14px;border-radius:12px}
  /* Stage trays: sized to their tickets, capped at most of a screen, the next one peeking in. */
  .rail{align-items:stretch;grid-auto-columns:148px}
  .tray{max-height:min(520px,65dvh)}
  .tray-b{overflow-y:auto;overscroll-behavior:auto}
  /* The open ticket: one scroll area, a tighter header, and the actions pinned within thumb reach. */
  .plate-h{padding:14px 16px 4px}
  .plate-h h2{font-size:22px;line-height:1.18}
  .gates{margin-top:12px}
  .track li{font-size:11px}
  .sect{padding:16px 16px 24px}
  .plate .prose.last{max-height:none;overflow:visible;background:none;padding:0}
  /* The footer: a flat toolbar outside the scroll, buttons above the note so the keyboard never covers them. */
  .plate-foot{padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:var(--matsheet);-webkit-backdrop-filter:saturate(1.8) blur(20px);backdrop-filter:saturate(1.8) blur(20px)}
  .plate-foot .acts{order:-1;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:6px}
  .plate-foot .acts .btn{padding:0 4px}
  .plate-foot .note>span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .plate-foot .note textarea{min-height:44px;height:44px}
  .plate-foot .note textarea:focus{height:88px}
  .plate .prose.last{font-size:16px;line-height:1.5}
  .plate .prose.last code{font-size:14px;padding:2px 5px}
  .pmenu-l{top:52px}
  html{-webkit-tap-highlight-color:transparent}
  @media (hover:none){.tile:hover{transform:none;box-shadow:var(--sh1)}.tile.at:hover{box-shadow:inset 3px 0 0 var(--pass),var(--sh1)}.call-tile:hover{box-shadow:inset 0 0 0 .5px var(--sep)}.btn:hover{background:var(--fill)}.btn.fill:hover{background:var(--accent)}}
  /* Dark sheet: lighter cells on a darker sheet, like the board; options and confirms one step lighter again. */
  @media (prefers-color-scheme:dark){.plate,.plate-foot{background:var(--bg)}.plate .rows{background:var(--card)}.plate .rows label.opt,.plate .rows .confirm{background:var(--card2)}.plate .rows label.opt:has(input:checked){background:var(--blue-t)}}
  /* Council round 3 (Opus 8, Fable 8.5, Sol 9). */
  .plate-foot .result{order:-1}
  .plate-foot .note>span{position:static;width:auto;height:auto;overflow:visible;clip:auto;white-space:normal;font-size:12px;font-weight:500}
  .plate-foot .note>span>span{font-weight:400}
  .plate-scroll .acts .btn{flex:1}
  /* Council round 4: the question leads, options read label then description, the queued reply is a plain button. */
  .plate .q-set legend{padding:0;font-size:17px;line-height:1.3;letter-spacing:-.018em;color:var(--label)}
  label.opt .opt-t .muted{display:block;margin-top:2px;font-size:14px;font-weight:400;line-height:1.35}
  .plate:has(.q-set) .plate-foot .acts .btn{background:none;color:var(--link);font-weight:500}
  .plate .prose.last ul{margin-bottom:0}
  .head-h{padding:18px 22px 12px}
  .plate .row-h{font-size:16px}
  .plate .rows:has(>.turn){background:none;border-radius:0}
  .plate .turn{padding:0}
  .plate .turn .row-h b{font-size:13px;font-weight:500;color:var(--label2)}
  .prose.last ul{margin:2px 0 10px;padding-left:1.2em;white-space:normal}
  .prose.last li{margin:2px 0}
  .plate-bar{position:relative;padding-top:12px}
  .plate-bar::before{content:"";position:absolute;top:6px;left:50%;width:36px;height:5px;margin-left:-18px;border-radius:3px;background:var(--fill2)}
  .tray{max-height:min(440px,55vh);max-height:min(440px,55svh)}
  .rail .tile .t{font-size:14px;line-height:1.35}
  .rail .meta,.tray-h .hint{font-size:12px}
  .stats{gap:16px}
  .stat{padding:0;background:none}
  @media (hover:none){
    .btn:active,.close:active .ic{background-image:linear-gradient(var(--fill2),var(--fill2))}
    .btn.fill:active{background-image:linear-gradient(rgba(0,0,0,.16),rgba(0,0,0,.16))}
    .tile:active,label.opt:active{background-image:linear-gradient(var(--fill),var(--fill))}
    .plate a:active,.plate:has(.q-set) .plate-foot .acts .btn:active{opacity:.55}
  }
}
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
@media (max-width:760px){.shots{grid-template-columns:1fr 1fr}.shot img{height:120px}}
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
    .tray-b>.tile,.folder>.tile{animation:recede linear both;animation-timeline:view();animation-range:entry 0% entry 100%}
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
.is-stale .head-b>.folder,.is-stale .rail .tray-b,.is-stale .segbar{visibility:hidden}
.is-stale .stats b,.is-stale .nf .n,.is-stale .tray-h .n,.is-stale .head .badge,.is-stale .pmenu-l .n{visibility:hidden}
/* The hidden list says why it is empty. */
.is-stale .head-b::before{content:"Not checked. The list returns with the next update.";display:block;padding:24px 12px;text-align:center;font-size:13px;color:var(--label2)}
.tile.sel,.call-tile.sel{box-shadow:inset 0 0 0 2px var(--accent)}
.tile.gone{display:none}
/* A list a refresh just redrew (the page script's prime()): its cards take their hover at once, with no fade. */
.fresh .tile{transition:none}
/* The open ticket over the kitchen, and on phones. */
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
.bar .pmenu{margin-left:0}
.bar .lamps{margin-left:auto;font-size:12px;color:var(--label2)}
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
/* Phones: the pass is a list and a ticket opens full screen; the stages scroll across the top. */
@media (max-width:760px){
  dialog.sheet{width:100vw;height:100dvh;max-height:none;border-radius:0}
  .plate-scroll{padding:16px}
  .dock{padding:12px 16px calc(12px + env(safe-area-inset-bottom))}
  .v-pass .stagenav{display:flex;gap:6px;overflow-x:auto;padding:0 16px 10px}
  .v-pass .nf{width:auto;flex:none;background:var(--fill)}
  .v-pass .nf[data-folder=pass]{margin:0}
  .v-pass .you,.v-pass .team-wait{display:none}
  .v-pass .board{grid-template-areas:"nav" "head"}
  .v-pass .stagenav{grid-area:nav;margin:0 -16px;align-items:center}
  .v-pass .nav-card{display:contents}
  .head-keys{display:none}
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
  .v-pass .head-b,.tray-b,.plate-scroll{scrollbar-gutter:stable}
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
/* Narrow kitchen columns show the project's mark alone (its name is the mark's tooltip). */
.v-kitchen .rail>.tray{container-type:inline-size}
/* A column with tickets is about 181 px wide at 1440, so names hide below 220 px rather than truncate (Opus r6). */
@container (max-width:220px){ .tile .proj .pn{display:none} .tile .tile-top .proj{flex-shrink:0} }
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
/* The blue left bar means "selected" only; the cloche marks a ticket at the pass in the kitchen (Opus r4). */
.v-kitchen .rail .tile.at{box-shadow:var(--sh1)}
/* Kitchen titles wrap without a lone last word (r14, Astra). */
.v-kitchen .rail .tile .t{text-wrap:pretty}
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
@media (max-width:760px){dialog.sheet{height:100dvh;max-height:none}}
/* The kitchen in the same style as the pass: one card look, no glow. */
.v-kitchen .head::before{display:none}
.v-kitchen .head .call-tile{background:var(--bg);box-shadow:inset 0 0 0 .5px var(--sep)}
/* Kitchen columns share the width by need: an empty stage narrows, a stage with tickets gets room for titles. */
@media (min-width:761px){
  .v-kitchen .rail{display:flex;gap:12px}
  .v-kitchen .rail>.tray{flex:1 1 168px;min-width:0}
  .v-kitchen .rail>.tray.empty{flex:.45 1 92px}
  .v-kitchen .rail>.tray.empty .hint{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .v-kitchen .rail>.tray.empty{min-width:max(104px,var(--name,0px))}
  .v-kitchen .rail>.tray.empty .tray-h{flex-wrap:nowrap}
  .v-kitchen .rail>.tray.empty .tray-h .g{min-width:0;overflow:hidden;white-space:nowrap}
  .v-kitchen .rail>.tray.empty .tray-h .hint{display:none}
  /* A stage with tickets keeps room for its titles; on a narrow window the rail scrolls sideways (hill climb 2 r1). */
  .v-kitchen .rail>.tray:not(.empty){min-width:max(120px,var(--floor,140px),var(--name,0px),calc(var(--text,0px) + 45px),min(var(--word,0px),200px));flex:var(--need,1) 1 0}
  .v-kitchen .rail.fade-right{-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 40px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 40px),transparent)}
}
/* Over 1366 px a narrower pass panel and 8 px stage gaps give the titles 4 lines when the whole rail fits (.four), else 5 (r14, Opus); the stage arrow takes the 1280 size for the gap (r13, Opus and Fable). */
@media (min-width:1367px){ .v-kitchen .rail{gap:8px} .v-kitchen .rail.four>.tray:not(.empty){min-width:max(120px,var(--floor,140px),var(--name,0px),calc(var(--text4,var(--text,0px)) + 45px),min(var(--word,0px),200px))} .v-kitchen .rail>.tray:not(:last-child)::after{right:-6.5px;width:3.5px;height:3.5px} .v-kitchen .board{grid-template-columns:208px minmax(0,1fr) clamp(280px,19.5vw,360px)} }
/* Still too wide (the page script's fitRail() sets .tight): a stage keeps only its name and count on one line, so all
   six stages stay in the window (Dan, 2026-11-10). Every floor holds the stage's longest word (--word), so a title
   word is never split; only a word that would make its stage wider than 200 px (a pasted link) breaks (PR-Agent on
   #14). */
@media (min-width:761px){
  .v-kitchen .rail.tight>.tray:not(.empty){min-width:max(88px,var(--name,0px),min(var(--word,0px),200px))}
  .v-kitchen .rail.tight .tile .t{overflow-wrap:break-word}
  /* .tighter: a stage's name may wrap after its dot, with its count at the right, down to its longest word (--word).
     Narrower still, the stages scroll sideways. */
  .v-kitchen .rail.tight.tighter>.tray.empty,.v-kitchen .rail.tight.tighter>.tray:not(.empty){min-width:max(88px,min(var(--word,0px),200px))}
  .v-kitchen .rail.tight.tighter>.tray .tray-h{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;column-gap:6px}
  .v-kitchen .rail.tight.tighter>.tray .tray-h .g{min-width:0;overflow:visible;white-space:normal;align-items:flex-start}
  .v-kitchen .rail.tight.tighter>.tray .tray-h .g .gd{flex:none;margin-top:5px}
  .v-kitchen .rail.tight.tighter>.tray .tray-h .hint{grid-column:1/-1}
}
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
   card of its own, so three levels at most. The sheet over the kitchen and on phones matches the reader. */
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
/* A phone pass card keeps its stage dot. */
@media (max-width:760px){ .call-tile .ct-top .gate-top .gd{display:inline-block;vertical-align:middle;margin:0 5px 0 0} }
/* Phone pass cards take the desktop list's treatment: flat, one fill step off the panel (hill climb 2 r3, Astra). */
@media (max-width:760px){ .v-pass .head .folder>.tile,.v-pass .head .folder>.tile:hover{background:var(--bg);box-shadow:none} }
/* Phone chrome under a fifth of the screen: the strip already names the list, so no stats row and no repeated
   heading; the strip fades at its right edge while more stages wait (hill climb 2 r3, Opus, Fable). */
@media (max-width:760px){
  .v-pass .bar .stats{display:none}
  .v-pass .head-h{display:none}
  .v-pass .board{gap:12px}
  .v-pass .head-b{padding-top:8px}
  .stagenav.fade-right{-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 40px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 40px),transparent)}
}
/* At 1280 all six kitchen columns fit: a narrower pass panel and 140px stages. */
@media (min-width:761px) and (max-width:1366px){
  .v-kitchen .board{grid-template-columns:208px minmax(0,1fr) 280px}
  .v-kitchen .rail>.tray:not(.empty){min-width:max(104px,var(--floor,120px),var(--name,0px),calc(var(--text,0px) + 35px),min(var(--word,0px),200px))}
  /* Narrower gutters give the titles room at 1280 (hill climb 2 r5, Opus). Stages with tickets share the width by their longest title, as above 1366, over a floor that holds the stage's hint on one line (at least 104 px), so no title takes more than 5 lines (hill climb 2 r10 and r11). */
  .v-kitchen .rail{gap:8px}
  .v-kitchen .rail .tile{padding:10px 6px}
  .v-kitchen .rail>.tray{flex:1 1 0}
  .v-kitchen .rail>.tray.empty{flex:.45 1 0}
  .v-kitchen .rail>.tray:not(.empty){flex-grow:var(--need,1)}
  .v-kitchen .rail>.tray:not(:last-child)::after{right:-6.5px;width:3.5px;height:3.5px}
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
  .v-kitchen .tile:not(.sel),.v-kitchen .rail .tile.at:not(.sel),.v-kitchen .head .call-tile:not(.sel),.v-kitchen .head .tile:not(.sel){box-shadow:none}
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
@media (max-width:760px){
  /* The ticket's header stays one line. "Ready to merge" wrapped it at 390, so the stage and Open in T3 never wrap,
     and a ticket under 430 px drops the model, which its card in the list still shows. */
  .plate-bar .stg,.plate-bar .open-t3{flex:none;white-space:nowrap}
  @container (max-width:430px){ .plate-bar .mdl{display:none} }
  /* The pass fits the phone's screen: only its list scrolls, never the page. */
  html.v-pass,html.v-pass body{height:100%;overflow:hidden}
  html.v-pass #app{height:100dvh;display:flex;flex-direction:column}
  html.v-pass .board{flex:1;min-height:0;display:flex;flex-direction:column}
  html.v-pass .head{flex:1;min-height:0;display:flex;flex-direction:column;margin-bottom:0}
  html.v-pass .head-b{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
}
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
  :is(.v-pass,.v-kitchen) .bar .pmenu,:is(.v-pass,.v-kitchen) .bar .lamps,:is(.v-pass,.v-kitchen) .bar .gear{display:none}
  :is(.v-pass,.v-kitchen) .stagenav{overflow:visible}
  :is(.v-pass,.v-kitchen) .nav-scroll{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
  :is(.v-pass,.v-kitchen) .nav-foot{display:flex;flex-direction:column;gap:10px;margin:auto 0 0;padding-top:12px}
  :is(.v-pass,.v-kitchen) .nav-foot .pmenu{margin:0}
  :is(.v-pass,.v-kitchen) .nav-foot .pmenu summary{width:100%}
  :is(.v-pass,.v-kitchen) .nav-foot .pmenu summary>span:first-of-type{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
/* Phones: The Pass chip is the other chips' height, so all sit on one line (it was 2 px taller). */
@media (max-width:760px){ .v-pass .stagenav>.nf[data-folder=pass]{height:34px;min-height:34px} }
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
/* A phone: the sections sit in a row on top, and each rule's control goes under its words. */
@media (max-width:600px){
  #settings[open]{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto;height:calc(100dvh - 32px)}
  #settings .set-nav{grid-row:auto;flex-direction:row;flex-wrap:wrap;gap:4px;padding:14px 12px 8px;border-radius:16px 16px 0 0}
  #settings .set-nav h2{flex-basis:100%;margin:0 4px 6px}
  #settings .set-panes,#settings .set-done{grid-column:1}
  #settings .set-panes{padding:16px}
  #settings .set-done{padding:8px 16px 16px}
  #settings .kr-row{grid-template-columns:minmax(0,1fr)}
  #settings .kr-c{justify-self:start}
}
/* No zoom on focus: iOS zooms fields under 16px (as .note textarea does above). This comes after the rules that size
   them: the new-ticket form, the Rules menus and House notes (PR-Agent r8 on #61). */
@media (max-width:760px){.lf select,.lf textarea,.lf input,#settings .kr-sel,#settings .kr-scope select,#settings .kr-notes textarea{font-size:16px}}
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
/* Phones (call 2a): four slots. The blue pill, then Changes, Reply and More, each an icon over a small word. Hold and
   Settle move into More, which opens as a sheet from the bottom. */
@media (max-width:760px){
  html .plate .dock{padding:12px 16px 0}
  html .plate .dock-plain{padding-top:0}
  .dock .act-foot{margin:0 -16px;padding:8px 12px calc(8px + env(safe-area-inset-bottom));border-top:.5px solid var(--sep)}
  .dock .act-foot>.result{left:16px;right:16px}
  .abar{gap:4px}
  .abar>button{height:48px;border-radius:12px}
  .abar .ab,.abar .more-b{flex:1 1 0;min-width:0;flex-direction:column;gap:3px;width:auto;padding:0 2px;background:none;color:var(--label2);font-size:11px;font-weight:500}
  .abar .ab .ic,.abar .more-b .ic{width:21px;height:21px;color:var(--label)}
  .abar .ab.primary{flex:1.25 1 0;flex-direction:row;gap:7px;font-size:15px;font-weight:600}
  /* A word never runs into the next slot: it ends in an ellipsis first. */
  .abar .ab .bl{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis}
  .abar .ab.primary:not(.fill){background:var(--fill);color:var(--label)}
  .abar .ab.fill{background:var(--accent);color:#fff}
  .abar .ab.fill .ic{color:#fff}
  .abar .ib:not(.more-b),.abar .vr{display:none}
  .abar .more-b .mw{display:block}
  .abar .more-b.on{background:var(--fill)}
  .abar .menu{left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom));width:auto;min-width:0;padding:8px;border-radius:22px}
  .abar .menu::backdrop{background:rgba(0,0,0,.25)}
  .abar .mi{height:48px;border-radius:12px;font-size:16px}
  .abar .mi kbd{display:none}
  .abar .mi.ph{display:flex}
  .abar .mi-n{max-width:none}
  .abar .mi-x{display:block;width:100%;height:48px;margin:6px 0 0;border:0;border-radius:12px;background:var(--fill);color:var(--label);font:inherit;font-size:16px;font-weight:600;cursor:pointer}
}
/* A narrow ticket in a wide window (a slim window gives the Pass's reader about 340 px at 920): the row never clips
   (PR-Agent r1 on #72). By the ticket's own width: under 560 px Changes and Reply keep only their icons, under 420 px
   Hold and Settle move into More as on a phone, and under 300 px the row wraps. Tooltips keep every name and key, and
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
/* You, expanded (Dan, 2026-11-10): the stage columns alone. They start at the top of the window and end level with
   The Pass and the stage list, and each column scrolls inside itself. */
.you,.team-wait{display:none}
@media (min-width:761px){
  .v-kitchen .you,.v-kitchen .you-b,.v-kitchen .you .rail-wrap{display:flex;flex-direction:column;min-height:0}
  .v-kitchen .you-b,.v-kitchen .you .rail-wrap{flex:1;height:auto}
  .v-kitchen .you .tray{max-height:none}
  .v-kitchen .team-wait{align-self:start}
  /* The tile's cloche needed the key that sat over the columns; The Pass on the right lists the same threads. */
  .v-kitchen .rail .at-ic{display:none}
}
@media (max-width:760px){
  /* The phone's stage list is one row of pills: the person and the bar stay on the desktop rail. */
  .idrow{display:none}
  .v-kitchen .board{grid-template-areas:"you" "head"}
  .v-kitchen .you{display:block;grid-area:you;min-width:0}
  .v-kitchen .team-wait{grid-area:you}
  .v-kitchen .head{grid-area:head}
  /* A phone's stages grow with their threads and the page scrolls. */
  .you .rail-wrap{height:auto}
  .you .tray{max-height:none}
  .you .tray-b{flex:none;overflow:visible}
}
/* The footer chip and its menu (Dan, 2026-11-10, view menu mock a). The chip: the person and You, or the toque and
   Team, then All projects or the picked projects' icons fanned like cards. The menu: check boxes, then the toggle. */
.vmenu{--cbon:#007AFF;--cboff:#FFFFFF;--cbline:rgba(0,0,0,.26);--segon:var(--card)}
@media (prefers-color-scheme:dark){.vmenu{--cbon:#0A84FF;--cboff:rgba(255,255,255,.07);--cbline:rgba(255,255,255,.32);--segon:#636366}}
.vmenu summary .ic.who{width:24px;height:24px}
.vmenu .vl-team,html.s-team .vmenu .vl-you,.vmenu .vi-team,html.s-team .vmenu .vi-you{display:none}
html.s-team .vmenu .vl-team{display:inline}
html.s-team .vmenu .vi-team{display:block}
.vmenu summary .vl,:is(.v-pass,.v-kitchen) .nav-foot .vmenu summary>span.vl{flex:none}
.vmenu summary .vdot{flex:none;margin:0 -3px;color:var(--label2)}
.vmenu summary .vp{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The fan: each card steps right and turns a little more, and both shrink as the count grows, so ten still fit.
   When the chip is short of room ("Team" is wider than "You"), the fan gives way and its cards step by the width it
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
@media (prefers-reduced-motion:reduce){.vmenu .pmenu-l .seg::before,.vmenu .cb .tick,.vmenu .fan .card{transition:none}}
@media (max-width:760px){.vmenu .pmenu-l .pk{min-height:44px}.vmenu .pmenu-l{max-height:calc(100dvh - 72px);overflow-y:auto;overscroll-behavior:contain}}
html.s-team .you{display:none}
/* The Pass follows the view: in Your team it says what it cannot show yet, and none of your own calls. */
.team-pass,html.s-team .head-b>.folder,html.s-team .head .badge,html.s-team .head-h>.muted{display:none}
html.s-team .head-b>.team-pass{display:flex}
html.s-team.v-kitchen .team-wait{display:block;padding:16px 18px;border-radius:16px;background:var(--card);box-shadow:inset 0 0 0 .5px var(--sep)}
/* Your team, Open kitchen (step 4; mock v2, round 2, Dan 2026-11-10). The team's card replaces yours in the rail, and
   The Pass holds the team's calls with a quiet line under them. Phones show The Pass only (Dan's 1a). */
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
@media (max-width:760px){html.s-team .team-card{display:none}.tcalm{margin:12px 4px 4px}}
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
.tv .tsug{display:flex;gap:12px;align-items:flex-start;margin-top:16px;padding:12px 14px;border-radius:12px;background:var(--pass-t);font-size:13.5px;line-height:1.45}
.tv .tsug b{flex:none;color:var(--pass);font-size:12px;font-weight:700;padding-top:1px}
.tv .tseen{margin:0;font-size:13px;color:var(--label2)}
.tv .tseen b{margin-right:4px;font-weight:600}.tv .tseen .ok{color:var(--green)}.tv .tseen .no{color:var(--red)}
.tv .tquiet{display:flex;gap:10px;align-items:flex-start;margin:0 0 12px;padding:10px 12px;border-radius:10px;background:var(--fill);font-size:13px;line-height:1.45;color:var(--label2)}
.tv .tquiet b{color:var(--label);font-weight:600}
.tv .hz{flex:none;display:inline-block;width:22px;height:12px;margin-top:2px;border-radius:3px;background:repeating-linear-gradient(135deg,var(--fill2) 0 2px,transparent 2px 5px);box-shadow:inset 0 0 0 1px var(--fill2)}
.tv .raxis{display:flex;justify-content:space-between;margin-top:6px;font-size:11.5px;color:var(--label2);font-variant-numeric:tabular-nums}
.tv .wlg{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;font-size:11.5px;color:var(--label2)}
.tv .wlg span{display:inline-flex;align-items:center;gap:6px}
.tv .wlg i{display:inline-block;width:14px;height:8px;border-radius:2px;background:var(--green)}
.tv .wlg i.r{background:var(--red)}.tv .wlg i.a{background:none;box-shadow:inset 0 0 0 1.5px var(--red)}
.tv .tmore{margin:10px 0 0;font-size:12.5px;color:var(--label2)}
/* Main broken: the team's merges today, red at the break, then the PRs that wait. */
.tv .ribbon{display:flex;flex-wrap:wrap;gap:3px;align-items:flex-end}
.tv .ribbon i{width:14px;height:22px;border-radius:3px;background:var(--green);opacity:.85}
.tv .ribbon i.r{background:var(--red);opacity:1;height:30px}
.tv .ribbon i.a{background:none;box-shadow:inset 0 0 0 1.5px var(--red);opacity:1}
.tv .tprs{display:flex;flex-wrap:wrap;gap:6px}
.tv .tpr{display:inline-flex;align-items:center;gap:6px;padding:3px 9px 3px 4px;border-radius:999px;background:var(--bg);box-shadow:inset 0 0 0 .5px var(--sep);font-size:12.5px;font-weight:600}
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
@media (max-width:560px){.tv .kvs,.tv .duo{grid-template-columns:minmax(0,1fr)}}
/* Faces: initials on a colour from the name. */
.av{display:inline-grid;place-items:center;flex:none;width:22px;height:22px;border-radius:50%;background:hsl(var(--h) 52% 46%);font:700 9.5px/1 var(--sans);color:#fff;letter-spacing:.02em}
.av.sm{width:18px;height:18px;font-size:8px}
/* Your team's instruments and panels. You, expanded no longer draws them (#14), so they live here, scoped to the team
   board: a bare .ph would also style the action bar's phone rows (.mi.ph). */
.tboard .you-h{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 14px;padding:6px 2px 14px}
.tboard .you-h h2{margin:0;font-size:20px;font-weight:700;letter-spacing:-.01em}
/* One line: the projects shorten first, so no dot ever starts a line. */
.tboard .you-sub{flex:1 1 auto;display:flex;gap:8px;min-width:0;margin:0;font-size:14px;white-space:nowrap;color:var(--label2)}
.tboard .you-sub>*{flex:none}
.tboard .you-sub>:first-child{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.tboard .you-sub>*+*::before{content:"·";margin-right:8px}
.tboard .you-b{display:flex;flex-direction:column;gap:12px;container-type:inline-size}
.tboard .you-b>*{min-width:0}
.tboard .inst{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.tboard .ins{min-width:0;padding:12px 14px;border-radius:16px;background:var(--card);box-shadow:inset 0 0 0 .5px var(--sep)}
.tboard .ins .l{margin:0;font-size:12px;font-weight:600;color:var(--label2)}
.tboard .ins .v{display:flex;align-items:baseline;flex-wrap:wrap;gap:0 6px;margin:4px 0 0}
.tboard .ins .v b{font-size:24px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums}
.tboard .ins .v span{font-size:12px;color:var(--label2)}
.tboard .ins .v .nc{display:block;width:100%;font-size:16px;font-weight:600;line-height:1.75;color:var(--label2)}
.tboard .ins svg{display:block;width:100%;height:28px;margin-top:8px}
.tboard .vbars rect{fill:var(--pass);opacity:.6}
.tboard .ins .cap{display:flex;justify-content:space-between;margin-top:4px;font-size:12px;color:var(--label2)}
.tboard .pnl{min-width:0;padding:12px 14px 14px;border-radius:16px;background:var(--card);box-shadow:inset 0 0 0 .5px var(--sep)}
.tboard .ph{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;margin:0 0 10px;font-size:12px;color:var(--label2)}
.tboard .ph h3{margin:0;font-size:14px;font-weight:600;color:var(--label)}
.tboard .ph .lg{display:inline-flex;align-items:center;gap:6px;margin-left:auto}
.tboard .nc-l{margin:0;font-size:14px;line-height:1.45;color:var(--label2)}
.tboard .nc-l b{font-weight:600;color:var(--label)}
@container (max-width:760px){ .tboard .inst{grid-template-columns:repeat(2,minmax(0,1fr))} }
@media (max-width:760px){ .tboard .inst{grid-template-columns:repeat(2,minmax(0,1fr))} }
/* Your team, expanded (step 4 PR B; mock v2, approved 2026-11-10): the board in the middle, The Pass as a column of
   cards on the right, each with its suggestion and Open. */
.tboard,.tcol,.head-h>.tpm{display:none}
html.s-team.v-kitchen .head-h>.muted.tpm{display:block}
html.s-team.v-kitchen .tboard{display:flex;flex-direction:column;grid-area:you;min-width:0;min-height:0}
@media (min-width:761px){html.s-team.v-kitchen .tboard .you-b{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 2px 12px}}
@media (max-width:760px){html.s-team.v-kitchen .tboard{display:block}}
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
/* The instruments: the base's merges as a ribbon, merges by hour in purple. */
.ins .v b.red{color:var(--red)}.ins .v b.green{color:var(--green)}
.vbars.mg rect{fill:var(--merged);opacity:.75}
.kribbon{display:flex;gap:2px;align-items:flex-end;height:28px;margin-top:8px}
.kribbon i{flex:1 1 0;max-width:16px;height:18px;border-radius:2px;background:var(--merged);opacity:.75}
.kribbon i.r{height:26px;background:var(--red);opacity:1}
.ins .cap .red{font-weight:600;color:var(--red)}
/* Who's on what: a row per person, a bar per thread along today. */
.tl-p .ph .lg{display:flex;flex-wrap:wrap;gap:4px 12px;font-weight:500}
.tl-p .ph .lg>span{display:inline-flex;align-items:center;gap:5px}
.sw{display:inline-block;width:14px;height:8px;border-radius:2px;background:var(--fill2)}
.sw.red{background:none;box-shadow:inset 0 0 0 1.5px var(--red)}.sw.amber{background:none;box-shadow:inset 0 0 0 1.5px var(--orange)}
.sw.off{background:repeating-linear-gradient(135deg,var(--fill2) 0 2px,transparent 2px 4px);box-shadow:inset 0 0 0 .5px var(--fill2)}
.mk{display:inline-block;width:8px;height:8px;border-radius:1px;background:var(--merged);transform:rotate(45deg)}
.tl-s{overflow-x:auto;overscroll-behavior-x:contain}
.tl{position:relative;min-width:560px}
.tlax{display:grid;grid-template-columns:116px 1fr;height:16px;font-size:11px;color:var(--label2)}
.tlax .ax{position:relative}
.tlax .ax span{position:absolute;transform:translateX(-50%);white-space:nowrap;font-variant-numeric:tabular-nums}
.tlr{display:grid;grid-template-columns:116px 1fr;align-items:center;height:30px;border-top:.5px solid var(--sep)}
.tlr .who{display:flex;align-items:center;gap:7px;min-width:0;padding-right:6px}
.tlr .who>span{min-width:0}
.tlr .who b{display:block;overflow:hidden;font-size:12.5px;font-weight:600;line-height:1.15;text-overflow:ellipsis;white-space:nowrap}
.tlr .who em{display:block;font-style:normal;font-size:10.5px;font-weight:600;line-height:1.2;white-space:nowrap}
.k-pass{color:var(--pass)}.k-amber{color:var(--orange)}.k-gray{color:var(--label2)}
.tlr .plot{position:relative;height:100%}
.gv{position:absolute;top:0;bottom:0;width:0;border-left:.5px solid var(--sep)}
.tlb{position:absolute;box-sizing:border-box;height:12px;margin:0;padding:0 5px;border:0;border-radius:3px;background:var(--fill2);font:500 9.5px/12px var(--sans);color:var(--label2);text-align:left;white-space:nowrap}
.tlb .tlt{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis}
.tlb:has(.tltag){display:flex;padding-right:0;overflow:hidden}
.tlb:has(.tltag) .tlt{flex:1 1 0}
.tlb .tltag{position:static;flex:0 1 auto;min-width:0;margin-left:auto;overflow:hidden;text-overflow:ellipsis}
button.tlb{cursor:pointer}
.tlb.red{background:var(--red-t);box-shadow:inset 0 0 0 1.5px var(--red);color:var(--label)}
.tlb.amber{background:var(--orange-t);box-shadow:inset 0 0 0 1.5px var(--orange);color:var(--label)}
.tlb.clip{border-top-left-radius:0;border-bottom-left-radius:0}
.tlb.off{background:repeating-linear-gradient(135deg,var(--fill2) 0 2px,transparent 2px 5px);font-style:italic;color:var(--label2)}
.tlm{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:1px;background:var(--merged);transform:rotate(45deg)}
.tltag{position:absolute;padding:0 5px;border-radius:3px;font-size:10px;font-weight:700;line-height:12px;white-space:nowrap}
.tltag.red{background:var(--red);color:#fff}.tltag.amber{background:var(--orange);color:#1D1D1F}
.tlx{position:absolute;right:0;top:50%;padding-left:6px;background:var(--card);font-size:10.5px;color:var(--label2);transform:translateY(-50%)}
.tl .now{position:absolute;bottom:0;width:0;border-left:1.5px solid var(--pass);pointer-events:none}
.tl .now span{position:absolute;top:0;left:4px;font-size:10.5px;font-weight:700;color:var(--pass)}
.tl .conn{position:absolute;width:0;border-left:2px solid var(--red)}
.tl .conn button{all:unset;cursor:pointer}
.tl .conn span{position:absolute;left:6px;top:50%;padding:1px 4px;border-radius:3px;background:var(--card);box-shadow:inset 0 0 0 1px var(--red);font:600 10.5px var(--mono);color:var(--red);white-space:nowrap;transform:translateY(-50%)}
/* Files two live threads change: the path, the faces, a state word. */
.sfl{display:flex;flex-direction:column}
.sf{display:grid;grid-template-columns:minmax(0,1.4fr) 64px minmax(0,1fr);align-items:center;gap:12px;width:100%;min-height:34px;margin:0;padding:0;border:0;border-top:.5px solid var(--sep);background:none;font:inherit;font-size:13px;color:var(--label);text-align:left}
.sf:first-child{border-top:0}
button.sf{cursor:pointer}
button.sf:hover .s{text-decoration:underline}
.sf .f{overflow:hidden;font:12px var(--mono);text-overflow:ellipsis;white-space:nowrap}
.sf .fc{display:flex}
.sf .fc .av+.av{margin-left:-5px;box-shadow:0 0 0 1.5px var(--card)}
.sf .s{overflow:hidden;color:var(--label2);text-overflow:ellipsis;white-space:nowrap}
.sf .s.red{font-weight:600;color:var(--red)}
.tboard .tmore{margin:8px 0 0;font-size:12.5px;color:var(--label2)}
@media (max-width:760px){.sf{grid-template-columns:minmax(0,1fr) auto;row-gap:2px;padding:6px 0}.sf .s{grid-column:1 / -1}}
`;
// Appearance (theme.mjs): every dark and light rule also answers to the html element's data-theme.
// The pictures in Settings → Layout and the ⌘K bar's Appearance and Density steps (theme.mjs).
const MINIS = minis();
const tile = (name, value, label) => `<label class="look"><input type="radio" name="${name}" value="${value}" aria-label="${label}">${MINIS[value]}<span class="look-n">${label}</span></label>`;
const STYLE = onScale(onTheme(CSS + APP_CSS + BAR_CSS + MINI_CSS) + miniCss(CSS + APP_CSS + BAR_CSS));

const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>Yes Chef</title>
<script>(function(){var c='v-pass d-default';try{var s=localStorage;c=(s.getItem('yc.view')==='kitchen'?'v-kitchen':'v-pass')+' d-'+({comfortable:1,compact:1}[s.getItem('yc.density')]?s.getItem('yc.density'):'default');var t=s.getItem('yc.theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}document.documentElement.className=c})()</script><style>${STYLE}</style></head><body class="pass-app"><main id="app">${body}</main>
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
  var root = document.documentElement, app = document.getElementById('app');
  var sheet = document.getElementById('sheet'), viewer = document.getElementById('viewer'), toastEl = document.getElementById('toast'), setDlg = document.getElementById('settings'), launchDlg = document.getElementById('launch'), barDlg = document.getElementById('bar');
  var wideQ = window.matchMedia('(min-width: 761px)');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  function store(k, v){ try { if (v === undefined) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (x) { return null; } }
  // The pass is the normal view; the full kitchen is one click on the logo away. The choice is remembered.
  var state = { view: store('yc.view') === 'kitchen' ? 'kitchen' : 'pass', folder: 'pass', sel: null };
  var acted = {};   // plate id -> time: tickets you just sent from the pass, hidden until the board catches up
  var unconfirmed = {}; // plate id -> { body, what, text, form }: sends T3 may or may not have taken; the ticket offers Retry
  var actedLatest = {}; // plate id -> the hand-back it had when sent: a newer hand-back brings it back at once (Opus)
  var mounted = null; // the ticket element now open in the reader or the sheet
  var bar = null; // the Cmd+K action bar, once installed at the end
  var MINI = ${JSON.stringify(MINIS)}; // the Settings pictures, for the bar's Appearance and Density steps
  // Shortcuts (client/keys.mjs, ⌘K bar PR 4): the keys in use, as Settings → Shortcuts set them. The browser keeps the
  // list under yc.keys; the Mac app keeps it in keybindings.json in its data folder and reads it at start and on focus.
  ${keysCore}
  var K = keysCore(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || ''));
  var KFILE = window.yeschef && window.yeschef.keys && typeof window.yeschef.keys.read === 'function' ? window.yeschef.keys : null;
  var KST = K.build(readKeys()), kxSeen = null, kxFileNote = '';
  function readKeys(){ var t = store('yc.keys'); if (!t) return []; try { return JSON.parse(t); } catch (x) { return []; } }
  // A command's first key as one label ("⌘↵"), or '' with none. SK is the suggested action's: the board's send key.
  function keyLabel(id){ var k = K.keysOf(KST, id)[0]; return k ? K.label(k) : ''; }
  function SK(){ return keyLabel('ticket.suggested'); }
  function $(sel, el){ return (el || document).querySelector(sel); }
  function $$(sel, el){ return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  function wide(){ return wideQ.matches; }
  function focusView(){ return state.view === 'pass'; }

  // ----- Views -----
  function setView(v){
    // Read the reading position before the layout changes: hiding the reader drops its scroll.
    if (v === 'kitchen' && state.view === 'pass') { var rs0 = mounted && $('.plate-scroll', mounted); state.passScroll = rs0 ? rs0.scrollTop : 0; }
    state.view = v; store('yc.view', v);
    root.classList.toggle('v-pass', v === 'pass'); root.classList.toggle('v-kitchen', v === 'kitchen'); fitRail();
    var fl = $('.flip'); if (fl) fl.style.transform = '';
    var b = $('[data-view-toggle]'); if (b) b.setAttribute('aria-label', v === 'pass' ? 'Show the full kitchen' : 'Focus on the pass');
    // Neither view opens a ticket by itself: the reader stays blank until you pick one (Dan, 2026-11-08).
    // Leaving the pass remembers its open ticket; coming back reopens it if it is still in the list (Astra).
    if (v === 'kitchen') {
      // (Where you were reading was saved above, before the layout changed; Sol.)
      if (state.sel) state.passSel = state.sel; state.passFolder = state.folder; state.sel = null; state.listKey = null; setFolder('pass');
    }
    else {
      setFolder(state.passFolder || state.folder);
      var back = state.passSel && tiles().filter(function(t){ return t.dataset.plate === state.passSel; })[0];
      if (back) state.sel = state.passSel;
    }
    place();
    // Set after the view has laid out (the switch runs inside a view transition), on the next frames.
    if (v === 'pass' && back && state.passScroll) {
      var want = state.passScroll, again = function(){ var ps = mounted && $('.plate-scroll', mounted); if (ps && ps.scrollTop !== want) ps.scrollTop = want; };
      requestAnimationFrame(function(){ again(); requestAnimationFrame(again); }); setTimeout(again, 120);
    }
  }
  var flipping = false;
  // Dan, 2026-11-07: the logo turns while the views morph, both at once, on one smooth curve.
  // The logo has its own live layer in the view transition (view-transition-name: logo), so its turn shows
  // through the transition instead of a frozen snapshot. Three half turns: each shows the other colour, and the
  // last lands on the new view's face, which is the angle setView's class gives it, so nothing snaps at the end.
  var MOTION_MS = 700, MOTION_EASE = 'cubic-bezier(.65,0,.35,1)';
  function toggleView(){
    if (flipping) return;
    var next = state.view === 'pass' ? 'kitchen' : 'pass';
    var f = $('.flip');
    if (reduce.matches) { setView(next); return; }
    flipping = true;
    var from = state.view === 'pass' ? 0 : 180;
    if (f && f.animate) f.animate([{ transform: 'rotateY(' + from + 'deg)' }, { transform: 'rotateY(' + (from + 540) + 'deg)' }], { duration: MOTION_MS, easing: MOTION_EASE });
    if (document.startViewTransition) {
      var vt = document.startViewTransition(function(){ setView(next); });
      vt.finished.then(function(){ flipping = false; }, function(){ flipping = false; });
    } else { setView(next); }
    setTimeout(function(){ flipping = false; }, MOTION_MS + 300);
  }

  // ----- You or Your team (Dan, 2026-11-10) -----
  // Only a user with reports can switch: the page carries #yc-team only then. Until the team connection lands no one
  // has it, so the scope stays You. viewsNow and setScope are what the Cmd+K bar's View actions read and call.
  function teamNow(){ var j = $('#yc-team'); if (!j) return null; try { return JSON.parse(j.textContent); } catch (x) { return null; } }
  var scope = store('yc.scope') === 'team' ? 'team' : 'you';
  function applyScope(){
    if (!teamNow()) scope = 'you'; root.classList.toggle('s-team', scope === 'team');
    $$('.vmenu .seg [data-scope]').forEach(function(b){ b.setAttribute('aria-checked', String(b.dataset.scope === scope)); });
  }
  function viewsNow(){ var t = teamNow(); return { hasReports: !!t, current: scope, team: t }; }
  function setScope(next){
    if ((next !== 'you' && next !== 'team') || (next === 'team' && !teamNow())) return;
    var was = scope; scope = next; store('yc.scope', next); applyScope();
    // Your team shows none of your own tickets, so the one open in the reader closes, and the one the Pass kept for
    // its return is forgotten too, even when none is open now (PR-Agent r6 on #74). The reader is cleared even when
    // nothing is selected: a project pick in the same open menu drops the selection before the reader redraws.
    // Coming back to You does the same for a team call (step 4): neither view opens the other's.
    if (next !== was) { state.passSel = null; state.sel = null; place(); }
  }

  // Your team, expanded: a card in The Pass column, a bar in Who's on what or a file row goes back to The Pass with
  // that call open. The card's suggestion also puts focus on its action there: nothing sends from Your team yet.
  function openTeamCall(id, act){
    if (scope !== 'team' || !id || !plateNode(id)) return;
    state.passFolder = 'pass'; state.passSel = id;
    if (focusView()) select(id); else toggleView();
    if (act) setTimeout(function(){ var p = plateNode(id), b = p && $('form.act button[name=kind][value="' + act + '"]', p); if (b) b.focus(); }, reduce.matches ? 0 : MOTION_MS + 60);
  }

  // ----- Folders (the stage list) and selection -----
  // In Your team the list is the team's calls (folder "team"), never one of your own folders.
  function folderEl(){ if (scope === 'team') return $('.head-b .folder[data-folder="team"]'); return $('.head-b .folder[data-folder="' + state.folder + '"]') || $('.head-b .folder[data-folder="pass"]'); }
  function setFolder(name){
    if (name === 'team' || !$('.head-b .folder[data-folder="' + name + '"]')) name = 'pass';
    state.folder = name;
    $$('.head-b .folder:not([data-folder="team"])').forEach(function(d){ d.hidden = d.dataset.folder !== name; });
    // The stage list marks the open list in the pass view only: You, expanded shows every stage at once.
    $$('.stagenav .nf').forEach(function(b){ if (b.dataset.folder === name && focusView()) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
    var label = name === 'pass' ? 'The Pass' : name, h = $('.head-name'); if (h && focusView()) h.textContent = label; else if (h) h.textContent = 'The Pass';
    $$('.head .badge, .head-h > .muted').forEach(function(x){ x.hidden = focusView() && name !== 'pass'; });
    fades();
  }
  function tiles(){ var f = folderEl(); return f ? $$('[data-plate]', f).filter(function(t){ return !t.classList.contains('gone'); }) : []; }
  function plateNode(id){ return id ? document.getElementById(id) : null; }
  function mark(){ $$('[data-plate].sel').forEach(function(t){ t.classList.remove('sel'); }); if (state.sel) $$('[data-plate="' + state.sel + '"]').forEach(function(t){ if (t.tagName !== 'FORM') t.classList.add('sel'); }); }
  function unmount(){
    if (mounted && mounted.parentNode !== $('#plates')) { var store_ = $('#plates'); if (store_) store_.appendChild(mounted); }
    mounted = null;
  }
  function emptyReader(){ var r = $('.reader'); if (!r) return; $$('.plate', r).forEach(function(p){ $('#plates').appendChild(p); }); var e = $('.reader-empty', r); if (e) e.hidden = false; }
  // Put the selected ticket where the view shows it: beside the list (pass view, wide) or in the sheet.
  function place(){
    var p = plateNode(state.sel);
    if (focusView() && wide()) {
      if (sheet.open) sheet.close();
      var r = $('.reader'); if (!r) return;
      if (!p) { unmount(); emptyReader(); mark(); return; }
      if (p.parentNode !== r) { var same = mounted === p; if (!same) unmount(); $$('.plate', r).forEach(function(x){ if (x !== p) $('#plates').appendChild(x); }); r.appendChild(p); mounted = p; $$('textarea', p).forEach(grow); if (!same) { var s = $('.plate-scroll', p); if (s) s.scrollTop = 0; } }
      var e = $('.reader-empty', r); if (e) e.hidden = true;
    } else {
      emptyReader();
      if (!p) { if (sheet.open) sheet.close(); unmount(); mark(); return; }
      if (p.parentNode !== sheet) { var same2 = mounted === p; if (!same2) unmount(); sheet.appendChild(p); mounted = p; $$('textarea', p).forEach(grow); if (!same2) { var s2 = $('.plate-scroll', p); if (s2) s2.scrollTop = 0; } }
      if (!sheet.open) { sheet.showModal(); liftToast(); requestAnimationFrame(fades); }
    }
    mark(); fades(); yieldKey(); watchHead();
    // Every question form in the ticket gets its label, not only the first (Fable r5).
    if (mounted) $$('form.act', mounted).forEach(primaryLabel);
  }
  function select(id){ state.sel = id; place(); }
  // The ticket's head pins only while it leaves the message at least half the reader: a long title, PR chips and
  // screenshots in a short window scroll away with the message instead of covering it (PR-Agent r1 on #45).
  // It is measured again whenever the reader or the head changes size (the window, the dock, a note growing).
  var headRO = window.ResizeObserver ? new ResizeObserver(function(){ fitHead(); }) : null, headWatched = null;
  function fitHead(){
    if (!mounted) return;
    var sc = $('.plate-scroll', mounted), h = $('.plate-head', mounted); if (!sc || !h) return;
    h.classList.remove('unpin');
    if (getComputedStyle(h).position === 'sticky' && h.offsetHeight > sc.clientHeight / 2) h.classList.add('unpin');
  }
  function watchHead(){
    var sc = mounted && $('.plate-scroll', mounted), h = mounted && $('.plate-head', mounted);
    if (headRO && sc !== headWatched) { headRO.disconnect(); headWatched = sc || null; if (sc) { headRO.observe(sc); if (h) headRO.observe(h); } }
    fitHead();
  }
  // J/K move within the list the open ticket came from (a stage column or the pass list), not always the pass
  // (hill climb r1, Sol). The list is named, not held, so a refresh keeps it.
  function listKeyOf(t){
    var tray = t.closest('.tray'), folder = t.closest('.folder');
    return tray ? 'tray:' + tray.dataset.stage : folder ? 'folder:' + folder.dataset.folder : null;
  }
  function listFor(key){
    if (!key) return null;
    if (key.indexOf('tray:') === 0) return $('.tray[data-stage="' + key.slice(5) + '"] .tray-b');
    return null;
  }
  function step(dir){
    var box = !focusView() ? listFor(state.listKey) : null;
    var list = box ? $$('[data-plate]', box).filter(function(t){ return !t.classList.contains('gone'); }) : tiles(); if (!list.length) return;
    var i = list.findIndex(function(t){ return t.dataset.plate === state.sel; });
    var t = list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + dir))];
    // Focus moves with the selection, so Enter or Space on a card never reopens the one you left (hill climb 2 r2, Opus).
    var onTile = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-plate].tile');
    select(t.dataset.plate); t.scrollIntoView({ block: 'nearest' });
    if (onTile && t !== onTile && document.contains(t)) t.focus({ preventScroll: true });
  }
  // After a send from the pass, the next ticket at the pass opens. With none left, the pass shows all clear.
  function advance(fromId){
    // In Your team the next one is the team's next call, never one of your own tickets.
    var box = $('.head-b .folder[data-folder="' + (scope === 'team' ? 'team' : focusView() ? state.folder : 'pass') + '"]');
    var list = (box ? $$('[data-plate]', box) : []).filter(function(t){ return !t.classList.contains('gone') || t.dataset.plate === fromId; });
    var i = list.findIndex(function(t){ return t.dataset.plate === fromId; });
    var rest = list.filter(function(t){ return t.dataset.plate !== fromId && !t.classList.contains('gone'); });
    var nextT = i < 0 ? rest[0] : (list.slice(i + 1).filter(function(t){ return !t.classList.contains('gone'); })[0] || rest[rest.length - 1]);
    if (nextT) select(nextT.dataset.plate);
    else { state.sel = null; if (sheet.open) sheet.close(); place(); }
  }
  // A ticket you just sent leaves every list at once, and the pass count drops with it (council 1b).
  function hideActed(){
    var now = Date.now();
    Object.keys(acted).forEach(function(id){ if (now - acted[id] > 90000) delete acted[id]; });
    $$('.head-b .tile[data-plate]').forEach(function(t){ t.classList.toggle('gone', !!acted[t.dataset.plate]); });
    var n = $$('.head-b .folder[data-folder="pass"] .tile[data-plate]').filter(function(t){ return !t.classList.contains('gone'); }).length;
    var badge = $('.head .badge'), nc = $('.nf[data-folder="pass"] .n');
    // [0-9], not a backslash class: this script sits in a template string, which would eat the backslash.
    if (badge && /^[0-9]+$/.test(badge.textContent)) badge.textContent = n;
    if (nc && /^[0-9]+$/.test(nc.textContent)) nc.textContent = n;
  }

  // ----- Fades and scroll bars -----
  // A list fades at its foot only while real content waits below: the message's own bottom padding (about
  // 34 px) does not count, so its last line never dims over empty space (hill climb r5, Fable and Sol).
  function moreBelow(el){ return el.scrollHeight - el.scrollTop - el.clientHeight > (el.classList.contains('plate-scroll') ? 40 : 4); }
  function fades(){
    $$('.tray-b, .head-b, .stagenav, .plate-scroll, .set-panes').forEach(function(el){ el.classList.toggle('fade-end', moreBelow(el)); });
    $$('.rail, .atts, .stagenav').forEach(railEdge);
  }
  // The kitchen rail and a ticket's attachments fade at the right edge while more wait off screen (hill climb 2 r1).
  function railEdge(el){ el.classList.toggle('fade-right', el.scrollWidth - el.scrollLeft - el.clientWidth > 4); }
  // Kitchen stages with tickets share the width by their longest title, so a long title stacks less and a stage of
  // short ones gives room (hill climb 2 r8, Opus). It only sets each stage's share; the CSS keeps a floor.
  function sizeRail(){
    // Text metrics need no layout, so a hidden kitchen measures too, and one measure serves every window width.
    var cv = sizeRail.cv || (sizeRail.cv = document.createElement('canvas').getContext('2d'));
    var wide = function(el){ var cs = getComputedStyle(el); cv.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily; return cv.measureText((el.textContent || '').trim()).width; };
    $$('.rail>.tray').forEach(function(tr){
      // --name holds the stage's name and count on one line, so an empty stage no longer clips "In progress" or "Ready to
      // merge" (dev words, 2026-11-10): the dot and its 7 px gap, the 6 px gap to the count, the heading's 5 px and the
      // stage's 8 px sides, and 2 px to spare.
      var g = $('.tray-h .g', tr), c = $('.tray-h .n', tr);
      if (g) tr.style.setProperty('--name', Math.ceil(wide(g) + (c ? wide(c) : 0) + 49) + 'px'); else tr.style.removeProperty('--name');
      // --word is the narrowest the stage can be with no word broken: its name's longest word beside the count, and
      // (below) its cards' longest word and top row. .tighter holds it, so a narrow window wraps words, never splits them.
      var word = 0, cw = c ? wide(c) : 0;
      if (g) { wide(g); (g.textContent || '').trim().split(' ').forEach(function(w){ word = Math.max(word, cv.measureText(w).width + cw + 49); }); }
      var setWord = function(){ if (word) tr.style.setProperty('--word', Math.ceil(word) + 'px'); else tr.style.removeProperty('--word'); };
      var ts = $$('.tile .t', tr);
      if (!ts.length) { ['--need', '--floor', '--text', '--text4'].forEach(function(p){ tr.style.removeProperty(p); }); setWord(); return; }
      // A stage's share grows with its longest title as drawn, so the titles take about the same lines everywhere.
      var m = ts.reduce(function(a, t){ return Math.max(a, wide(t)); }, 0);
      tr.style.setProperty('--need', (Math.min(Math.max(m, 160), 560) / 266).toFixed(2));
      // Its floor holds its one-line hint (the stage's 8 px and the heading's 5 px sides), so every stage's first
      // card starts on one line (hill climb 2 r11, Astra).
      var h = $('.tray-h .hint', tr);
      if (h) tr.style.setProperty('--floor', Math.ceil(wide(h) + 28) + 'px'); else tr.style.removeProperty('--floor');
      // --text is the width a card's content needs: its top row whole (the avatar and the age with their gaps; the
      // rail hides the cloche), so no stage clips the avatar, and each title in 5 lines or fewer, wrapped at spaces
      // and after hyphens as the page wraps it. The CSS adds the stage and card sides (hill climb 2 r10 and r11).
      // --text4 is the same with titles in 4 lines, for a window over 1366 px (r13, Opus and Fable).
      var need = $$('.tile .tile-top', tr).reduce(function(a, tt){ var ag = $('.age', tt); return ag ? Math.max(a, wide(ag) + 21) : a; }, 0), need4 = need;
      ts.forEach(function(t){
        wide(t);
        var sp = cv.measureText(' ').width, words = [];
        (t.textContent || '').trim().split(' ').forEach(function(w){
          w.split('-').forEach(function(p, i, all){ if (p || i < all.length - 1) words.push({ w: cv.measureText(i < all.length - 1 ? p + '-' : p).width, sp: i === 0 }); });
        });
        var lines = function(at){ var n = 1, x = 0; words.forEach(function(d){ var gap = x && d.sp ? sp : 0; if (x && x + gap + d.w > at) { n++; x = d.w; } else x += gap + d.w; }); return n; };
        var fit = function(most){ var lo = 40, hi = 220; if (lines(hi) > most) return hi; while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (lines(mid) > most) lo = mid; else hi = mid; } return hi + 2; };
        need4 = Math.max(need4, fit(4)); need = Math.max(need, fit(5));
        words.forEach(function(d){ word = Math.max(word, d.w + 45); });
      });
      tr.style.setProperty('--text', Math.ceil(need) + 'px'); tr.style.setProperty('--text4', Math.ceil(need4) + 'px');
      // The top row: the project's mark and the age (the model hides in a narrow stage).
      word = Math.max(word, $$('.tile .tile-top .age', tr).reduce(function(a, ag){ return Math.max(a, wide(ag) + 21 + 45); }, 0));
      setWord();
    });
    fitRail();
  }
  // The 4-line floor (.four) holds only while the whole rail fits: it is tried, and dropped if the rail would scroll,
  // so a window from 1367 to about 1435 px keeps 5 lines and every title whole (r14, Opus). If the rail still runs
  // past its edge, .tight drops the floors and the titles wrap more, so Merged is never cut off (Dan, 2026-11-10).
  // Run on draw, resize and view change; a hidden rail keeps its state.
  function fitRail(){
    $$('.rail').forEach(function(rail){
      if (!rail.clientWidth) return;
      var over = function(){ return rail.scrollWidth > rail.clientWidth + 1; };
      rail.classList.remove('tight', 'tighter'); rail.classList.add('four');
      if (over()) rail.classList.remove('four');
      if (over()) rail.classList.add('tight');
      // A window near 1280 px: the stage names wrap too.
      if (over()) rail.classList.add('tighter');
    });
    fades();
  }
  var timers = new WeakMap();
  document.addEventListener('scroll', function(ev){
    var el = ev.target; if (!el || !el.classList) return;
    el.classList.add('scrolling');
    clearTimeout(timers.get(el)); timers.set(el, setTimeout(function(){ el.classList.remove('scrolling'); }, 900));
    if (el.matches && el.matches('.tray-b, .head-b, .stagenav, .plate-scroll, .set-panes')) el.classList.toggle('fade-end', moreBelow(el));
    if (el.matches && el.matches('.rail, .atts, .stagenav')) railEdge(el);
    // The ticket's head shows a rule under it once the message scrolls beneath it (Dan, 2026-11-08).
    if (el.matches && el.matches('.plate-scroll')) { var ph = $('.plate-head', el); if (ph) ph.classList.toggle('stuck', el.scrollTop > 0); }
  }, true);
  window.addEventListener('resize', function(){ fitRail(); placeNavMenu(); });
  // The stage list's project menu opens under its button, or above it when there is more room there, and scrolls
  // inside itself when it is still too tall. The stage list can scroll, so the menu is fixed, not clipped by it (PR-Agent on #44).
  function placeNavMenu(){
    var d = $('.stagenav details.pmenu[open]'); if (!d) return;
    var l = $('.pmenu-l', d), sm = $('summary', d); if (!l || !sm || getComputedStyle(l).position !== 'fixed') return;
    var r = sm.getBoundingClientRect(), gap = 6, edge = 12;
    l.style.maxHeight = '';
    var h = l.offsetHeight, below = window.innerHeight - r.bottom - gap - edge, above = r.top - gap - edge;
    var up = h > below && above > below, room = Math.max(120, Math.floor(up ? above : below));
    l.style.left = Math.round(r.left) + 'px';
    l.style.top = up ? '' : Math.round(r.bottom + gap) + 'px';
    l.style.bottom = up ? Math.round(window.innerHeight - r.top + gap) + 'px' : '';
    if (h > room) l.style.maxHeight = room + 'px';
  }
  document.addEventListener('toggle', function(ev){ var d = ev.target; if (d && d.open && d.matches && d.matches('.stagenav details.pmenu')) placeNavMenu(); }, true);
  document.addEventListener('scroll', function(ev){ if (ev.target && ev.target.classList && ev.target.classList.contains('nav-scroll')) placeNavMenu(); }, true);
  // A ticket opens only when you pick it; a phone closes the open one when the window narrows.
  wideQ.addEventListener('change', function(){
    if (!wide()) state.sel = null;
    place();
  });

  // ----- Refresh: swap each region; never the ticket you are working on -----
  // pendingFor: the address pendingHtml was read for. A project pick or Back changes the address while the menu is
  // open, so a page read before it is not replayed when the menu closes (PR-Agent r1 on the view menu).
  var last = Date.now(), pendingHtml = null, pendingFor = null;
  // Missing data renders "not checked": the lists, counts and "Live" go; only a ticket you are writing in stays.
  function lost(why){
    var msg = why + ' at ' + new Date().toLocaleTimeString() + '. The board returns with the next update.';
    net(false, msg); app.classList.add('is-stale'); drawn = {};
    // The red strip says why; each Live dot (the stage list's and the top bar's) turns to "Not checked".
    $$('.lamps li', app).forEach(function(l){ l.className = 'bad'; l.textContent = ''; l.appendChild(document.createElement('i')); l.appendChild(document.createTextNode('Not checked')); });
  }
  // The bar's More menu (Dan, 2026-11-10): a popover, so it sits in the top layer and the dock's scroll never clips it.
  function openMenu(el){ try { return $('.abar .menu:popover-open', el); } catch (x) { return null; } }
  function shut(el){ var mn = el && el.closest && el.closest('.menu'); if (mn) { try { mn.hidePopover(); } catch (x) {} } }
  function menuStep(mn, d){
    var rows = $$('.mi', mn).filter(function(x){ return !x.disabled && x.getClientRects().length; });
    if (!rows.length) return;
    var i = rows.indexOf(document.activeElement);
    rows[i < 0 ? (d > 0 ? 0 : rows.length - 1) : (i + d + rows.length) % rows.length].focus();
  }
  // It opens above its button, left-aligned with it; on a phone, CSS makes it a sheet from the bottom. Toggle events
  // do not bubble, so these listen on the way down.
  function moreOf(mn){ return $('.abar [data-more][popovertarget="' + mn.id + '"]'); }
  document.addEventListener('beforetoggle', function(ev){
    var mn = ev.target; if (!mn.classList || !mn.classList.contains('menu') || ev.newState !== 'open') return;
    var b = moreOf(mn);
    if (!b || !wide()) { mn.style.left = ''; mn.style.bottom = ''; return; }
    var r = b.getBoundingClientRect();
    mn.style.left = Math.max(8, Math.min(r.left, innerWidth - 244)) + 'px';
    mn.style.bottom = Math.max(8, innerHeight - r.top + 8) + 'px';
  }, true);
  document.addEventListener('toggle', function(ev){
    var mn = ev.target; if (!mn.classList || !mn.classList.contains('menu')) return;
    var b = moreOf(mn), on = ev.newState === 'open';
    if (b) b.classList.toggle('on', on);
    if (on && wide() && mn.offsetWidth) mn.style.left = Math.max(8, Math.min(parseFloat(mn.style.left) || 8, innerWidth - mn.offsetWidth - 8)) + 'px';
  }, true);
  function dirty(p){
    if (!p) return false;
    if (p.contains(document.activeElement) && document.activeElement !== p) return true;
    if (p.querySelector('form.act[data-busy], form.act[data-touched]')) return true;
    // An open More menu stays put: a refresh would close it under the pointer.
    if (openMenu(p)) return true;
    return $$('textarea, input[type=text]', p).some(function(x){ return x.value.trim(); });
  }
  // The app blinked every 5 s (Dan, 2026-11-10): each refresh put in a new copy of every list, and the open ticket's
  // card drew without its blue bar for a moment, then faded it back in. Now a list whose HTML has not changed since the
  // last refresh stays as it is. drawn holds that HTML; lost() and a project pick clear it, since both change a list
  // in place. The Live lamp's tooltip names the time of each read, so it is left out of the compare.
  var drawn = {};
  // Each ticket's HTML as the refresh that brought it drew it, before the page marked it up (sync() compares it),
  // without what every draw makes up anew: each form's one-time send id and the More menu's id.
  var plateSrc = new WeakMap();
  function plateKey(html){ return html.replace(/(name="nonce" value=")[^"]*"/g, '$1"').replace(/(id|popovertarget)="m-[^"]*"/g, '$1="m-"'); }
  function plain(html){ return html.replace(/(<li class="ok") title="[^"]*"/g, '$1'); }
  // A list that did change comes in with the open ticket's mark already on it, so no card animates to it, and its
  // cards skip their hover shadow's fade while the pointer finds them again.
  function prime(el){
    if (state.sel) $$('[data-plate="' + CSS.escape(state.sel) + '"]', el).forEach(function(t){ if (t.tagName !== 'FORM') t.classList.add('sel'); });
    $$('.head-b .tile[data-plate]', el).forEach(function(t){ if (acted[t.dataset.plate]) t.classList.add('gone'); });
    el.classList.add('fresh'); setTimeout(function(){ el.classList.remove('fresh'); }, 300);
  }
  function swap(sel, fresh, keepScroll){
    var old = $(sel, app), nu = fresh.querySelector(sel);
    if (!old || !nu) return;
    var html = plain(nu.outerHTML);
    if (drawn[sel] === html) {
      var tips = $$('.lamps li', nu); $$('.lamps li', old).forEach(function(l, i){ if (tips[i]) l.title = tips[i].title; });
      return;
    }
    drawn[sel] = html;
    prime(nu);
    var st = keepScroll ? $$(keepScroll, old).map(function(x){ return x.scrollTop; }) : [];
    old.replaceWith(nu);
    if (keepScroll) $$(keepScroll, nu).forEach(function(x, i){ x.scrollTop = st[i] || 0; });
  }
  // A part only one side has: #yc-team and Your team's panel come and go with the team connection.
  function swapAny(sel, fresh, before, keepScroll){
    var old = $(sel, app), nu = fresh.querySelector(sel);
    // keepScroll: the selectors whose scroll, down and across, survives the swap (each matched by its own order).
    if (old && nu) {
      // Unchanged since the last draw: kept as it is, so nothing blinks (as swap does, #14).
      var html = plain(nu.outerHTML);
      if (drawn[sel] === html) return;
      drawn[sel] = html;
      prime(nu);
      var keep = keepScroll ? keepScroll.split(',').map(function(s){ s = s.trim(); return [s, $$(s, old).map(function(x){ return [x.scrollTop, x.scrollLeft]; })]; }) : [];
      old.replaceWith(nu);
      keep.forEach(function(k){ $$(k[0], nu).forEach(function(x, i){ var p = k[1][i] || [0, 0]; x.scrollTop = p[0]; x.scrollLeft = p[1]; }); });
    }
    else if (old) { old.remove(); delete drawn[sel]; }
    else if (nu) { var b = $(before, app); if (b) b.before(nu); }
  }
  function sync(html){
    if ($('details.pmenu[open]')) { pendingHtml = html; pendingFor = location.search; return; }
    pendingHtml = null;
    // Keep keyboard focus on the same card or stage across the refresh (hill climb r5, Sol).
    var ae = document.activeElement, focusSel = null;
    if (ae && ae.closest && !ae.closest('.plate')) {
      var region = ae.closest('.head-b') ? '.head-b ' : ae.closest('.you') ? '.you ' : ae.closest('.stagenav') ? '.stagenav ' : null;
      var key = ae.dataset && ae.dataset.plate ? '[data-plate="' + ae.dataset.plate + '"]:not(form)' : ae.dataset && ae.dataset.folder ? '.nf[data-folder="' + ae.dataset.folder + '"]' : null;
      if (region && key) focusSel = region + key;
      // Settings sits in the stage list, which a refresh replaces, so its focus is kept too.
      if (!focusSel && ae.matches && ae.matches('[data-settings]')) focusSel = (ae.closest('.stagenav') ? '.stagenav ' : '.bar ') + '[data-settings]';
      // A focused fold (the project menu) keeps focus too (hill climb 2 r5, Sol).
      var fold = ae.tagName === 'SUMMARY' && ae.parentNode && ae.parentNode.classList && ae.parentNode.classList[0];
      // The project menu shows twice in the page (stage list, top bar), so focus returns to the same one.
      if (!focusSel && fold) focusSel = (fold === 'pmenu' ? (ae.closest('.stagenav') ? '.stagenav ' : '.bar ') : '') + 'details.' + fold + ' > summary';
    }
    var t = document.createElement('template'); t.innerHTML = html; var fresh = t.content;
    swap('.stats', fresh); swap('.pmenu', fresh); swap('.bar .lamps', fresh); swap('.stagenav', fresh, '.nav-scroll');
    // You, expanded: its columns come fresh when they change, and each keeps where you scrolled.
    swap('.you', fresh, '.you-b, .tray-b'); swapAny('.team-wait', fresh, '.head'); swapAny('.tboard', fresh, '.head', '.you-b, .tl-s'); swap('.head', fresh, '.head-b');
    swap('#yc-projects', fresh); swapAny('#yc-team', fresh, '#plates'); swap('#yc-rules-now', fresh); if (typeof krLive === 'function') krLive();
    // A card's "Not confirmed" line is the page's own. A list kept from the last refresh still has it, so it goes here,
    // and decorate() and markSent() put back the ones still true, as they did on a new copy.
    $$('.tile > .th.nc', app).forEach(function(m){ m.remove(); });
    $$('.strip:not(.netstrip)', app).forEach(function(s){ s.remove(); });
    var strip = fresh.querySelector('.strip'); if (strip) $('.bar', app).after(strip);
    // Tickets: every one is replaced, except the open one while you pick, type or send in it.
    var store_ = $('#plates'), nuStore = fresh.querySelector('#plates');
    var keep = mounted && dirty(mounted);
    var gone = mounted && !nuStore.querySelector('#' + CSS.escape(mounted.id));
    $$('.plate', nuStore).forEach(function(p){
      if (mounted && p.id === mounted.id) {
        if (keep) return;
        // The open ticket stays as it is while the refresh draws it the same: a new copy dropped the focus and the
        // text you had selected in it every 5 s (Dan, 2026-11-10). Only while nothing is being sent from it: a send in
        // flight or not confirmed is replaced as before, so its one-time id follows the rules it always did. A kept
        // ticket takes the new copy's one-time ids, as the new copy would have brought them.
        var was = plateSrc.get(mounted), now = plateKey(p.outerHTML);
        var sending = $('form.act[data-busy], form.act[data-touched], form[data-sent-sig]', mounted) || unconfirmed[mounted.id];
        if (was === now && !sending) {
          var ids = $$('input[name=nonce]', p); $$('input[name=nonce]', mounted).forEach(function(x, i){ if (ids[i]) x.value = ids[i].value; });
          return;
        }
        plateSrc.set(p, now);
        var s = $('.plate-scroll', mounted), d = $('.dock', mounted), top = s ? s.scrollTop : 0, dtop = d ? d.scrollTop : 0;
        $$('details.more', mounted).forEach(function(x, i){ var y = $$('details.more', p)[i]; if (y) y.open = x.open; });
        // The question card you were reading stays in front through a refresh.
        $$('form.act', mounted).forEach(function(x, i){ var y = $$('form.act', p)[i]; if (y && qAt(x) > 0) qShow(y, qAt(x)); });
        mounted.replaceWith(p); mounted = p;
        var s2 = $('.plate-scroll', p), d2 = $('.dock', p); if (s2) s2.scrollTop = top; if (d2) d2.scrollTop = dtop;
      }
    });
    // A ticket with a send waiting (Undo), in flight, or not confirmed keeps its own form: its picks and note stay.
    var held = {};
    // So does a ticket you left mid-draft (a pick or a note): it waits for you, untouched (council 1b).
    $$('.plate', store_).forEach(function(p){ if (p.querySelector('form.act[data-busy], form.act[data-touched]') || unconfirmed[p.id] || $$('textarea', p).some(function(x){ return x.value.trim(); })) held[p.id] = true; else p.remove(); });
    $$('.plate', nuStore).forEach(function(p){ if ((!mounted || p.id !== mounted.id) && !held[p.id]) { plateSrc.set(p, plateKey(p.outerHTML)); store_.appendChild(p); } });
    // A ticket sent from the pass comes back as soon as the agent hands it back again, not after 90 s.
    Object.keys(acted).forEach(function(aid){ var np = nuStore.querySelector('#' + CSS.escape(aid)) || document.getElementById(aid); if (np && actedLatest[aid] !== undefined && (np.dataset.latest || '') !== actedLatest[aid]) { delete acted[aid]; delete actedLatest[aid]; } });
    hideActed(); setFolder(state.folder); applyScope(); normalizePicked(); sizeRail(); if (KST.changed || !K.mac) relabel(document); restoreDrafts(app); restoreDrafts($('#plates'));
    if (focusSel && document.activeElement !== null && (document.activeElement === document.body || !document.activeElement.isConnected)) { var back = $(focusSel); if (back) back.focus({ preventScroll: true }); }
    // The open ticket left the board on its own: show the next one, unless you are working in it.
    if (gone && !keep) { var id = mounted.id; mounted.remove(); mounted = null; if (acted[id]) { state.sel = null; place(); } else advance(id); return; }
    // The open ticket left the list you are working (an agent picked it up, or it moved stage): the next one opens,
    // unless you are typing or picking in it. The list's own order decides "next".
    if (focusView() && wide() && state.sel && !keep && !acted[state.sel] && !tiles().some(function(x){ return x.dataset.plate === state.sel; })) {
      var nextT = tiles()[0]; state.sel = nextT ? nextT.dataset.plate : null;
    }
    place();
  }
  function replayPending(){
    if (!pendingHtml) return;
    if (pendingFor !== location.search) { pendingHtml = null; return; }
    sync(pendingHtml);
  }
  document.addEventListener('toggle', function(ev){ if (ev.target.matches && ev.target.matches('details.pmenu') && !ev.target.open) replayPending(); }, true);
  var es = new EventSource('/events');
  function net(ok, msg){
    $$('.netstrip').forEach(function(n){ n.remove(); });
    if (ok) return;
    var html = '<div class="strip netstrip" role="status"><b>Not checked</b> ' + msg + '</div>';
    var bar = $('.bar', app); if (bar) bar.insertAdjacentHTML('afterend', html); else document.body.insertAdjacentHTML('afterbegin', html);
    if (mounted) { var s = $('.plate-head', mounted) || $('.plate-scroll', mounted); if (s) s.insertAdjacentHTML('afterbegin', html); }
  }
  es.addEventListener('tick', function(ev){
    var t = {}; try { t = JSON.parse(ev.data); } catch (x) {}
    net(t.ok !== false, 'T3 did not answer: ' + String(t.error || '').replace(/[<>&]/g, ''));
    var q = location.search;
    fetch('/app' + q, { cache: 'no-store' }).then(function(r){ if (!r.ok) throw 0; return r.text(); })
      .then(function(html){ if (q !== location.search) return; if (t.ok !== false) { last = Date.now(); app.classList.remove('is-stale'); } sync(html); Object.keys(unconfirmed).forEach(decorate); markSent(); }, function(){ lost('the Pass did not answer'); });
  });
  es.onerror = function(){ lost('lost the connection to the Pass'); };
  setInterval(function(){ if (Date.now() - last > 15000) { lost('no update for 15 s'); last = Date.now(); } }, 5000);

  // ----- Acting: no confirm; a few seconds with Undo, then it goes -----
  function post(body, keep){
    if (window.yeschef && typeof window.yeschef.act === 'function') return window.yeschef.act(body);
    return fetch('/act', { method: 'POST', body: body, keepalive: !!keep }).then(function(r){ return r.text().then(function(t){ return [r.status, t]; }); });
  }
  function uuid(){ return window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + String(Math.random()).slice(2); }
  var toastTimer = null;
  // acts: [label, run, command]. A button with a command shows that command's key now (relabel follows a change).
  function toast(msg, acts, ms, bad, forId){
    clearTimeout(toastTimer); toastEl.classList.remove('counting');
    // Over an open ticket sheet the toast lives inside it, so its buttons stay clickable above the modal.
    var host = [barDlg, launchDlg, setDlg, sheet].filter(function(d){ return d && d.open; })[0] || document.body;
    if (toastEl.parentNode !== host) { try { toastEl.hidePopover(); } catch (x) {} host.appendChild(toastEl); }
    $('.t-msg', toastEl).textContent = msg; toastEl.classList.toggle('bad', !!bad);
    var box = $('.t-acts', toastEl); box.textContent = ''; toastKey = null;
    (acts || []).forEach(function(a){ var b = document.createElement('button'); b.type = 'button'; b.textContent = a[0]; if (a[2]) { var kb = document.createElement('kbd'); kb.dataset.cmd = a[2]; kb.textContent = keyLabel(a[2]); kb.classList.toggle('nokey', !kb.textContent); b.appendChild(kb); } b.onclick = function(){ hideToast(); a[1](); }; if (a[2] === 'ticket.suggested') toastKey = b.onclick; box.appendChild(b); }); yieldKey();
    try { if (toastEl.matches(':popover-open')) toastEl.hidePopover(); toastEl.showPopover(); } catch (x) {}
    if (ms) toastTimer = setTimeout(hideToast, ms);
    toastFor = forId || null; yieldKey();
  }
  // A toast already showing stays clickable above a dialog opened after it (Opus).
  function liftToast(){
    try {
      if (!toastEl.matches(':popover-open')) return;
      // Only a toast with a button (Undo, Retry, Open) follows a dialog; a plain one steps aside (Opus r6).
      if (!$('.t-acts button', toastEl)) { hideToast(); return; }
      var host = [barDlg, launchDlg, setDlg, sheet].filter(function(d){ return d && d.open; })[0] || document.body;
      toastEl.hidePopover(); if (toastEl.parentNode !== host) host.appendChild(toastEl); toastEl.showPopover();
    } catch (x) {}
  }
  // A toast that shows ⌘↵ (Retry) owns that key while it shows, so the key does what the toast says, never the
  // next ticket's action (hill climb 2 r2, Sol).
  var toastKey = null, toastFor = null;
  function hideToast(){ toastKey = null; toastFor = null; yieldKey(); toastEl.classList.remove('counting'); clearTimeout(toastTimer); try { toastEl.hidePopover(); } catch (x) {} }
  // While a toast owns Cmd+Enter, the open ticket stops showing that key, so only one place offers it (hill climb 2 r3, Opus).
  // The ⌘↵ hint shows where the key goes: the toast's Retry, unless you are writing in a ticket's note (hill climb 2 r4, Astra).
  // The open ticket holds a Retry box of its own (not New thread, which retries from its dialog).
  function ownRetry(){ return !!(mounted && unconfirmed[mounted.id] && $('.retry', mounted)); }
  // The open ticket's form the keys go to: the free form you are in, else the free form you last picked in, else the
  // first free one. A pick in question 2 makes Cmd+Enter send question 2 (r14, Sol and Astra).
  // What an option letter does from target, as onKey does it, and as the router asks before it routes the letter:
  // { radio }, the option it picks; { held }, a question waiting on its Retry that has that letter; or null.
  function letterAt(target, k){
    if (!mounted) return null;
    var here = target && target.closest ? target.closest('form.act') : null, form = keyForm(here);
    if (!form) return null;
    // Letters go to the form Cmd+Enter sends (keyForm), the one that shows the keys (r15, Opus). In it: the question
    // you are in, else the first unanswered, else the last one you picked in.
    // Only a question whose form can send takes a letter: a form waiting on its send or Retry keeps what it sent
    // (hill climb 2 r11, Astra).
    var free = function(fs){ var ff = fs && fs.closest('form.act'); return !!fs && !fs.disabled && !(ff && ff.dataset.busy); };
    var inSet = target && target.closest ? target.closest('fieldset.q-set') : null; if (!free(inSet)) inSet = null;
    // The last question you picked in is waiting on its Retry: a letter meant for it does not spill into another
    // question; the held form says why (hill climb 2 r12, Opus). Only the form that holds the Retry: one waiting out
    // its Undo lets the letter go to the next free question, as before (r13, Opus).
    // Focus anywhere in a free form (its Send button too) means the letter is for that form (r16, Astra).
    var uc = unconfirmed[mounted.id];
    var held = !inSet && form !== here && uc && mounted._lastSet && mounted.contains(mounted._lastSet) && !free(mounted._lastSet) && mounted._lastSet.closest('form.act') === uc.form ? mounted._lastSet : null;
    if (held && $('input[type=radio][data-key="' + k + '"]', held)) return { held: held };
    var lastSet = mounted._lastSet && form.contains(mounted._lastSet) && free(mounted._lastSet) ? mounted._lastSet : null;
    if (inSet && !form.contains(inSet)) inSet = null;
    var sets = $$('fieldset.q-set', form).filter(free);
    // With the questions as cards, a letter answers the card in front (Dan, 2026-11-08).
    var shown = sets.filter(function(fs){ return fs.classList.contains('q-on'); })[0];
    var open = inSet || shown || sets.filter(function(fs){ return !$('input[type=radio]:checked', fs); })[0] || lastSet || sets[0];
    var r = open && $('input[type=radio][data-key="' + k + '"]', open);
    return r && !r.disabled ? { radio: r } : null;
  }
  function keyForm(here){
    if (!mounted) return null;
    var ok = function(f){ return !!f && mounted.contains(f) && !f.dataset.busy; };
    if (ok(here)) return here;
    var ls = mounted._lastSet && mounted.contains(mounted._lastSet) ? mounted._lastSet.closest('form.act') : null;
    return ok(ls) ? ls : $('form.act:not([data-busy])', mounted);
  }
  function yieldKey(){
    var a = document.activeElement, w = a && a.closest && a.closest('textarea, input[type=text]'), wf = w && w.closest('form.act');
    // While the open ticket holds its Retry, focus in one of its free forms sends that form, else the Retry box does:
    // the hint shows on the one the key sends, as the key handler decides (r13, Astra and Sol).
    var own = ownRetry(), af = own && a && a.closest && a.closest('form.act'), ff = af && mounted.contains(af) && !af.dataset.busy ? af : null;
    $$('.plate kbd').forEach(function(kb){
      if (kb.textContent !== SK()) return;
      var rt = kb.closest('[data-retry]');
      if (own && mounted.contains(kb)) kb.classList.toggle('yield', rt ? !!ff : !(ff && kb.closest('form.act') === ff));
      else if (!rt) kb.classList.toggle('yield', !!toastKey && !(wf && kb.closest('form.act') === wf));
    });
    // A ticket with more than one free form: the one the keys go to (keyForm, as the key handler picks) keeps the blue
    // and its key hints; the others step aside (r14, Sol and Astra).
    $$('.plate form.act.aside, .plate form.act.keyto').forEach(function(f){ f.classList.remove('aside', 'keyto'); });
    // With the Retry held, the free form you are in takes the blue from the Retry box, with its key (r15, Astra).
    if (ff) ff.classList.add('keyto');
    if (mounted && !own) {
      var open = $$('form.act:not([data-busy])', mounted);
      if (open.length > 1) { var to = keyForm(a && a.closest && a.closest('form.act')); open.forEach(function(f){ if (f !== to) f.classList.add('aside'); }); }
    }
    // While you write, ⌘↵ sends what you are writing, so the toast stops showing it (hill climb 2 r4, Opus).
    // Settings, New thread, the action bar and the screenshot viewer take the keys first, so the toast shows none over them (hill climb 2 r5, Astra).
    var modal = [barDlg, setDlg, launchDlg, viewer].some(function(d){ return d && d.open; });
    $$('#toast button kbd').forEach(function(kb){ kb.classList.toggle('yield', !!w || modal || !!ownRetry()); });
    // The toast steps aside while its own ticket is open with its Retry box, which says the same and owns the key (r12, Opus, Sol). New thread's dialog says it too, with Launch again (r13, Astra and Sol).
    toastEl.classList.toggle('mine', (!!toastFor && !!mounted && mounted.id === toastFor && !!ownRetry()) || (toastFor === 'launch' && !!launchDlg && launchDlg.open && !!unconfirmed.launch));
    // A letter an option takes (E on a fifth option, H on an eighth) is not shown on Settle or Hold (hill climb 2 r4, Opus).
    $$('.plate form.act').forEach(function(f){
      var taken = {}; $$('fieldset.q-set:not([disabled]) input[data-key]', f).forEach(function(r){ if (r.dataset.key) taken[r.dataset.key.toUpperCase()] = 1; });
      $$('button[name=kind] kbd', f).forEach(function(kb){ kb.classList.toggle('taken', kb.textContent.length === 1 && !!taken[kb.textContent]); });
    });
  }
  document.addEventListener('focusin', yieldKey);
  [setDlg, launchDlg, viewer].forEach(function(d){ if (d) d.addEventListener('close', yieldKey); });
  document.addEventListener('focusout', function(){ setTimeout(yieldKey, 0); });
  // "Not confirmed: …" becomes "Not confirmed for “Ticket”: …"; any other result starts with the ticket.
  function named(f, text){
    var n = f && f.dataset.named; if (!n) return text;
    return /^Not confirmed: /.test(text) ? text.replace(/^Not confirmed: /, 'Not confirmed for ' + n + ': ') : n + ': ' + text;
  }
  // The project select locks too, so a send waiting out its Undo cannot be saved under its id with another project
  // (hill climb 2 r8, Sol).
  function lock(f, on){ $$('input, textarea, button, select', f).forEach(function(x){ if (on) { x.dataset.was = x.disabled ? '1' : ''; x.disabled = true; } else { x.disabled = x.dataset.was === '1'; } }); }
  function say(f, text, tone){ var r = $('.result', f); if (r) { r.textContent = text; r.className = 'result ' + (tone || ''); } }
  function picks(f){ return $$('fieldset.q-set', f).map(function(fs, i){ var c = $('input[type=radio]:checked', fs); return c ? c.value : null; }); }
  // The picks as words for a toast or a Retry: a call's option text, not its letter ("Yes, merge once CI is…", not "a"),
  // without the "(Recommended)" tag, cut at a word near 32 characters (r15, Opus; 32 so a short option ends whole, r16, Astra).
  function pickNames(f){
    return $$('fieldset.q-set', f).map(function(fs){
      var c = $('input[type=radio]:checked', fs); if (!c) return null;
      var x = c.value, t = /^c:/.test(c.name) && c.parentNode ? $('.opt-t', c.parentNode) : null;
      if (t) { var b = $('b', t), rc = $('.rec', t); x = t.textContent; if (b) x = x.replace(b.textContent, ''); if (rc) x = x.replace(rc.textContent, ''); x = x.trim() || c.value; }
      x = x.replace(/ *[(]recommended[)] *$/i, '');
      if (x.length <= 32) return x;
      var cut = x.slice(0, 31), sp = cut.lastIndexOf(' ');
      return (sp > 12 ? cut.slice(0, sp) : cut).replace(/[ ,.;:]+$/, '') + '…';
    }).filter(Boolean).join(', ');
  }
  function validate(f, kind, btn){
    if (kind === 'call' || kind === 'answer') {
      var need = $$('fieldset.q-set', f).filter(function(fs){ return $('input[data-need]', fs) && !$('input[type=radio]:checked', fs); });
      // The first unanswered question comes forward, so the message points at something you can see.
      if (need.length && !$('fieldset.q-set[disabled]', f)) { qShow(f, qSets(f).indexOf(need[0])); return need.length > 1 ? 'Answer every decision first.' : 'Pick an answer first.'; }
      // An empty answer of your own: its card comes forward (PR-Agent r1 on #50).
      var custom = $$('input[data-custom]:checked', f).filter(function(r){ return !$('.custom', r.parentNode).value.trim(); })[0];
      if (custom) { qShow(f, qSets(f).indexOf(custom.closest('fieldset'))); return 'Write your own answer first.'; }
    }
    // Hold and Settle send the agent nothing: a written note would be lost, so they wait (council 3, Opus).
    if ((kind === 'hold' || kind === 'settle') && f.elements.note && f.elements.note.tagName === 'TEXTAREA' && f.elements.note.value.trim()) return (kind === 'hold' ? 'Hold' : 'Settle') + ' sends the agent nothing, so your note would be lost. Send it with Reply (R) first, or clear it.';
    if (btn && btn.hasAttribute('data-note') && !(f.elements.note && f.elements.note.value.trim())) return kind === 'refire' ? 'Request changes needs a note: what should the agent fix?' : 'Write the reply first.';
    if (kind === 'launch') {
      if (!f.elements.project.value) return 'Pick a project.';
      if (!f.elements.prompt.value.trim()) return 'Write what the agent should do.';
    }
    return null;
  }
  // Several questions show one at a time, as cards (Dan, 2026-11-08). The server marks the first one; these move
  // between them and fill a dot for each one answered. Dan picked cards over a Gmail-style stack (2026-11-08).
  function qSets(f){ return $$('fieldset.q-set', f); }
  function qAt(f){ var s = qSets(f); for (var i = 0; i < s.length; i++) if (s[i].classList.contains('q-on')) return i; return 0; }
  function qShow(f, i){
    var s = qSets(f); if (s.length < 2) return;
    i = Math.max(0, Math.min(s.length - 1, i | 0));
    var moved = qAt(f) !== i, ae = document.activeElement, was = ae && ae.closest ? ae.closest('fieldset.q-set') : null;
    s.forEach(function(x, n){ x.classList.toggle('q-on', n === i); });
    // Focus in the card that hides goes to the card that shows, its pick or its first option (PR-Agent r7 on #50).
    if (moved && was && f.contains(was) && was !== s[i]) { var fo = $('input[type=radio]:checked', s[i]) || $('input[type=radio]', s[i]); if (fo) fo.focus({ preventScroll: true }); }
    // A new card opens at its top: a dock scrolled down the last card scrolls back to "1 of 3" (PR-Agent r2 on #50).
    var d = f.closest('.dock'), nav = $('.q-nav', f);
    if (moved && d && nav) { var over = nav.getBoundingClientRect().top - d.getBoundingClientRect().top; if (over < 0) d.scrollTop += over; }
    var pos = $('.q-pos', f); if (pos) pos.textContent = (i + 1) + ' of ' + s.length;
    $$('.q-dot', f).forEach(function(d, n){ d.classList.toggle('on', n === i); d.classList.toggle('done', !!$('input[type=radio]:checked', s[n])); if (n === i) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current'); });
    var pv = $('[data-qgo="-1"]', f), nx = $('[data-qgo="1"]', f); if (pv) pv.disabled = i === 0; if (nx) nx.disabled = i === s.length - 1;
  }
  // After a pick, the next question you have not answered comes forward; with all answered, the card stays.
  function qNext(f){ var s = qSets(f), at = qAt(f); for (var n = 1; n < s.length; n++) { var j = (at + n) % s.length; if (!$('input[type=radio]:checked', s[j])) { qShow(f, j); return; } } qShow(f, at); }
  document.addEventListener('click', function(ev){
    var b = ev.target.closest && ev.target.closest('[data-qgo], [data-qto]'); if (!b) return;
    var f = b.closest('form.act'); if (!f) return;
    ev.preventDefault();
    qShow(f, b.hasAttribute('data-qto') ? +b.dataset.qto : qAt(f) + (+b.dataset.qgo));
  });
  // The primary is the recommended action: with nothing picked, each decision takes the option the agent recommends.
  function recPick(f){ $$('fieldset.q-set:not([disabled])', f).forEach(function(fs){ if ($('input[type=radio]:checked', fs)) return; var r = $('input[data-rec]', fs); if (r) r.checked = true; }); }
  function primaryLabel(f){
    var b = f && $('button.primary[value=call], button.primary[value=answer]', f); if (!b || !$('.bl', b)) return;
    // A retry form keeps its "Send again" label: the answer is fixed (Fable r6).
    if ($('fieldset.q-set[disabled]', f)) return;
    // One form for both question kinds, by letter: "Send b" (hill climb r4, Fable). The bar keeps one word or two
    // (Dan, 2026-11-10), so "(recommended)" moved to the tooltip: "Send your answer, a (recommended)" while the
    // agent's pick stands. Your own typed answer reads "Send your answer".
    var plan = $$('fieldset.q-set', f).map(function(fs){
      var c = $('input[type=radio]:checked', fs), x = c || $('input[data-rec]', fs);
      if (!x) return null;
      return { key: x.hasAttribute('data-custom') ? '' : (x.dataset.key || x.value), rec: !c };
    });
    var picks = plan.every(Boolean) && !plan.some(function(p){ return !p.key; })
      ? (plan.length > 1 ? plan.map(function(p, i){ return (i + 1) + p.key; }).join(', ') : plan[0].key) : '';
    // The button names two picks at most ("Send 1a, 2b"); three or more read "Send all", so the label fits the phone's
    // pill (PR-Agent r2 on #72). The tooltip keeps every pick.
    var txt = !plan.every(Boolean) ? 'Send answer' : picks ? (plan.length > 2 ? 'Send all' : 'Send ' + picks) : 'Send your answer';
    $('.bl', b).textContent = txt;
    var tn = $('.tn', b);
    if (tn) tn.textContent = 'Send your answer' + (picks ? ', ' + picks + (plan.some(function(p){ return p.rec; }) ? ' (recommended)' : '') : '');
  }
  // Settings (Gmail-style): density for the lists. Saved on this Mac only. Every ticket's actions sit in one bar at
  // its foot (Dan, 2026-11-10): the Side panel layout is gone, and a stored yc.layout2 is no longer read.
  var prefs = { density: store('yc.density') || 'default', theme: store('yc.theme') };
  function applyPrefs(){
    if (!/^(default|comfortable|compact)$/.test(prefs.density)) prefs.density = 'default';
    ['default', 'comfortable', 'compact'].forEach(function(d){ root.classList.toggle('d-' + d, prefs.density === d); });
    $$('#settings input[name=density]').forEach(function(r){ r.checked = r.value === prefs.density; });
    applyTheme();
    fades();
  }
  // Appearance (PR 3 of the action bar): System, Light or Dark, saved on this Mac. System stores nothing.
  // In the desktop app the window's own parts (title bar, menus, the update card) follow too, through the preload bridge.
  var THEME_NAME = { system: 'System', light: 'Light', dark: 'Dark' };
  function applyTheme(){
    if (!/^(light|dark)$/.test(prefs.theme)) prefs.theme = 'system';
    if (prefs.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', prefs.theme);
    $$('#settings input[name=theme]').forEach(function(r){ r.checked = r.value === prefs.theme; });
    try { if (window.yeschef && typeof window.yeschef.theme === 'function') window.yeschef.theme(prefs.theme); } catch (x) {}
  }
  function setTheme(t){
    prefs.theme = t; if (t === 'light' || t === 'dark') store('yc.theme', t); else forget('yc.theme');
    applyTheme();
  }
  // The order of T3 Code's appearance.cycle: System, Light, Dark.
  function cycleTheme(){ setTheme({ system: 'light', light: 'dark', dark: 'system' }[prefs.theme] || 'system'); toast('Appearance: ' + THEME_NAME[prefs.theme], null, 2000); }
  // Settings has sections (Dan, 2026-11-07): Layout and Shortcuts. Cmd+, opens Layout; ? opens Shortcuts.
  function openSettings(tab){
    applyPrefs(); if (typeof krRender === 'function') { krProjects(); krLive(); krRender(); krSay(krErr, !!krErr); }
    tab = tab || 'layout';
    // Each tab opens at its top.
    var was = $('#settings .set-tab[aria-current]'), panes = $('#settings .set-panes');
    if (panes && (!setDlg.open || !was || was.dataset.tab !== tab)) panes.scrollTop = 0;
    $$('#settings .set-tab').forEach(function(b){ if (b.dataset.tab === tab) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
    $$('#settings .set-pane').forEach(function(p){ p.hidden = p.dataset.pane !== tab; });
    if (tab === 'keys') kxRender();
    // showModal focuses the first tab, Layout; the open section's tab takes focus, so ? never rings Layout.
    if (!setDlg.open) { setDlg.showModal(); liftToast(); yieldKey(); var curTab = $('#settings .set-tab[aria-current]'); if (curTab) curTab.focus(); }
    fades();
  }
  setDlg.addEventListener('click', function(ev){ var t = ev.target.closest && ev.target.closest('.set-tab'); if (t) openSettings(t.dataset.tab); });
  // Kitchen rules (Dan, 2026-11-08): each change saves at once, like T3 Code's settings. "Applies to" shows All projects
  // or one project; a change there is that project's own value, and Reset gives it back to All projects.
  var KR = null; try { KR = JSON.parse(($('#yc-rules') || {}).textContent || 'null'); } catch (x) { KR = null; }
  // A failed save keeps saying so until one works; the menus go back to what is saved (PR-Agent on #49).
  var krErr = (($('#settings [data-pane=rules]') || {}).dataset || {}).krError || '', krBusy = 0, krSeq = 0;
  // Notes that failed to save stay as a draft, per scope, until a save of them works (PR-Agent r3 on #49).
  var krDraft = {};
  // A saved set, from a save's answer or a refresh, is taken only when its revision is the newest seen, whatever order
  // they arrive in (PR-Agent r10 on #49). Another window's change comes in this way too.
  var krRev = 0;
  function krAccept(text){
    var o; try { o = JSON.parse(text); } catch (x) { return false; }
    if (!o || !o.all || !(o.rev >= krRev)) return false;
    krRev = o.rev; KR = o;
    var now = $('#yc-rules-now'); if (now && now.textContent !== text) now.textContent = text;
    return true;
  }
  function krLive(){
    var el = $('#yc-rules-now'); if (!el) return;
    if (krAccept(el.textContent) && setDlg.open) krRender();
  }
  function krScope(){ var s = $('#kr-scope'); return s ? s.value : ''; }
  function krRender(){
    if (!KR) return;
    var sc = krScope(), own = sc ? (KR.projects[sc] || {}) : {}, val = function(k){ return Object.prototype.hasOwnProperty.call(own, k) ? own[k] : KR.all[k]; };
    $$('#settings [data-kr]').forEach(function(el){
      var k = el.dataset.kr, v = val(k);
      // Menus always show the saved value, so a failed choice can be picked again (PR-Agent r2 on #49). The notes box
      // keeps what you are typing, and keeps it after a failed save, so nothing you wrote is lost.
      if (el.tagName === 'TEXTAREA' && Object.prototype.hasOwnProperty.call(krSending, sc)) v = krSending[sc];
      else if (el.tagName === 'TEXTAREA' && Object.prototype.hasOwnProperty.call(krDraft, sc)) v = krDraft[sc];
      if (el.type === 'checkbox') el.checked = v === 'on'; else if (el.tagName !== 'TEXTAREA' || document.activeElement !== el) el.value = v == null ? '' : v;
      var row = el.closest('.kr-row'); if (row) row.classList.toggle('kr-over', !!sc && Object.prototype.hasOwnProperty.call(own, k));
    });
    var m = $('#settings .kr-row[data-row=missing]'); if (m) m.classList.toggle('kr-off', val('screens') !== 'on');
  }
  // "Applies to" follows T3's project list, which comes with each board refresh (PR-Agent on #49).
  function krProjects(){
    var s = $('#kr-scope'), src = $('#yc-projects'); if (!s || !src) return;
    var keep = s.value;
    while (s.options.length > 1) s.options[1].parentNode.removeChild(s.options[1]);
    $$('option', src).forEach(function(o){ s.appendChild(o.cloneNode(true)); });
    s.value = keep; if (s.value !== keep) s.value = '';
  }
  // Its word shows in the footer, where "Saved on this Mac." sits; it goes back to that when Settings opens again.
  function krSay(t, bad){ var s = $('#settings .set-done span'); if (s) { s.textContent = t || 'Saved on this Mac.'; s.classList.toggle('bad', !!bad); } }
  // Sends one change at once, with keepalive, so nothing waits in the page when it closes (PR-Agent r7 on #49). Each
  // answer is the whole saved set; only the newest one sent updates the page, whatever order they come back in.
  // The page and the count go with each save: Yes Chef skips a save older than one it already took from this page,
  // so two saves that cross on the way land in the order you made them (PR-Agent r8 on #49).
  // krSending: notes on their way, per project, shown until their own save answers (PR-Agent r11 on #49).
  var krPage = uuid(), krNotesLast = {}, krSending = {};
  function krSave(q, notes){
    var sc = krScope(), my = ++krSeq;
    if (notes != null) { krNotesLast[sc] = my; krSending[sc] = notes; }
    krSay('Saving…'); krBusy++;
    // Only the newest notes save for a project decides whether its draft stays (PR-Agent r8 on #49).
    function noteResult(ok){ if (notes == null || krNotesLast[sc] !== my) return; delete krSending[sc]; if (ok) delete krDraft[sc]; else krDraft[sc] = notes; }
    post('kind=rules&nonce=' + encodeURIComponent(uuid()) + '&page=' + encodeURIComponent(krPage) + '&seq=' + my + '&' + q, true)
      .then(function(r){
        krBusy--;
        if (r[0] === 200) {
          // The page's copy of the saved rules moves with the save, so an older copy never comes back (PR-Agent r6 on #49).
          krAccept(r[1]);
          noteResult(true);
          // Notes still unsaved somewhere keep the footer red, so "Saved" never stands beside them (PR-Agent r5 on #49);
          // and "Saved" waits until no save is still on its way (r10).
          krErr = Object.keys(krDraft).length ? 'House notes not saved yet. Change them to try again.' : '';
          krRender(); krSay(krErr || (krNotesT ? 'Not saved yet…' : krBusy ? 'Saving…' : 'Saved. New threads get these rules.'), !!krErr);
        }
        else { noteResult(false); krFail(String(r[1] || 'Not saved.')); }
      }, function(){ krBusy--; noteResult(false); krFail('Not saved: Yes Chef did not answer.'); });
  }
  function krFail(t){ krErr = t; krRender(); krSay(t, true); }
  function krSet(k, v){
    krSave('scope=' + encodeURIComponent(krScope()) + '&key=' + encodeURIComponent(k) + '&value=' + encodeURIComponent(v), k === 'notes' ? v : null);
  }
  // House notes save while you type, a moment after you stop, and at once when you leave the box or close the
  // window, so notes never sit unsaved beside "Saved" (PR-Agent r6 on #49). Saving the same text twice is harmless.
  var krNotesT = null;
  function krNotes(){
    clearTimeout(krNotesT); krNotesT = null;
    var t = $('#settings [data-kr=notes]'); if (!t || !KR) return;
    krSet('notes', t.value);
  }
  setDlg.addEventListener('input', function(ev){
    if (!ev.target || !ev.target.dataset || ev.target.dataset.kr !== 'notes') return;
    krSay('Not saved yet…'); clearTimeout(krNotesT); krNotesT = setTimeout(krNotes, 800);
  });
  window.addEventListener('pagehide', function(){ if (krNotesT) krNotes(); });
  setDlg.addEventListener('change', function(ev){
    var el = ev.target; if (!KR || !el) return;
    if (el.id === 'kr-scope') { krRender(); krSay(krErr, !!krErr); return; }
    if (!el.dataset || !el.dataset.kr) return;
    if (el.dataset.kr === 'notes') { krNotes(); return; }
    krSet(el.dataset.kr, el.type === 'checkbox' ? (el.checked ? 'on' : 'off') : el.value);
  });
  setDlg.addEventListener('click', function(ev){
    var b = ev.target.closest && ev.target.closest('[data-kr-reset]'), sc = krScope();
    if (!b || !KR || !sc) return;
    // Reset drops the draft, and no notes save still on its way can bring it back (PR-Agent r9 on #49).
    if (b.dataset.krReset === 'notes') { delete krDraft[sc]; delete krSending[sc]; krNotesLast[sc] = -1; clearTimeout(krNotesT); krNotesT = null; }
    krSave('scope=' + encodeURIComponent(sc) + '&key=' + encodeURIComponent(b.dataset.krReset) + '&reset=1');
  });
  // The Pass's flag: "Ask for them" fills Reply with the ask. Cmd+Enter sends it, with its Undo; you can change it first.
  document.addEventListener('click', function(ev){
    var b = ev.target.closest && ev.target.closest('[data-ask-shots]'); if (!b) return;
    var p = b.closest('.plate'), f = p && $('form.act', p); if (!f || !f.elements.note) return;
    setIntent(f, 'reply');
    // A reply you already started stays; the ask goes under it (PR-Agent r5 on #49).
    var cur = f.elements.note.value.trimEnd(), add = cur ? cur + '\\n\\n' + b.dataset.askShots : b.dataset.askShots;
    // A reply holds 4,000 characters (client/actions.mjs MAX_NOTE). Past that, say so; never send a cut ask (PR-Agent r6 on #49).
    if (cur.indexOf(b.dataset.askShots) < 0 && add.length > 4000) { toast('Your reply is too long to add the ask. Shorten it first.', null, 5000, true); f.elements.note.focus(); return; }
    if (cur.indexOf(b.dataset.askShots) < 0) f.elements.note.value = add;
    f.elements.note.dispatchEvent(new Event('input', { bubbles: true }));
    f.elements.note.focus();
  });
  // A new thread in T3 Code from here (Cmd+T or Cmd+N; Cmd+K is the action bar, Dan 2026-11-10). The project list comes
  // with each board refresh.
  function openLaunch(){
    var f = $('form.launch', launchDlg), sel = f.elements.project, src = $('#yc-projects');
    var keep = sel.value;
    sel.textContent = '';
    if (src) $$('option', src).forEach(function(o){ sel.appendChild(o.cloneNode(true)); });
    // Start in the project of the ticket you are looking at, else the last one used. A draft in progress keeps
    // the project it was written for (hill climb 2 r6, Astra). The name comes from data-project: the label's
    // text also holds the letter avatar.
    var here = mounted && ($('.plate-bar .proj', mounted) || { dataset: {} }).dataset.project;
    var pick = $$('option', sel).filter(function(o){ return o.textContent === here; })[0];
    var drafting = (f.elements.prompt.value || f.elements.title.value) && keep && $$('option', sel).some(function(o){ return o.value === keep; });
    sel.value = drafting ? keep : pick ? pick.value : (keep || store('yc.launchProject') || sel.value);
    // A draft whose project T3 no longer lists has no project picked, so it never launches in another one
    // (PR-Agent r4 on #38).
    if (f.dataset.lost && (f.elements.prompt.value || f.elements.title.value)) sel.selectedIndex = -1;
    restoreLaunch(f);
    if (!f.elements.nonce.value) f.elements.nonce.value = uuid();
    say(f, f.dataset.sentSig ? 'Not confirmed: this thread may already have started. Check T3 Code; launching it unchanged is the same request.' : f.dataset.lost && sel.selectedIndex < 0 ? 'Pick a project. The one this draft was for is no longer in T3 Code.' : '', f.dataset.sentSig || f.dataset.lost ? 'bad' : '');
    if (!launchDlg.open) { launchDlg.showModal(); liftToast(); yieldKey(); }
    f.elements.prompt.focus();
  }
  launchDlg.addEventListener('click', function(ev){ if (ev.target === launchDlg || (ev.target.closest && ev.target.closest('[data-launch-cancel]'))) launchDlg.close(); });
  setDlg.addEventListener('change', function(ev){
    var r = ev.target;
    if (r.name === 'theme') { setTheme(r.value); return; }
    if (r.name !== 'density') return;
    prefs.density = r.value; store('yc.density', r.value); applyPrefs();
  });
  // The action bar's Density rows set it the way Settings does.
  function setDensity(d){ prefs.density = d; store('yc.density', d); applyPrefs(); }
  setDlg.addEventListener('click', function(ev){ if (ev.target === setDlg || ev.target.closest('[data-settings-done]')) setDlg.close(); });
  // The note unfolds when asked for, and folds again once sent or left empty.
  function noting(f, on){ if (!f) return; f.classList.toggle('noting', !!on); if (on && f.elements.note && f.elements.note.focus) f.elements.note.focus(); }
  // One intent per form: a click on Reply or Request changes with no note yet, or R / F, arms it; Cmd+Enter then sends it.
  function setIntent(f, kind){
    if (!f) return;
    if (kind) noting(f, true);
    if (kind) f.dataset.intent = kind; else delete f.dataset.intent;
    // The blue button is always what Cmd+Enter sends: the armed Reply or Request changes takes the fill and the Cmd+Enter
    // key while armed; the recommended action gets them back when the intent clears (hill climb r1, Astra).
    $$('button[name=kind]', f).forEach(function(b){
      var kb = $('kbd', b);
      if (b.dataset.fill === undefined) { b.dataset.fill = b.classList.contains('fill') ? '1' : ''; if (kb) b.dataset.key = kb.textContent; }
      var on = !!kind && b.value === kind, lead = kind ? on : b.dataset.fill === '1';
      b.classList.toggle('armed', on);
      b.classList.toggle('fill', lead);
      if (kb) { kb.textContent = on ? SK() : b.dataset.key; kb.classList.toggle('nokey', !kb.textContent); kb.hidden = !!kind && !on && b.dataset.key === SK(); }
      // The blue action's tooltip says "M or ⌘↵": while another action is armed, Cmd+Enter is that one's.
      $$('kbd', b).slice(1).forEach(function(k2){ k2.hidden = !!kind && !on; });
    });
    var lab = f.querySelector('.note > span');
    if (lab) { if (!lab.dataset.base) lab.dataset.base = lab.innerHTML; if (kind === 'reply') lab.textContent = 'Your reply'; else if (kind === 'refire') lab.textContent = 'Request changes: what should the agent fix?'; else lab.innerHTML = lab.dataset.base; }
    var note = f.elements.note;
    if (note && note.tagName === 'TEXTAREA') note.placeholder = kind === 'reply' ? 'For example: go with b, and add a test for it.' : kind === 'refire' ? 'For example: the button overlaps on phones. Fix it and shoot it again.' : 'What should the agent know?';
    // The armed action is part of the draft, so a reload never turns a Reply into the recommended answer (hill climb 2 r3, Sol).
    if (f.dataset.restored && !f._restoring) saveDraft(f);
    noteKey(f);
  }
  // With a note written and nothing armed or recommended, Cmd+Enter sends a Reply, so Reply shows the key then
  // (hill climb 2 r6, Opus).
  // A note that went to the agent before its latest message, still unchanged. Cmd+Enter does not send it again, and
  // no answer or Go carries it; Reply (R or its button) sends it on purpose (hill climb 2 r8, Opus).
  function stale(f){ return !!f && f.dataset.stale !== undefined && !!f.elements.note && f.elements.note.value === f.dataset.stale; }
  function noteKey(f){
    var b = f && $('button[name=kind][value=reply]', f), kb = b && $('kbd', b);
    if (kb) {
      if (b.dataset.fill === undefined) { b.dataset.fill = b.classList.contains('fill') ? '1' : ''; b.dataset.key = kb.textContent; }
      var free = !f.dataset.intent && !$('button.primary', f), wrote = !!(f.elements.note && f.elements.note.value && f.elements.note.value.trim()) && !stale(f);
      if (!f.dataset.intent) { kb.textContent = free && wrote ? SK() : b.dataset.key; kb.classList.toggle('nokey', !kb.textContent); }
      // The button Cmd+Enter sends is the blue one, so Reply fills while it owns the key (r16, Astra).
      if (!f.dataset.intent) b.classList.toggle('fill', b.dataset.fill === '1' || (free && wrote));
    }
    yieldKey();
  }
  // Sends waiting out their Undo, newest last. Z and the toast always undo the newest; an older send never hides it.
  var pendingSends = [];
  function showUndo(){
    var p = pendingSends[pendingSends.length - 1]; if (!p) return false;
    var n = pendingSends.length;
    var left = Math.max(600, p.until - Date.now());
    toast((n > 1 ? n + ' sends waiting. ' : '') + p.label, [['Undo', p.undo, 'send.undo']], left);
    toastEl.style.setProperty('--undo-ms', left + 'ms'); toastEl.classList.remove('counting'); void toastEl.offsetWidth; toastEl.classList.add('counting');
    return true;
  }
  // Reload and a project switch never leave the page (council 3). Quit, closing the window and Force Reload wait for
  // __ycBusy to turn false (desktop/main.mjs): each send keeps its full Undo, goes, and T3 answers before the page goes
  // (hill climb 2 r1, Sol). Only a page that leaves without asking (a crash, a browser tab) sends what was waiting
  // on its way out, rather than dropping it.
  // Busy while any send waits out its Undo, or one sent less than 10 s ago has no answer yet. The app asks again and
  // again, so a send queued while it waits still gets its full four seconds (hill climb 2 r2, Astra).
  var flights = [];
  window.__ycBusy = function(){ var now = Date.now(); return pendingSends.length > 0 || flights.some(function(t){ return now - t < 10000; }); };
  // Every post that waits on T3's answer is in flight, a Retry too, so Quit waits for it (PR-Agent r3 on #38).
  function fly(body, keep){
    var t = Date.now(); flights.push(t);
    var done = function(){ var i = flights.indexOf(t); if (i >= 0) flights.splice(i, 1); };
    return post(body, keep).then(function(r){ done(); return r; }, function(e){ done(); throw e; });
  }
  // A browser tab asks before it leaves while a send waits out its Undo, so Undo stays possible (hill climb 2 r2).
  // The desktop app skips the question: its drain has already let every send finish (main.mjs).
  window.addEventListener('beforeunload', function(ev){ if (pendingSends.length) { ev.preventDefault(); ev.returnValue = ''; } });
  window.addEventListener('pagehide', function(){ pendingSends.slice().forEach(function(p){ p.fire(true); }); });
  function send(f, btn){
    // Your team's actions wait for the team connection: nothing a teammate's agent could act on leaves this Mac yet.
    if (f.classList.contains('team-act')) { say(f, 'Not sent: Yes Chef does not have the team connection yet.', 'bad'); return; }
    // A send waiting on its answer goes nowhere, but one that is not confirmed goes again, the same bytes.
    if (f.dataset.busy) { var uid = f.classList.contains('launch') ? 'launch' : f.dataset.plate; if (unconfirmed[uid]) retry(uid); return; }
    if ((btn.value === 'call' || btn.value === 'answer') && btn.classList.contains('primary')) recPick(f);
    var kind = btn.value, why = validate(f, kind, btn);
    if (why) {
      // A refusal keeps a not-confirmed send's warning on the form (hill climb 2 r12, Astra).
      say(f, why + (f.dataset.sentSig ? ' The first send is still not confirmed: sending it unchanged is the same request.' : ''), 'bad');
      // Reply or Request changes with no note yet: arm it and put you in the note.
      if (btn.hasAttribute('data-note') && f.elements.note) { setIntent(f, kind); f.elements.note.focus(); }
      return;
    }
    if (stale(f) && kind !== 'reply' && kind !== 'refire') { say(f, 'You sent this note before the agent’s latest message, so it may have reached the agent. Send it again with Reply (R), change it, or clear it.', 'bad'); return; }
    // A restored send repeated as another kind, or changed, is a new send (PR-Agent r2 on #38). Only a send that
    // goes gets a new id: a refused Hold or Settle keeps the restored one (hill climb 2 r8, Astra).
    if (f.dataset.sentSig && (!sameKind(sendKind(f, btn.value), f.dataset.sentKind || '') || !sameSent(f))) freshNonce(f);
    var fd = new FormData(f); fd.set('kind', kind);
    $$('input[data-custom]:checked', f).forEach(function(r){ fd.set(r.name, $('.custom', r.parentNode).value); });
    if (kind !== 'call' && kind !== 'answer') $$('fieldset.q-set input[type=radio]', f).forEach(function(r){ fd.delete(r.name); });
    var body = new URLSearchParams(fd).toString();
    var isLaunch = kind === 'launch';
    var id = isLaunch ? 'launch' : f.dataset.plate, p = isLaunch ? null : plateNode(id);
    var title = isLaunch ? (f.elements.title.value.trim() || f.elements.prompt.value.trim().split(String.fromCharCode(10))[0]) : p ? ($('.plate-t', p) || {}).textContent || '' : '';
    if (isLaunch) { store('yc.launchProject', f.elements.project.value); launchDlg.close(); }
    // An answer names its picks, so a Retry says what it sends again: "Send your answer (Monday) again" (hill climb 2 r11, Opus).
    var what = kind === 'call' || kind === 'answer' ? 'your answer (' + pickNames(f) + ')' : (btn.dataset.what || kind);
    // A ticket with more than one question to answer stays at the pass until the last one is answered.
    var fromPass = !!(p && p.hasAttribute('data-at')) && !(kind === 'answer' && $$('form.act', p).length > 1);
    f.dataset.busy = '1'; lock(f, true); say(f, '', '');
    // A launch saved on the way out keeps the fields it was queued with, so its id never goes with other ones.
    if (f.classList.contains('launch')) f._sent = lsnap(f);
    // Only the open ticket moves you on: a note the action bar sends to another thread leaves you where you are.
    if (fromPass) { acted[id] = Date.now(); actedLatest[id] = p.dataset.latest || ''; hideActed(); if (mounted && mounted.id === id) advance(id); } else if (sheet.open && kind !== 'reply') { /* stays open until it lands */ }
    // The toast names the action, then the ticket (hill climb r2, Fable).
    // One sentence per action, naming the ticket: "Holding “X” until 8:00 tomorrow" (hill climb r3, Opus).
    var shortT = title ? '“' + title.slice(0, 60) + (title.length > 60 ? '…' : '') + '”' : 'this ticket';
    // Result toasts name the ticket too, since the next ticket is already open (hill climb 2 r3, Opus).
    f.dataset.named = title ? '“' + title.slice(0, 32) + (title.length > 32 ? '…' : '') + '”' : '';
    // The Undo toast names the pick without its "(Recommended)" tag, as the Retry does (r14, Opus).
    var pk = pickNames(f);
    var tpl = kind === 'launch' ? 'Launching {t}' : (btn.dataset.toast || 'Sending {t}');
    var verb = tpl.replace('{p}', pk ? ' (' + pk + ')' : '').replace('{t}', shortT);
    var entry = { label: verb, title: shortT, until: Date.now() + 4000, done: false };
    var drop = function(){ var i = pendingSends.indexOf(entry); if (i >= 0) pendingSends.splice(i, 1); };
    entry.fire = function(leaving){
      if (entry.done) return; entry.done = true; clearTimeout(entry.timer); drop();
      // Every send saves its one-time id with the draft, so a resend after a reload is the same request to T3, never a
      // second message (hill climb 2 r3, Astra). A confirmed send clears the draft; a refused one drops the id.
      saveDraft(f, true, btn.value);
      if (!leaving && !showUndo()) toast('Sending ' + what + (f.dataset.named ? ' for ' + f.dataset.named : '') + '…', [], 0);
      fly(body, leaving).then(function(r){ landed(f, id, body, what, r[0], r[1]); }, function(){ landed(f, id, body, what, 0, 'Not confirmed: no answer from the Pass. Safe to repeat.'); });
    };
    entry.undo = function(){
      if (entry.done) return; entry.done = true; clearTimeout(entry.timer); drop();
      delete acted[id]; hideActed(); delete f.dataset.busy; lock(f, false);
      if (isLaunch) openLaunch(); else select(id);
      // Say it as what Dan did, not as a failure (Astra r5).
      if (!showUndo()) toast('Undone: ' + entry.title + '.', [], 2500);
    };
    entry.timer = setTimeout(function(){ entry.fire(false); }, 4000);
    pendingSends.push(entry);
    showUndo();
  }
  function landed(f, id, body, what, status, text){
    // A ticket with two question forms has one record: only the form that holds it settles it (hill climb 2 r9, Opus).
    var mine = !!unconfirmed[id] && unconfirmed[id].form === f;
    if (status === 200) {
      delete f.dataset.busy;
      // A mark restored after a reload has no record in memory, so it goes unless another form holds the record.
      if (mine || !unconfirmed[id]) $$('.tile[data-plate="' + id + '"] .nc').forEach(function(m){ m.remove(); });
      if (mine) {
        settledUnconfirmed(id);
        // A confirmed Retry leaves the pass the way a first send does (hill climb 2 r5, Opus).
        var pn = plateNode(id), rk = new URLSearchParams(body).get('kind');
        if (pn && pn.hasAttribute('data-at') && !acted[id] && !(rk === 'answer' && $$('form.act', pn).length > 1)) {
          acted[id] = Date.now(); actedLatest[id] = pn.dataset.latest || ''; hideActed();
          if (mounted && mounted.id === id) advance(id);
        }
      }
      // The form is free again and holds no draft, so the next refresh can replace the ticket.
      lock(f, false); delete f.dataset.touched; setIntent(f, null); noting(f, false); clearDraft(f);
      if (f.elements.note && f.elements.note.tagName === 'TEXTAREA') { f.elements.note.value = ''; grow(f.elements.note); }
      if (id === 'launch') { f.elements.prompt.value = ''; f.elements.title.value = ''; delete f.dataset.lost; }
      if (f.elements.nonce) f.elements.nonce.value = uuid();
      delete f.dataset.sentSig; delete f.dataset.sentKind;
      if (!pendingSends.length) toast(named(f, text), [], 3500);
      say(f, text, 'ok');
      // A note that reached its thread makes that thread the action bar's "your last note went here" suggestion.
      if (id !== 'launch' && bar && (new URLSearchParams(body).get('note') || '').trim()) bar.noted(id);
      if (!acted[id] && sheet.open && mounted && mounted.id === id) { sheet.close(); }
      wake();
      return;
    }
    // 503 is the Pass refusing before it acts (the board is not checked), so it is a refusal too (hill climb 2 r7, Fable).
    if ((status >= 400 && status < 500) || status === 503) {
      delete acted[id]; hideActed();
      // A Retry the Pass refused with 503 still owns the form: it stays locked, so a changed note never sits beside a
      // Retry that would send the old one and then clear it (hill climb 2 r10, Opus and Astra).
      var hold = status === 503 && mine;
      if (!hold) { delete f.dataset.busy; lock(f, false); }
      // A refused repeat of a send that may have reached T3 says nothing about that first send, unless the Pass says
      // it landed. So it keeps its one-time id, and the same send again is the same request (hill climb 2 r9, Sol).
      var again = mine || !!f.dataset.sentSig, first = status === 409 && /^(Already answered|That retry changed the answer)/.test(text);
      if (again && !first) {
        if (!f.dataset.sentSig) { f.dataset.sentSig = sig(f); f.dataset.sentKind = kindOf(body); }
        // A 503 is the Pass not checking the board yet, so Retry stays. Any other refusal means the board moved and
        // a Retry cannot go, so its box goes and the card says to check.
        if (hold) { unconfirmed[id].refused = text; decorate(id); }
        else if (mine || !unconfirmed[id]) { if (mine) settledUnconfirmed(id); $$('.tile[data-plate="' + id + '"] .nc').forEach(function(m){ m.innerHTML = '<i></i>Not confirmed. Open it to check.'; }); }
        saveDraft(f);
        var more = text + ' The first send is still not confirmed: sending it unchanged is the same request.';
        // The Retry box says it once for a held form; the form's own line stays empty (hill climb 2 r10, Opus).
        say(f, hold && id !== 'launch' ? '' : more, hold && id !== 'launch' ? '' : 'bad');
        if (id === 'launch') { openLaunch(); say(f, more, 'bad'); }
        var keep = mine && unconfirmed[id]; toast(named(f, text), (keep ? [['Retry', function(){ retry(id); }, 'ticket.suggested']] : []).concat([['Open', function(){ if (id === 'launch') openLaunch(); else select(id); }]]), keep ? 0 : 8000, true, keep ? id : null);
        return;
      }
      // A refused Retry that the Pass says landed ends the not-confirmed state (a 409 "Already answered"), so its
      // Retry box and list mark go (hill climb 2 r8, Fable).
      if (mine || !unconfirmed[id]) { if (mine) settledUnconfirmed(id); $$('.tile[data-plate="' + id + '"] .nc').forEach(function(m){ m.remove(); }); }
      // Refused, so nothing reached T3: the next send is a new one, and the saved draft keeps no old id.
      freshNonce(f); saveDraft(f);
      say(f, text, 'bad');
      if (id === 'launch') { openLaunch(); say(f, text, 'bad'); }
      toast(named(f, text), [['Open', function(){ if (id === 'launch') openLaunch(); else select(id); }]], 8000, true);
      return;
    }
    // Not confirmed: T3 may have taken it. Retry repeats the same bytes, so T3 keeps one. The ticket comes back to
    // the list and carries its own Retry, so a later toast never strands the send (PR-Agent r1 on #27).
    delete acted[id]; hideActed();
    // Another form on the ticket that held the record keeps its own id: it is freed, says it is not confirmed, and
    // sent unchanged it is the same request (hill climb 2 r9, Opus).
    var prev = unconfirmed[id];
    if (prev && prev.form !== f) {
      var pf = prev.form; pf.classList.remove('held');
      if (!pf.dataset.sentSig) { pf.dataset.sentSig = sig(pf); pf.dataset.sentKind = kindOf(prev.body); }
      // A form whose Retry is still on its way stays locked until that Retry lands, so an edit made meanwhile is never
      // cleared by its answer (PR-Agent r3 on #38).
      if (!prev.flying) {
        delete pf.dataset.busy; lock(pf, false);
        // One full line per ticket: the box says it; the freed form says only what a resend is (hill climb 2 r11, Fable).
        saveDraft(pf); say(pf, 'Not confirmed. Sending it unchanged is the same request.', 'bad');
      }
    }
    unconfirmed[id] = { body: body, what: what, text: text, form: f };
    decorate(id);
    say(f, id === 'launch' ? text : '', id === 'launch' ? 'bad' : '');
    toast(named(f, text), [['Retry', function(){ retry(id); }, 'ticket.suggested'], ['Open', function(){ if (id === 'launch') openLaunch(); else select(id); }]], 0, true, id);
  }
  function settledUnconfirmed(id){
    if (unconfirmed[id] && unconfirmed[id].form) unconfirmed[id].form.classList.remove('held');
    delete unconfirmed[id]; var rb =document.querySelector('#' + CSS.escape(id) + ' .retry'); if (rb) rb.remove();
    if (id === 'launch') { var lb = $('#launch button[value=launch] .bl'); if (lb) lb.textContent = 'Launch'; }
    yieldKey();
  }
  function retry(id){
    var u = unconfirmed[id]; if (!u || u.flying) return; u.flying = true;
    toast('Sending ' + u.what + (u.form.dataset.named ? ' for ' + u.form.dataset.named : '') + ' again…', [], 0);
    fly(u.body).then(function(r){ u.flying = false; landed(u.form, id, u.body, u.what, r[0], r[1]); }, function(){ u.flying = false; landed(u.form, id, u.body, u.what, 0, 'Not confirmed: no answer from the Pass. Safe to repeat.'); });
  }
  function decorate(id){
    var p = plateNode(id), u = unconfirmed[id]; if (!p || !u) return;
    // New thread has its own button for it: Launch again, with ⌘↵, in the dialog (hill climb 2 r9, Opus and Fable).
    // Cancel stays live beside it, so the dialog closes by click as well as Esc (hill climb 2 r10, Opus and Fable).
    if (id === 'launch') { var lb = $('button[value=launch]', p), cb = $('[data-launch-cancel]', p); if (lb) { lb.disabled = false; lb.dataset.was = ''; $('.bl', lb).textContent = 'Launch again'; } if (cb) { cb.disabled = false; cb.dataset.was = ''; } return; }
    // The held form's own buttons cannot send while the box can, so they step aside: one blue action (hill climb 2 r10).
    if (u.form && u.form !== p) u.form.classList.add('held');
    var d = $('.dock', p) || p, box = $('.retry', p);
    if (!box) { box = document.createElement('div'); box.className = 'retry'; d.insertBefore(box, d.firstChild); }
    // The box takes the place of the buttons of the form it sends again, under that form's question or note, so you read
    // what it sends first, and it never sits by another form (hill climb 2 r11, Opus and Sol).
    var at = u.form && u.form !== p && p.contains(u.form) ? u.form : null;
    if (at && at.nextSibling !== box) at.parentNode.insertBefore(box, at.nextSibling);
    box.textContent = '';
    var msg = document.createElement('p'); msg.className = 'result bad'; msg.textContent = u.refused ? u.refused + ' The first send is still not confirmed: send the same again, or check the thread in T3.' : u.text + ' Check the thread in T3, or send the same again.';
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn fill'; b.setAttribute('data-retry', ''); b.textContent = 'Send ' + u.what + ' again';
    var kb = document.createElement('kbd'); kb.dataset.cmd = 'ticket.suggested'; kb.textContent = SK(); b.appendChild(kb);
    box.appendChild(msg); box.appendChild(b); yieldKey();
    // Its list card says so too: a red dot, words in the label colour (hill climb 2 r3, Opus).
    $$('.tile[data-plate="' + id + '"]').forEach(function(t){
      if ($('.nc', t)) return;
      // Its own line at the card's foot, so the top row keeps the project's name whole.
      var m = document.createElement('span'); m.className = 'th nc'; m.innerHTML = '<i></i>Not confirmed. Open it to retry.';
      t.appendChild(m);
    });
  }
  function wake(){ var q = location.search; return fetch('/app' + q, { cache: 'no-store' }).then(function(r){ return r.ok ? r.text() : null; }).then(function(h){ if (h && q === location.search) { sync(h); Object.keys(unconfirmed).forEach(decorate); markSent(); } }, function(){}); }
  // Reload and a project switch refresh the board in place (council 3): the page never unloads, so a send waiting
  // out its Undo keeps its four seconds and a half-written note stays.
  window.__ycSoftReload = function(){ wake(); };
  // ----- The projects the board shows (Dan, 2026-11-10, view menu mock a) -----
  // A tick flips at once and the menu stays open. The chip follows at once, and the board when the menu closes (sync
  // waits while a menu is open). All projects ticks every box. The last ticked box stays ticked and shakes: no project
  // at all is not a view. The address repeats p, ?p=A&p=B; no p is All projects.
  function pickProject(pk){
    var nav = pk.closest('.pmenu-l'), boxes = $$('.pk[data-p]', nav), all = $('.pk.all', nav), names = null;
    function on(b){ return b.getAttribute('aria-checked') === 'true'; }
    if (pk === all) { if (on(all)) return; }
    else {
      // The last ticked box stays ticked and shakes once; the class goes when the shake ends, so reopening the menu
      // does not shake it again.
      if (on(pk) && boxes.filter(on).length === 1) {
        pk.classList.remove('no'); void pk.offsetWidth; pk.classList.add('no');
        pk.addEventListener('animationend', function(){ pk.classList.remove('no'); }, { once: true });
        return;
      }
      var ticked = boxes.filter(function(b){ return b === pk ? !on(b) : on(b); });
      names = ticked.map(function(b){ return b.dataset.p; });
      // Every project on the board, and no pick that has no ticket now (data-gone), is All projects, as the server
      // reads it; unless T3 did not answer: then the list is not the whole of it.
      var gone = function(b){ return b.hasAttribute('data-gone'); };
      if (!nav.hasAttribute('data-nc') && !ticked.some(gone) && ticked.length === boxes.filter(function(b){ return !gone(b); }).length) names = null;
    }
    drawPicked(names);
    var q = names ? '?' + names.map(function(n){ return 'p=' + encodeURIComponent(n); }).join('&') : '';
    if (q === location.search) return;
    history.pushState(null, '', location.pathname + q); state.sel = null; wake();
  }
  // Both copies of the menu (the rail's, and the top bar's on a phone) show the same picks. names: null is All projects.
  function drawPicked(names){
    drawn = {};
    $$('details.vmenu').forEach(function(d){
      var boxes = $$('.pk[data-p]', d), all = $('.pk.all', d), sel = [];
      // All projects is every project on the board: a pick with no ticket now (data-gone) is not one of them.
      boxes.forEach(function(b){ var y = names ? names.indexOf(b.dataset.p) >= 0 : !b.hasAttribute('data-gone'); b.setAttribute('aria-checked', String(y)); if (y) sel.push(b); });
      if (all) all.setAttribute('aria-checked', names ? 'mixed' : 'true');
      var cur = $('summary .vp, summary .fan', d), nw = document.createElement('span');
      if (!names) { nw.className = 'vp'; nw.textContent = 'All projects'; }
      else {
        var list = sel.map(function(b){ return b.dataset.p; }).join(', '), vh = document.createElement('span');
        nw.className = 'fan'; nw.style.setProperty('--n', sel.length); nw.title = list;
        sel.forEach(function(b, i){
          var c = document.createElement('span'), m = $('.pm', b); c.className = 'card'; c.style.setProperty('--i', i);
          if (m) { m = m.cloneNode(true); m.removeAttribute('title'); c.appendChild(m); }
          nw.appendChild(c);
        });
        vh.className = 'vh'; vh.textContent = list; nw.appendChild(vh);
      }
      if (cur) cur.replaceWith(nw);
    });
  }
  // The picks in the address, as pickedFrom reads them (client/board.mjs): repeats and empty names drop out; null is
  // All projects. An array, not an object: a project may be called "__proto__".
  function pickedNow(){
    var out = [];
    new URLSearchParams(location.search).getAll('p').forEach(function(n){ if (n && out.indexOf(n) < 0) out.push(n); });
    return out.length ? out : null;
  }
  // Picks that cover every project on the board are All projects: the address drops them, so a project that turns up
  // later shows too, and All projects stays a way out of a filter (PR-Agent r2 on #10).
  function normalizePicked(){
    var a = $('.vmenu .pk.all'); if (!a || a.getAttribute('aria-checked') !== 'true') return;
    var u = new URLSearchParams(location.search); if (!u.has('p')) return;
    u.delete('p'); var q = u.toString();
    history.replaceState(history.state, '', location.pathname + (q ? '?' + q : ''));
  }
  // Back and Forward: the boxes and the chip follow the address at once, even while the board waits for the menu to
  // close, so the next tick starts from the right picks (PR-Agent r2 on #10). A pick the menu has no box for closes
  // the menu instead, and the refresh draws it.
  window.addEventListener('popstate', function(){
    var names = pickedNow(), have = $$('.vmenu .pk[data-p]').map(function(b){ return b.dataset.p; });
    if (!names || names.every(function(n){ return have.indexOf(n) >= 0; })) drawPicked(names);
    else { var om = $('details.vmenu[open]'); if (om) om.open = false; }
    state.sel = null; wake();
  });
  document.addEventListener('submit', function(ev){
    var f = ev.target; if (!f.matches || !f.matches('form.act')) return;
    ev.preventDefault();
    var b = ev.submitter && ev.submitter.name === 'kind' ? ev.submitter : $('button.primary', f);
    if (b) send(f, b);
  });
  // A half-written note or a pick is saved on this Mac per ticket, so a reload or a restart keeps it (council 3).
  // (No backslashes in this script: it sits in a template string.)
  var CUSTOM = '~custom~';
  // A draft is keyed by what its form answers: a T3 question form by its request, any other form by its place among
  // the forms that are not questions. So an answered question going away never moves another form's draft onto the
  // wrong form or loses it (hill climb 2 r10, Sol).
  function draftKey(f){
    var p = f.dataset.plate && plateNode(f.dataset.plate); if (!p) return null;
    var rq = f.elements.request && f.elements.request.value;
    if (rq) return 'yc.draft.' + p.id + '.q.' + rq;
    return 'yc.draft.' + p.id + '.f.' + $$('form.act', p).filter(function(x){ return !(x.elements.request && x.elements.request.value); }).indexOf(f);
  }
  // A draft saved before by the form's place on the ticket.
  function oldDraftKey(f){ var p = f.dataset.plate && plateNode(f.dataset.plate); return p ? 'yc.draft.' + p.id + '.' + $$('form.act', p).indexOf(f) : null; }
  function forget(k){ try { window.localStorage.removeItem(k); } catch (x) {} }
  // What the form holds now: the note and the picks.
  function snap(f){
    var d = { note: '', picks: {}, custom: {}, intent: f.dataset.intent || '' };
    if (f.elements.note && f.elements.note.tagName === 'TEXTAREA') d.note = f.elements.note.value;
    $$('fieldset.q-set:not([disabled]) input[type=radio]:checked', f).forEach(function(r){
      var own = r.hasAttribute('data-custom'); d.picks[r.name] = own ? CUSTOM : r.value; if (own) d.custom[r.name] = $('.custom', r.parentNode).value;
    });
    return d;
  }
  // The signature is what the send carries. The armed Reply or Request changes is not in it: the kind is checked on its own
  // at send, so Esc and re-arming keep the send id (hill climb 2 r7, Astra).
  function sig(f){ if (f.classList.contains('launch')) return JSON.stringify(lsnap(f)); var d = snap(f); delete d.intent; return JSON.stringify(d); }
  // A draft saved before that change carries a signature with the intent in it.
  function sameSig(f, s, kind){ return !!s && (s === sig(f) || s === JSON.stringify(snap(f)) || carried(sig(f), kind) === carried(s, kind)); }
  // What a send carries: an answer carries its picks and note, a launch its fields, and Reply, Request changes, Merge, Hold and
  // Settle only the note. So a pick made after a Reply, or one a refused answer made, keeps that Reply's one-time id
  // (hill climb 2 r9, Astra).
  var NOTE_ONLY = ['reply', 'refire', 'go', 'hold', 'settle'];
  function carried(s, kind){ if (NOTE_ONLY.indexOf(String(kind || '').split(':')[0]) < 0) return s; try { return JSON.stringify({ note: JSON.parse(s).note || '' }); } catch (e) { return s; } }
  function sameSent(f){ return carried(sig(f), f.dataset.sentKind) === carried(f.dataset.sentSig, f.dataset.sentKind); }
  // Merge and Approve are one form value, "go", told apart by "pr" (open or none), and they are different sends. A
  // restored Approve pressed again once the button says Merge is a new send with a new id, as any change of kind is:
  // the same id could make T3 drop the Merge as a repeat (PR-Agent r2 on #69). A record from before says only "go"
  // and matches either, as it did.
  function sendKind(f, kind){ return kind === 'go' && f.elements.pr ? 'go:' + f.elements.pr.value : kind; }
  function kindOf(body){ var p = new URLSearchParams(body), k = p.get('kind') || ''; return k === 'go' && p.get('pr') ? 'go:' + p.get('pr') : k; }
  function sameKind(a, b){ a = String(a || ''); b = String(b || ''); return a === b || (a === 'go' && b.indexOf('go:') === 0) || (b === 'go' && a.indexOf('go:') === 0); }
  // A send that may have reached T3, known from its saved id, marks its list cards. A refresh redraws the lists, so
  // every refresh marks them again (hill climb 2 r9, Opus and Astra). One held in memory has its own mark.
  function markSent(only){
    (only ? [only] : $$('form.act')).forEach(function(f){
      var pid = f.dataset.plate; if (!f.dataset.sentSig || !pid || unconfirmed[pid]) return;
      $$('.tile[data-plate="' + pid + '"]').forEach(function(t){ if ($('.nc', t)) return; var m = document.createElement('span'); m.className = 'th nc'; m.innerHTML = '<i></i>Not confirmed. Open it to check.'; t.appendChild(m); });
    });
  }
  function freshNonce(f){
    if (f.elements.nonce) f.elements.nonce.value = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
    delete f.dataset.sentSig; delete f.dataset.sentKind;
    // A changed restored send is a new one, so the card's restored mark goes (one in memory stays until it settles).
    var pid = f.dataset.plate; if (pid && !unconfirmed[pid]) $$('.tile[data-plate="' + pid + '"] .nc').forEach(function(m){ m.remove(); });
  }
  // A send fired as the page closed is saved with its one-time id and kind. Sent again unchanged from the restored
  // draft, it is the same send to the server and T3, never a second one (PR-Agent r1 on #38). Once its note, picks
  // or kind change, it is a new send with a new id (PR-Agent r2 on #38).
  // The new-thread form keeps its draft, and after a send its one-time id, across a reload (hill climb 2 r5, Sol).
  var LKEY = 'yc.launchDraft';
  // A draft keeps the project it was written for until you pick another, so a reload never fills in a different one.
  function lsnap(f){ var w = $('input[name=workspace]:checked', f); return { prompt: f.elements.prompt.value, title: f.elements.title.value, project: f.elements.project.value || f.dataset.lost || '', workspace: w ? w.value : '' }; }
  function saveLaunch(f, leaving){
    var q = leaving && f._sent, d = q ? JSON.parse(JSON.stringify(q)) : lsnap(f), s = q ? JSON.stringify(q) : sig(f);
    if (!leaving && f.dataset.sentSig && s !== f.dataset.sentSig) freshNonce(f);
    if (leaving) { d.nonce = f.elements.nonce.value; d.sig = s; f.dataset.sentSig = s; f.dataset.sentKind = 'launch'; }
    else if (f.dataset.sentSig) { d.nonce = f.elements.nonce.value; d.sig = f.dataset.sentSig; }
    d.at = Date.now();
    if (!d.prompt.trim() && !d.title.trim() && !d.nonce) { forget(LKEY); return; }
    store(LKEY, JSON.stringify(d));
  }
  function restoreLaunch(f){
    if (f.elements.prompt.value || f.elements.title.value) return;
    var d = null; try { d = JSON.parse(store(LKEY) || 'null'); } catch (x) { d = null; }
    if (!d) return;
    if (Date.now() - d.at > 30 * 864e5) { forget(LKEY); return; }
    f.elements.prompt.value = d.prompt || ''; f.elements.title.value = d.title || '';
    if (d.project && $$('option', f.elements.project).some(function(o){ return o.value === d.project; })) { f.elements.project.value = d.project; delete f.dataset.lost; }
    else if (d.project) { f.elements.project.selectedIndex = -1; f.dataset.lost = d.project; }
    var w = d.workspace && $('input[name=workspace][value="' + d.workspace + '"]', f); if (w) w.checked = true;
    if (d.nonce && sig(f) === d.sig) { f.elements.nonce.value = d.nonce; f.dataset.sentSig = d.sig; f.dataset.sentKind = 'launch'; }
  }
  function saveDraft(f, leaving, kind){
    if (f.classList.contains('launch')) { if (!f.dataset.busy || leaving) saveLaunch(f, leaving); return; }
    var k = draftKey(f); if (!k || (f.dataset.busy && !leaving)) return;
    if (!leaving && f.dataset.sentSig && !sameSent(f)) freshNonce(f);
    var d = snap(f);
    d.latest = plateNode(f.dataset.plate).dataset.latest || ''; d.at = Date.now();
    if (leaving) { d.nonce = f.elements.nonce ? f.elements.nonce.value : ''; d.kind = kind ? sendKind(f, kind) : ''; d.sig = sig(f); }
    else if (f.dataset.sentSig) { d.nonce = f.elements.nonce.value; d.kind = f.dataset.sentKind || ''; d.sig = f.dataset.sentSig; }
    // An unchanged note sent before the agent's latest message keeps saying so after another reload.
    if (stale(f)) d.sentBefore = true;
    // An unchanged note written before the agent's latest message keeps saying so after another reload (PR-Agent r4 on #38).
    else if (f.dataset.before !== undefined && f.dataset.before === d.note) d.wroteBefore = true;
    // A send with no note still keeps its record, so a resend after a reload is the same request (hill climb 2 r4, Astra).
    // An armed Reply or Request changes with no note yet stays armed after a reload (PR-Agent r3 on #38).
    if (!d.note.trim() && !Object.keys(d.picks).length && !d.intent && !(d.nonce && d.sig)) { forget(k); return; }
    store(k, JSON.stringify(d));
  }
  function clearDraft(f){ if (f.classList.contains('launch')) { forget(LKEY); return; } var k = draftKey(f); if (k) forget(k); }
  function restoreDrafts(scope){
    $$('form.act[data-plate]', scope).forEach(function(f){
      if (f.dataset.restored || f.dataset.busy) return; f.dataset.restored = '1';
      var k = draftKey(f), raw = k && store(k), d = null;
      if (k && !raw) { var ok = oldDraftKey(f), old = ok && store(ok); if (old) { raw = old; store(k, old); forget(ok); } }
      try { d = raw && JSON.parse(raw); } catch (x) { d = null; }
      if (!d) return;
      // A note survives a new message from the agent. Its picks, armed action and send id belonged to the earlier
      // message, so they go: an old id on a new send could make T3 drop it as a repeat, and an old pick could answer a
      // new question (hill climb 2 r7, Opus and Sol). If that note was already sent, the ticket says it may have
      // reached the agent (hill climb 2 r6, Opus). A draft untouched for 30 days is dropped.
      if (Date.now() - d.at > 30 * 864e5) { forget(k); return; }
      var now = plateNode(f.dataset.plate).dataset.latest || '', earlier = now !== d.latest, went = !!(d.nonce && d.sig);
      if (earlier) {
        if (!d.note || !d.note.trim()) { forget(k); return; }
        d = { note: d.note, picks: {}, custom: {}, intent: '', latest: now, at: d.at, sentBefore: went || !!d.sentBefore, wroteBefore: !(went || d.sentBefore) };
        store(k, JSON.stringify(d));
      }
      if (d.note && f.elements.note && f.elements.note.tagName === 'TEXTAREA') { f.elements.note.value = d.note; f.classList.add('noting'); grow(f.elements.note); }
      Object.keys(d.picks || {}).forEach(function(name){
        var v = d.picks[name], r = $$('fieldset.q-set:not([disabled]) input[type=radio]', f).filter(function(x){ return x.name === name && (v === CUSTOM ? x.hasAttribute('data-custom') : x.value === v); })[0];
        if (r) { r.checked = true; if (v === CUSTOM) $('.custom', r.parentNode).value = (d.custom || {})[name] || ''; }
      });
      if (d.intent && $('button[value="' + d.intent + '"]', f)) { f._restoring = true; setIntent(f, d.intent); f._restoring = false; }
      if (d.nonce && f.elements.nonce && sameSig(f, d.sig, d.kind)) { f.elements.nonce.value = d.nonce; f.dataset.sentSig = sig(f); f.dataset.sentKind = d.kind || ''; }
      f.dataset.touched = '1'; primaryLabel(f); noteKey(f);
      if (qSets(f).length > 1) qShow(f, qAt(f));
      // The not-confirmed state is in memory only, so after a reload the draft says it (hill climb 2 r6, Fable).
      // One colour for "Not confirmed", in session and after a reload (hill climb 2 r7, Opus).
      // Its list card keeps the mark too, as it does before the reload (hill climb 2 r8, Opus).
      markSent(f);
      if (d.sentBefore && !f.dataset.sentSig) f.dataset.stale = d.note || ''; else delete f.dataset.stale;
      noteKey(f);
      if (f.dataset.sentSig) say(f, 'Not confirmed: this may already have reached the agent. Check the thread in T3; sending it unchanged is the same request.', 'bad');
      else if (d.sentBefore) say(f, 'You sent this note before the agent’s latest message, so it may have reached the agent. Check the thread in T3 before you send it again.', 'bad');
      else if (earlier || d.wroteBefore) say(f, 'You wrote this note before the agent’s latest message. Check it still fits.', '');
      if (!d.sentBefore && (earlier || d.wroteBefore)) f.dataset.before = d.note || ''; else delete f.dataset.before;
    });
  }
  // Notes grow with what you write instead of showing a resize grip (council 3).
  function grow(t){ if (!t || t.tagName !== 'TEXTAREA') return; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 260) + 'px'; }
  document.addEventListener('input', function(ev){ var f = ev.target.closest && ev.target.closest('form.act'); if (ev.target.tagName === 'TEXTAREA') grow(ev.target); if (f) { f.dataset.touched = '1'; if (ev.target.matches && ev.target.matches('.custom')) primaryLabel(f); saveDraft(f); if (ev.target.name === 'note') noteKey(f); } });
  document.addEventListener('change', function(ev){
    var f = ev.target.closest && ev.target.closest('form.act'); if (!f) return;
    if (ev.target.name === 'project') delete f.dataset.lost;
    f.dataset.touched = '1'; say(f, '', ''); saveDraft(f);
    var fs = ev.target.closest('fieldset.q-set'), pl = f.closest('.plate'); if (fs && pl) pl._lastSet = fs;
    // A pick on a card brings the next unanswered one forward, a beat later so you see your pick land.
    // Your own answer stays in front: you still have to write it (PR-Agent r1 on #50).
    if (fs && ev.target.type === 'radio' && qSets(f).length > 1) { qShow(f, qSets(f).indexOf(fs)); if (!ev.target.hasAttribute('data-custom')) setTimeout(function(){ if (fs.classList.contains('q-on')) qNext(f); }, 180); }
    // The blue button names the answer you picked, on an agent's call and on a T3 question alike (Astra).
    if ($('button.primary[value=call], button.primary[value=answer]', f)) primaryLabel(f);
    yieldKey();
  });

  // ----- Screenshots in the app's own viewer -----
  var shotsList = [], shotAt = 0;
  function showShot(i){
    shotAt = (i + shotsList.length) % shotsList.length; var a = shotsList[shotAt];
    var img = $('img', viewer); img.src = a.getAttribute('href'); img.alt = ($('img', a) || {}).alt || '';
    $('.v-cap', viewer).textContent = (($('.att-cap', a) || {}).textContent || '') +(shotsList.length > 1 ? '  ·  ' + (shotAt + 1) + ' of ' + shotsList.length : '');
    $$('[data-v=prev], [data-v=next], .v-arrows', viewer).forEach(function(b){ b.hidden = shotsList.length < 2; });
  }
  viewer.addEventListener('click', function(ev){
    var v = ev.target.closest('[data-v]');
    if (v) { if (v.dataset.v === 'close') viewer.close(); else showShot(shotAt + (v.dataset.v === 'next' ? 1 : -1)); return; }
    if (ev.target === viewer || ev.target.tagName === 'IMG') viewer.close();
  });

  // ----- Clicks and keys -----
  document.addEventListener('click', function(ev){
    var t = ev.target;
    var m = $('details.pmenu[open]'); if (m && !m.contains(t)) m.open = false;
    if (t.closest('[data-view-toggle]')) { toggleView(); return; }
    // The view menu: a project's check box, All projects, and the You | Team toggle all keep the menu open.
    var pk = t.closest('.vmenu .pk');
    if (pk) { pickProject(pk); return; }
    var sc = t.closest('.vmenu .seg [data-scope]');
    if (sc) { setScope(sc.dataset.scope); return; }
    var nf = t.closest('.nf[data-folder]');
    // In You, expanded, a stage row opens that stage's list in the pass view, with no ticket open.
    if (nf && !focusView()) { state.passFolder = nf.dataset.folder; state.passSel = null; toggleView(); return; }
    if (nf) { setFolder(nf.dataset.folder); if (focusView() && wide()) { state.sel = null; place(); } return; }
    var shot = t.closest('a[data-shot]');
    if (shot) { ev.preventDefault(); var box = shot.closest('.plate') || document; shotsList = $$('a[data-shot]', box); showShot(shotsList.indexOf(shot)); if (!viewer.open) viewer.showModal(); yieldKey(); return; }
    var to = t.closest('[data-team-open]');
    if (to) { var ta = t.closest('[data-team-act]'); openTeamCall(to.dataset.teamOpen, ta ? ta.dataset.teamAct : null); return; }
    var tl = t.closest('[data-plate]:not(form)');
    if (tl && !t.closest('.plate')) { state.listKey = listKeyOf(tl); select(tl.dataset.plate); return; }
    var rt = t.closest('[data-retry]'); if (rt) { var pl = rt.closest('.plate'); if (pl) retry(pl.id); return; }
    if (t.closest('[data-settings]')) { openSettings(); return; }
    var an = t.closest('[data-addnote]'); if (an) { shut(an); noting(an.closest('form.act'), true); return; }
    // More's rows: Open in T3 follows the ticket's link, as O does. On a phone, Hold and Settle press the bar's own
    // buttons, so every check in send() still runs.
    var ot = t.closest('[data-open-t3]'); if (ot) { shut(ot); var op = ot.closest('.plate'), ol = op && $('.plate-bar a[href]', op); if (ol) ol.click(); return; }
    var pr = t.closest('[data-press]'); if (pr) { shut(pr); var pf = pr.closest('form.act'), pb = pf && $('button[name=kind][value="' + pr.dataset.press + '"]', pf); if (pb && !pb.disabled) send(pf, pb); return; }
    if (t.closest('[data-close]')) { sheet.close(); return; }
    if (t === sheet) sheet.close();
  });
  sheet.addEventListener('close', function(){ var id = state.sel; if (!(focusView() && wide())) { unmount(); state.sel = null; mark(); } var back = id && $('[data-plate="' + id + '"]:not(form)'); if (back) back.focus({ preventScroll: true }); });
  // The page's keys, as each command's default key reads (client/keys.mjs). The router below sends every key here.
  function onKey(ev){
    // Esc closes the menu and puts focus back on its chip, so the keys go on from there.
    var m = $('details.pmenu[open]'); if (m && ev.key === 'Escape') { var back = m.contains(document.activeElement) && $('summary', m); m.open = false; if (back) back.focus(); return; }
    // More, while open: Esc or . closes it, the arrows move between its rows, and Enter or Space presses the row in
    // focus. Any other key closes it, then does what it always does (N adds a note, O opens T3, Cmd+Enter sends).
    var om = openMenu();
    if (om) {
      if (ev.key === 'Escape' || ev.key === '.') { ev.preventDefault(); shut(om); return; }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); menuStep(om, ev.key === 'ArrowDown' ? 1 : -1); return; }
      if (/^(Shift|Meta|Control|Alt|Tab)$/.test(ev.key) || ((ev.key === 'Enter' || ev.key === ' ') && om.contains(document.activeElement) && !(ev.metaKey || ev.ctrlKey))) return;
      shut(om);
    }
    if (viewer.open) { if (ev.key === 'ArrowRight') showShot(shotAt + 1); else if (ev.key === 'ArrowLeft') showShot(shotAt - 1); return; }
    // Dan, 2026-11-10: Cmd+K opens and closes the action bar; Cmd+T and Cmd+N open New thread; Cmd+, opens Settings.
    // Each closes whichever of the three is open first, so only one is ever up.
    var cmd = (ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey, ck = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if (cmd && ck === ',') { ev.preventDefault(); if (bar) bar.close(); if (launchDlg.open) launchDlg.close(); openSettings('layout'); return; }
    if (cmd && ck === 'k' && bar) { ev.preventDefault(); if (ev.repeat) return; if (setDlg.open) setDlg.close(); if (launchDlg.open) launchDlg.close(); bar.toggle(); return; }
    if (cmd && (ck === 't' || ck === 'n')) { ev.preventDefault(); if (bar) bar.close(); if (setDlg.open) setDlg.close(); openLaunch(); return; }
    // Option-Shift-Cmd-A: the next Appearance, as T3 Code's appearance.cycle. Option changes ev.key, so read the code.
    if ((ev.metaKey || ev.ctrlKey) && ev.altKey && ev.shiftKey && ev.code === 'KeyA') { ev.preventDefault(); if (!ev.repeat) cycleTheme(); return; }
    if (bar && bar.isOpen()) return;
    if (setDlg.open) return;
    // The launch dialog: Cmd+Enter launches; every other key is typing.
    if (launchDlg.open) {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && !ev.repeat) { ev.preventDefault(); var lf = $('form.launch', launchDlg); send(lf, $('button.primary', lf)); }
      return;
    }
    var typing = ev.target.closest && ev.target.closest('textarea, input[type=text]');
    // The form you are in, else the one you last picked in, else the open ticket's first free one (keyForm).
    var here = ev.target.closest && ev.target.closest('form.act');
    var form = keyForm(here);
    // Cmd+Enter: the armed action (Reply, Request changes), else the blue one (Merge, Approve, the recommended answer, or
    // Settle once merged), else, with a note written, Reply. Merge and Approve take it since the action bar (Dan,
    // 2026-11-10: the approved mock's tooltip reads "M or ⌘↵"), with Undo as for every send. This replaces council 1b.
    // A send that was not confirmed: Cmd+Enter repeats it, as its Retry button says (council 3). While the toast
    // offers Retry with ⌘↵, the key is the toast's, unless you are writing a note.
    var toastOpen = false; try { toastOpen = toastEl.matches(':popover-open'); } catch (x) {}
    // The open ticket's own Retry box owns the key over any toast, and the toast then shows no ⌘↵ (hill climb 2 r11, Opus).
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && ownRetry() && !(here && !here.dataset.busy)) { ev.preventDefault(); if (!ev.repeat) retry(mounted.id); return; }
    // The toast never takes the key while the open ticket holds its own Retry, wherever focus is: its hint is hidden then (r12, Astra).
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && toastKey && toastOpen && !typing && !ownRetry()) { ev.preventDefault(); if (!ev.repeat) toastKey(); return; }
    // Cmd+R in a browser refreshes in place too (the desktop app's menu does the same).
    if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && (ev.key === 'r' || ev.key === 'R')) { ev.preventDefault(); wake(); return; }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && form) {
      ev.preventDefault();
      if (ev.repeat) return;
      var want = form.dataset.intent, b = want ? $('button[value="' + want + '"]', form) : $('button.primary', form);
      if (!b && form.elements.note && form.elements.note.value && form.elements.note.value.trim() && !stale(form)) b = $('button[value=reply]', form);
      if (!b && stale(form)) { say(form, 'You sent this note before the agent’s latest message, so it may have reached the agent. Send it again with Reply' + (keyLabel('ticket.reply') ? ' (' + keyLabel('ticket.reply') + ')' : '') + ', change it, or clear it.', 'bad'); return; }
      var gkb = $('button[value="go"] kbd', form);
      if (b && !b.disabled) send(form, b); else say(form, 'Nothing is recommended here. Pick an action: ' + [gkb && gkb.dataset.cmd === 'ticket.approve' ? ['ticket.approve', 'Approve'] : ['ticket.merge', 'Merge'], ['ticket.requestChanges', 'Request changes'], ['ticket.reply', 'Reply'], ['ticket.hold', 'Hold'], ['ticket.settle', 'Settle']].map(function(a){ var l = keyLabel(a[0]); return l ? l + ' ' + a[1] : a[1]; }).join(', ') + '.', '');
      return;
    }
    if (typing) {
      // Esc leaves the note only; it must not also close the ticket's sheet (Sol).
      if (ev.key === 'Escape') { ev.preventDefault(); var tf = typing.form; setIntent(tf, null); typing.blur(); if (tf && typing.tagName === 'TEXTAREA' && !typing.value.trim()) noting(tf, false); yieldKey(); }
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // Arrow keys on a focused option, button or menu belong to that control.
    var control = ev.target.closest && ev.target.closest('input, select, button, summary, [contenteditable]');
    if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && control) return;
    // Gmail's keys where they exist: J/K move, Z undoes, ? lists every key; E is done (Settle), H holds, R replies.
    // Caps Lock does not matter; holding a key moves through the list but never repeats a send.
    var k = ev.key.length === 1 && !ev.shiftKey ? ev.key.toLowerCase() : ev.key;
    // Space and Shift+Space page through the open message, from the list or the message (hill climb 2 r2, Opus), and in the kitchen's sheet (r11, Sol).
    if (k === ' ' && mounted && (focusView() || sheet.open) && (!control || (ev.target.closest && ev.target.closest('[data-plate].tile')))) {
      var ps = $('.plate-scroll', mounted);
      if (ps) { ev.preventDefault(); ps.scrollBy({ top: (ev.shiftKey ? -1 : 1) * Math.max(40, ps.clientHeight - 60) }); return; }
    }
    if (k === 'ArrowDown' || k === 'j') { ev.preventDefault(); step(1); return; }
    if (k === 'ArrowUp' || k === 'k') { ev.preventDefault(); step(-1); return; }
    if (ev.repeat) return;
    if (k === '?') { ev.preventDefault(); openSettings('keys'); return; }
    if (k === 'z') { var last = pendingSends[pendingSends.length - 1]; if (last) last.undo(); return; }
    if (k === 'v') { toggleView(); return; }
    if (k === 'Escape') { if (sheet.open) sheet.close(); return; }
    if (k === 'o' && mounted) { var link = $('.plate-bar a[href]', mounted); if (link) link.click(); return; }
    if (!form) return;
    // . opens More, as in Gmail, with its first row in focus.
    if (k === '.') { var mn = $('.abar .menu', form), mb = $('.abar [data-more]', form); if (mn && mb && mb.getClientRects().length) { ev.preventDefault(); try { mn.showPopover(); } catch (x) {} menuStep(mn, 1); } return; }
    // Left and right move between question cards; on a focused option they stay the browser's.
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && !control && qSets(form).length > 1) { ev.preventDefault(); qShow(form, qAt(form) + (k === 'ArrowRight' ? 1 : -1)); return; }
    // While a question waits, its option letters come first (an option "e" beats Settle).
    // A key that stands in for a changed one (ev.synthetic) is never an option's letter.
    if (/^[a-i]$/.test(k) && mounted && !ev.synthetic) {
      var ls = letterAt(ev.target, k);
      if (ls && ls.held) { say(ls.held.closest('form.act'), 'This answer is waiting on its Retry, so a letter does not change it.', ''); return; }
      if (ls) { ls.radio.checked = true; ls.radio.dispatchEvent(new Event('change', { bubbles: true })); return; }
    }
    // A key with no button here says why instead of doing nothing (Opus).
    // A T3 question has no Reply: point to answering it, or opening it in T3 Code (Astra).
    var kR = keyLabel('ticket.reply'), kO = keyLabel('ticket.open'), toT3 = (kO ? kO + ' to open' : 'open') + ' it in T3 Code.';
    var orR = $('button[value=reply]', form) ? ', or ' + (kR ? kR + ' to reply.' : 'reply.') : ', or ' + toT3;
    var NO = { go: 'No Merge here: answer the question' + orR, approve: 'No Approve here: answer the question' + orR, refire: 'No Request changes on a question: pick an option' + orR, reply: 'No Reply here: answer the question, or ' + toT3, settle: 'Settle comes back once the question is answered.', hold: 'Hold comes back once the question is answered.' };
    var press = function(kind){ var b = $('button[value="' + kind + '"]', form); if (b && !b.disabled) send(form, b); else if (NO[kind]) say(form, NO[kind], ''); };
    if (k === 'e') { press('settle'); return; }
    if (k === 'h') { press('hold'); return; }
    // M merges and A approves (Dan, 2026-11-10): one button, named by whether a pull request is open, and each key
    // presses it only under its own name. G, the old Go, still presses it, whichever it says (old habits).
    if (k === 'm' || k === 'a' || k === 'g') {
      // The button's key names its command (data-cmd), whatever key Settings → Shortcuts gave it.
      var gb = $('button[value="go"]', form), gk = gb && $('kbd', gb) ? ({ 'ticket.merge': 'M', 'ticket.approve': 'A' })[$('kbd', gb).dataset.cmd] || '' : '';
      if (k === 'g' || !gb || gk === k.toUpperCase()) { press(gb || k !== 'a' ? 'go' : 'approve'); return; }
      var kA = keyLabel('ticket.approve'), kM = keyLabel('ticket.merge');
      say(form, k === 'm' ? 'No Merge here: no pull request is open. ' + (kA ? kA + ' approves.' : 'Approve goes ahead.') : 'No Approve here: a pull request is open. ' + (kM ? kM + ' merges it.' : 'Merge merges it.'), '');
      return;
    }
    if (k === 'n') { if (form.elements.note) { ev.preventDefault(); noting(form, true); } return; }
    if (k === 'r' || k === 'f') {
      var kind = k === 'r' ? 'reply' : 'refire';
      if (!$('button[value="' + kind + '"]', form)) { if (NO[kind]) say(form, NO[kind], ''); return; }
      ev.preventDefault(); setIntent(form, kind);
      if (form.elements.note) form.elements.note.focus();
    }
  }
  // Every key goes through the shortcuts first (client/keys.mjs). With none changed it is onKey, exactly as before.
  // A changed key reaches onKey as the key its command had by default; a command with no default key runs here; a
  // default key its command gave up does nothing where that command applies. A plain key keeps typing in a text field
  // and belongs to an open dialog, as ⌘↵ does there (it sends), and an option's letter comes first while a question waits.
  document.addEventListener('keydown', function(ev){
    if (kxRec) return;
    // A key an input method uses while it composes text (Japanese, Chinese) is the method's alone, as in the action bar:
    // Esc or ⌘↵ then never leaves, or sends half a word. Safari's last key of a composition reads as keyCode 229.
    if (ev.isComposing || ev.keyCode === 229) return;
    if (!KST.changed) { onKey(ev); return; }
    var c = K.comboOf(ev), t = ev.target;
    var typing = !!(t && t.closest && t.closest('textarea, input[type=text], input[type=search], [contenteditable]'));
    var dialog = [barDlg, setDlg, launchDlg, viewer].some(function(d){ return d && d.open; });
    if (!c || (K.plain(c) && typing) || (dialog && K.dialogKey(c)) || (/^[a-i]$/.test(c) && letterAt(t, c))) { onKey(ev); return; }
    var r = K.route(KST, c, { ticket: !!mounted, dialog: dialog });
    if (!r) { onKey(ev); return; }
    // A changed key is the shortcut's alone, so the browser never also acts on it (Hold on ⌘F opens no Find).
    if (r.as) { ev.preventDefault(); onKey(K.synth(r.as, ev)); return; }
    ev.preventDefault();
    if (r.run && !ev.repeat) RUN[r.run]();
  });
  // The commands with no default key: the router runs them, in a dialog too. The two that open the bar close the other
  // dialogs first, as ⌘K does.
  function barAt(step){ if (!bar) return; if (setDlg.open) setDlg.close(); if (launchDlg.open) launchDlg.close(); if (viewer.open) viewer.close(); bar.openAt(step); }
  var RUN = {
    'thread.note': function(){ barAt('note'); },
    'thread.goto': function(){ barAt('goto'); },
    'view.you': function(){ setScope('you'); },
    'view.team': function(){ if (teamNow()) setScope('team'); else toast('View: Team needs a team first.', null, 3000); }
  };
  // Every key label on the board names its command (data-cmd, client/board.mjs) and shows that command's key now.
  // A button's first key shows the send key while it is armed (setIntent, noteKey): then only its own key changes.
  function relabel(scope){
    $$('kbd[data-cmd]', scope || document).forEach(function(kb){
      var g = keyLabel(kb.dataset.cmd), b = kb.closest('button');
      if (b && b.dataset.key !== undefined && $('kbd', b) === kb) {
        var sending = kb.textContent !== b.dataset.key;
        b.dataset.key = g;
        if (sending) { kb.textContent = SK(); kb.classList.remove('nokey'); return; }
      }
      kb.textContent = g; kb.classList.toggle('nokey', !g);
    });
    // A tooltip that names its key in brackets ("Settings (⌘,)") names the key now, or none.
    $$('[data-tcmd]', scope || document).forEach(function(el){ var g = keyLabel(el.dataset.tcmd); el.title = el.title.replace(/ \\([^)]*\\)$/, '') + (g ? ' (' + g + ')' : ''); });
  }

  // ----- Settings → Shortcuts (⌘K bar PR 4, the approved mock v3) -----
  // Each command's keys, with Change. Change records the next key pressed; Esc keeps the old one. A key another command
  // has asks first, in the row: Swap them, or Keep. Reset gives one command its default back; Reset all, every one.
  var kxRec = null, kxClash = null, kxHint = '', kxMods = '', kxEscAt = 0;
  var kxList = $('#kx-list'), kxQ = $('#kx-q');
  function escH(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function kxCaps(key){ return '<span class="kx-k">' + K.glyphs(key).map(function(g){ return '<kbd>' + escH(g) + '</kbd>'; }).join('') + '</span>'; }
  function kxRow(c){
    var keys = K.keysOf(KST, c.id), over = !K.isDefault(KST, c.id), rec = kxRec === c.id, cl = kxClash && kxClash.id === c.id ? kxClash : null;
    var line = rec ? (keys.length ? 'Recording. Press the keys, or esc to keep ' + keys.map(K.label).join(' or ') : 'Recording. Press the keys, or esc to leave it without one')
      : c.note && !over ? K.label(c.note) + ' is T3 Code’s own new-thread key' : (c.d || '');
    var right = rec ? '<span class="recbox" aria-hidden="true">' + escH(kxMods ? kxMods + ' …' : '…') + '</span>'
      : (cl ? kxCaps(cl.key) : keys.length ? keys.map(kxCaps).join('<span class="kx-or">or</span>') : '<span class="kx-no">No key</span>')
        + '<button type="button" class="kx-ed" data-kx-ed="' + c.id + '" aria-label="Change the key for ' + escH(c.t) + '">Change</button>';
    var more = '';
    if (cl) more = '<div class="kx-msg" role="alert"><b>Taken</b><span>' + escH(cl.text) + '</span>'
      + (cl.canTake ? '<button type="button" class="btn kx-b" data-kx-swap>' + (cl.gives && cl.gives.length ? 'Swap them' : 'Take it') + '</button>' : '')
      + '<button type="button" class="btn kx-b" data-kx-keep>' + (keys.length ? 'Keep ' + escH(keys.map(K.label).join(' or ')) : 'Cancel') + '</button></div>';
    else if (rec && kxHint) more = '<p class="kx-hint" role="alert">' + escH(kxHint) + '</p>';
    return '<div class="kr-row kx-row' + (over ? ' kr-over' : '') + (rec ? ' kx-rec' : '') + (cl ? ' kx-clash' : '') + '" data-kx="' + c.id + '"' + (rec ? ' tabindex="-1"' : '') + '>'
      + '<div class="kr-l"><div class="kr-h"><h4>' + escH(c.t) + '</h4><button type="button" class="kr-reset" data-kx-reset="' + c.id + '" title="Use the default key">Reset</button></div>'
      + (line ? '<p>' + escH(line) + '</p>' : '') + '</div><div class="kx-c">' + right + '</div>' + more + '</div>';
  }
  function kxFixed(f){
    return '<div class="kr-row kx-row kx-fix"><div class="kr-l"><div class="kr-h"><h4>' + escH(f.t) + '</h4></div>' + (f.d ? '<p>' + escH(f.d) + '</p>' : '') + '</div>'
      + '<div class="kx-c">' + f.keys.map(kxCaps).join('') + (f.more ? '<span class="kx-or">…</span>' : '') + '</div></div>';
  }
  function kxRender(){
    if (!kxList) return;
    var raw = kxQ ? kxQ.value.trim() : '', q = raw.toLowerCase(), groups = [], rows = {};
    var hit = function(words){ return !q || words.join(' ').toLowerCase().indexOf(q) >= 0; };
    K.COMMANDS.forEach(function(c){
      if (!hit([c.g, c.t, c.d || ''].concat(K.keysOf(KST, c.id).map(K.label))) && kxRec !== c.id && !(kxClash && kxClash.id === c.id)) return;
      if (!rows[c.g]) { rows[c.g] = []; groups.push(c.g); }
      rows[c.g].push(kxRow(c));
    });
    var fixed = K.FIXED.filter(function(f){ return hit(['Fixed', f.t, f.d || ''].concat(f.keys.map(K.label))); });
    var html = groups.map(function(g){ return '<h3 class="kgroup">' + escH(g) + '</h3><div class="kr-group kx-group">' + rows[g].join('') + '</div>'; }).join('')
      + (fixed.length ? '<h3 class="kgroup">Fixed</h3><div class="kr-group kx-group">' + fixed.map(kxFixed).join('') + '</div>' : '');
    // A render keeps the focus where it was, on the same button in the same row: a save that ends later renders too.
    var fa = document.activeElement, frow = fa && kxList.contains(fa) && fa.closest('[data-kx]'), fsel = null;
    if (frow) fsel = '[data-kx="' + frow.getAttribute('data-kx') + '"]' + (['data-kx-ed', 'data-kx-reset', 'data-kx-swap', 'data-kx-keep'].filter(function(n){ return fa.hasAttribute(n); }).map(function(n){ return ' [' + n + ']'; })[0] || '');
    kxList.innerHTML = html || '<p class="kx-none">No shortcut matches “' + escH(raw) + '”.</p>';
    var fback = fsel && kxList.querySelector(fsel); if (fback && fback !== document.activeElement) fback.focus();
    var ra = $('[data-kx-resetall]'); if (ra) ra.disabled = !KST.changed;
    var fb = $('[data-kx-file]'); if (fb) fb.hidden = !KFILE;
    var nt = $('.kx-note'), notes = (kxFileNote ? [kxFileNote] : []).concat(KST.notes || []);
    if (nt) { nt.hidden = !notes.length; nt.textContent = notes.length ? (KFILE ? 'keybindings.json: ' : 'Saved shortcuts: ') + notes.slice(0, 3).join(' ') + (notes.length > 3 ? ' And ' + (notes.length - 3) + ' more.' : '') : ''; }
  }
  function kxSay(text){ var l = $('.kx-live'); if (l) l.textContent = text || ''; }
  // What a change does to the other commands, in words, before it applies: " Hold until 8:00 tomorrow: H."
  function kxOthers(st, id){
    return K.COMMANDS.filter(function(c){ return c.id !== id && K.keysOf(st, c.id).join(' ') !== K.keysOf(KST, c.id).join(' '); })
      .map(function(c){ var ks = K.keysOf(st, c.id); return ' ' + c.t + ': ' + (ks.length ? ks.map(K.label).join(' or ') : 'no key') + '.'; }).join('');
  }
  function kxFocus(id){ var b = $('[data-kx-ed="' + id + '"]'); if (b) b.focus(); }
  function kxStart(id){
    kxRec = id; kxClash = null; kxHint = ''; kxMods = ''; kxRender();
    var r = $('.kx-row.kx-rec'); if (r) r.focus();
    var keys = K.keysOf(KST, id);
    kxSay('Recording a key for ' + K.CMD[id].t + '. Press the keys, or Escape to ' + (keys.length ? 'keep ' + K.label(keys[0]) : 'leave it without one') + '.');
  }
  function kxStop(back){ var id = kxRec; kxRec = null; kxHint = ''; kxMods = ''; kxRender(); if (back && id) kxFocus(id); }
  // Save: the browser's copy, and on the Mac the file. Every key label on the board follows.
  function kxApply(st, id, said){
    KST = st; kxClash = null;
    var list = K.toList(st), text = JSON.stringify(list);
    if (list.length) store('yc.keys', text); else forget('yc.keys');
    kxSeen = text;
    if (KFILE) KFILE.write(list).then(function(r){ kxFileNote = r && r.error ? 'Could not save the file: ' + r.error : ''; kxRender(); }, function(){ kxFileNote = 'Could not save the file.'; kxRender(); });
    relabel(document); kxRender();
    if (id) kxFocus(id);
    kxSay(said);
  }
  // Recording takes every key first, in the capture phase, so nothing else on the page acts on it. Tab still moves on.
  window.addEventListener('keydown', function(ev){
    if (!kxRec) return;
    if (!setDlg.open) { kxStop(false); return; }
    // Tab moves on from the row: its Change button has the focus first, so the browser moves on from there.
    if (ev.key === 'Tab') { kxStop(true); return; }
    ev.preventDefault(); ev.stopPropagation();
    if (ev.isComposing) return;
    if (ev.key === 'Escape') { kxEscAt = Date.now(); kxStop(true); kxSay('Kept as it was.'); return; }
    var id = kxRec, c = K.comboOf(ev);
    if (!c) {
      var g = K.glyphs((ev.metaKey || ev.ctrlKey ? 'mod+' : '') + (ev.altKey ? 'alt+' : '') + (ev.shiftKey ? 'shift+' : '') + 'x'); g.pop();
      kxMods = g.join(' '); var rb = $('.kx-row.kx-rec .recbox'); if (rb) rb.textContent = kxMods ? kxMods + ' …' : '…';
      return;
    }
    var cl = K.clash(KST, id, c);
    if (cl && (cl.reserved || cl.fixed)) { kxHint = cl.text; kxMods = ''; kxRender(); var r = $('.kx-row.kx-rec'); if (r) r.focus(); kxSay(cl.text); return; }
    kxRec = null; kxHint = ''; kxMods = '';
    if (cl) {
      kxClash = { id: id, key: c, other: cl.other, text: cl.text, canTake: cl.canTake, gives: cl.gives }; kxRender();
      var sb = $('[data-kx-swap]') || $('[data-kx-keep]'); if (sb) sb.focus();
      return;
    }
    kxApply(K.set(KST, id, c), id, K.CMD[id].t + ': ' + K.label(c) + '.');
  }, true);
  window.addEventListener('keyup', function(ev){
    if (!kxRec) return;
    var g = K.glyphs((ev.metaKey || ev.ctrlKey ? 'mod+' : '') + (ev.altKey ? 'alt+' : '') + (ev.shiftKey ? 'shift+' : '') + 'x'); g.pop();
    kxMods = g.join(' '); var rb = $('.kx-row.kx-rec .recbox'); if (rb) rb.textContent = kxMods ? kxMods + ' …' : '…';
  }, true);
  // Esc that stopped a recording never also closes Settings.
  setDlg.addEventListener('cancel', function(ev){ if (kxRec || Date.now() - kxEscAt < 400) { ev.preventDefault(); if (kxRec) kxStop(true); } });
  setDlg.addEventListener('close', function(){ kxRec = null; kxClash = null; kxHint = ''; kxMods = ''; });
  setDlg.addEventListener('click', function(ev){
    var t = ev.target; if (!t || !t.closest) return;
    if (kxRec && !t.closest('.kx-row.kx-rec')) kxStop(false);
    var ed = t.closest('[data-kx-ed]'); if (ed) { kxStart(ed.dataset.kxEd); return; }
    var rs = t.closest('[data-kx-reset]');
    if (rs) { var rid = rs.dataset.kxReset, dk = K.CMD[rid].keys, rst = K.reset(KST, rid); kxApply(rst, rid, K.CMD[rid].t + (dk.length ? ': ' + dk.map(K.label).join(' or ') + ' again.' : ' has no key again.') + kxOthers(rst, rid)); return; }
    if (t.closest('[data-kx-swap]') && kxClash) { var c = kxClash, sst = K.swap(KST, c.id, c.key); if (sst) kxApply(sst, c.id, K.CMD[c.id].t + ': ' + K.label(c.key) + '.' + kxOthers(sst, c.id)); return; }
    if (t.closest('[data-kx-keep]') && kxClash) { var kid = kxClash.id; kxClash = null; kxRender(); kxFocus(kid); kxSay('Kept as it was.'); return; }
    if (t.closest('[data-kx-resetall]')) { kxApply(K.build(K.defaultList()), null, 'Every shortcut has its default key again.'); var q = $('#kx-q'); if (q) q.focus(); return; }
    if (t.closest('[data-kx-file]') && KFILE) KFILE.open().then(function(r){ if (r && r.error) { kxFileNote = 'Could not open the file: ' + r.error; kxRender(); } }, function(){});
  });
  if (kxQ) kxQ.addEventListener('input', kxRender);
  // On the Mac the file is the list: read at start and whenever the window comes back, so an edit there applies.
  // With no file yet, the browser's list becomes it.
  function kxLoad(){
    if (!KFILE) return;
    KFILE.read().then(function(r){
      if (!r) return;
      if (r.error) { kxFileNote = r.error; kxRender(); return; }
      kxFileNote = '';
      if (r.list == null) { var mine = K.toList(KST); if (mine.length) KFILE.write(mine); kxRender(); return; }
      var text = JSON.stringify(r.list);
      if (text === kxSeen) { kxRender(); return; }
      kxSeen = text; KST = K.build(r.list); kxClash = null;
      if (Array.isArray(r.list) && r.list.length) store('yc.keys', text); else forget('yc.keys');
      relabel(document); kxRender();
    }, function(){});
  }
  window.addEventListener('focus', kxLoad);
  kxLoad();
  // A screenshot that loads changes the message's height: fades and the reader's join follow (hill climb 2 r2, Fable).
  document.addEventListener('load', function(ev){ if (ev.target && ev.target.tagName === 'IMG') fades(); }, true);
  // A screenshot that cannot load becomes a plain line saying so, never a broken box (hill climb r5, Opus).
  document.addEventListener('error', function(ev){
    var img = ev.target; if (!img || img.tagName !== 'IMG') return;
    var a = img.closest && img.closest('a.att'); if (!a) return;
    // An attachment keeps its box and its label, and says the file is gone (Dan, 2026-11-07).
    var p = document.createElement('span'); p.className = 'att missing'; p.setAttribute('role', 'listitem');
    var box = document.createElement('span'); box.className = 'att-img'; box.textContent = 'Not available';
    var cap = a.querySelector('.att-cap'); p.appendChild(box); if (cap) p.appendChild(cap);
    a.replaceWith(p);
  }, true);
  // Typing your own answer picks it: a field inside a label does not check the label's radio by itself.
  document.addEventListener('focusin', function(ev){ var t = ev.target; if (t.matches && t.matches('label.opt .custom')) { var r = t.parentNode.querySelector('input[data-custom]'); if (r) r.checked = true; } });

  applyPrefs(); applyScope(); normalizePicked(); sizeRail(); if (KST.changed || !K.mac) relabel(document); restoreDrafts(document);
  setView(state.view); setFolder('pass');
  fades();
  // The Cmd+K action bar (client/bar.mjs). View: You and View: Team read and set the same scope as the footer
  // chip's switch; with no reports (#yc-team absent) views() says so and their rows stay hidden (Dan, 2026-11-10).
  ${barCore}
  ${installBar}
  bar = installBar({
    $: $, $$: $$, store: store, forget: forget, state: state, prefs: prefs, reduce: reduce,
    mounted: function(){ return mounted; }, plateNode: plateNode, keyForm: keyForm, select: select, setFolder: setFolder, listKeyOf: listKeyOf,
    send: send, setIntent: setIntent, noting: noting, toggleView: toggleView, openLaunch: openLaunch, openSettings: openSettings, setDensity: setDensity, setTheme: setTheme, mini: function(k){ return MINI[k] || ''; },
    liftToast: liftToast, yieldKey: yieldKey, grow: grow, views: viewsNow, setScope: setScope,
    keyGlyphs: function(id){ return K.keysOf(KST, id).map(function(k){ return K.glyphs(k); }); }
  }, barCore());
})();
</script></body></html>`;

// A form over the limit is refused whole, never cut: a cut body could drop the field that names the action.
const MAX_FORM = 64 * 1024;
// An oversized body is drained, not destroyed, so the page gets the 413 and can let Dan shorten the note
// (PR-Agent r7 on #12). Past MAX_DRAIN the socket is cut: nobody needs to send that much.
const MAX_DRAIN = 1024 * 1024;
function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = '', seen = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      seen += chunk.length;
      if (seen > MAX_DRAIN) { req.destroy(); return reject(Object.assign(new Error('too large'), { tooLarge: true })); }
      if (seen <= MAX_FORM) body += chunk;
    });
    req.on('end', () => seen > MAX_FORM ? reject(Object.assign(new Error('too large'), { tooLarge: true })) : resolve(Object.fromEntries(new URLSearchParams(body))));
    req.on('error', reject);
  });
}
// A Hold keeps the time it was first given, so a retry after midnight does not add a day (PR-Agent r7 on #12).
const holds = new Map();
// Calls answered from this Pass, so the sheet shows the answer until the agent picks it up.
const answered = new Map();
const audit = (line) => { try { appendFileSync(join(OUT, 'actions.jsonl'), JSON.stringify(line) + '\n', { mode: 0o600 }); } catch { /* the log never blocks an action's result */ } };

// One path for every action, whichever door it came through (the tailnet page or the desktop app).
async function runAct(input, line) {
  if (input.kind === 'rules') {
    // A save of one rule older than a save of the same rule this page already sent is skipped: two saves that cross
    // on the way land in the order they were made (PR-Agent r8 on #49). Other rules are never held back by it
    // (r9). The answer is still the saved set.
    const page = String(input.page || '').slice(0, 64), seq = Number(input.seq);
    const slot = JSON.stringify([page, String(input.scope || ''), String(input.key || '')]);
    if (page && Number.isSafeInteger(seq)) {
      if (seq <= (rulesSeq.get(slot) || 0)) return { status: 200, text: JSON.stringify(rulesNow()) };
      rulesSeq.delete(slot); rulesSeq.set(slot, seq);
      if (rulesSeq.size > 500) rulesSeq.delete(rulesSeq.keys().next().value);
    }
    // One rule at a time, on top of the saved rules; the answer is the whole saved set, for the page to show.
    const out = changeRule(rules, { scope: String(input.scope || ''), key: String(input.key || ''), value: String(input.value ?? ''), reset: input.reset === '1' });
    if (out.error) return { status: 400, text: out.error };
    // A new file, then a rename: a failed write never leaves the saved rules half written.
    const tmp = RULES_FILE + '.saving';
    try { writeFileSync(tmp, JSON.stringify(out.rules, null, 2) + '\n', { mode: 0o600 }); renameSync(tmp, RULES_FILE); }
    catch (ex) { return { status: 500, text: 'Not saved: ' + String(ex.code || ex.message).slice(0, 80) }; }
    rules = out.rules; rulesError = ''; rulesRev = Math.max(rulesRev + 1, Date.now());
    audit({ ...line, saved: `rule ${input.key}` });
    wake?.();
    return { status: 200, text: JSON.stringify(rulesNow()) };
  }
  if (input.kind === 'launch' && rulesError) return { status: 409, text: `Not launched: ${rulesError} Change any rule in Settings → Rules to save them again.` };
  if (!status.ok || !live.live()) return { status: 503, text: 'The board is not checked right now, so the Pass will not act. Try again after the next update.' };
  // A read-only sign-in holds no operate scope: T3 Code would refuse every action, so say why up front.
  if (!canOperate) { audit({ ...line, refused: 'read-only' }); return { status: 403, text: 'Yes Chef is signed in read only. To act, quit, start it again and approve a level that covers your threads.' }; }
  let out;
  try { out = await act({ board, t3, input, holds, answered, projects, rules }); }
  catch (ex) {
    // T3 Code refused the sign-in itself (401) before any tool ran. The board no longer polls MCP, so this is
    // often where a revoked sign-in shows first: the app asks for a new one, as a failed poll used to.
    if (ex.auth) {
      audit({ ...line, refused: 'signed-out' });
      if (DESKTOP && !authLost) { authLost = true; pipe.send({ type: 'auth-lost' }); }
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

// The desktop app's door (desktop/main.mjs): actions arrive over the IPC pipe that only the app that started
// this process holds. No other process on this Mac can write to it, so the tailnet checks do not apply here.
// The HTTP /act route above keeps refusing every local caller.
if (DESKTOP) {
  pipe.on(async (m) => {
    if (!m || m.type !== 'act' || typeof m.body !== 'string') return;
    let out;
    if (m.body.length > MAX_FORM) out = { status: 413, text: 'That is too long to send. Shorten the note.' };
    else {
      const input = Object.fromEntries(new URLSearchParams(m.body));
      out = await runAct(input, { at: new Date().toISOString(), kind: input.kind, thread: input.thread, login: 'desktop app' });
    }
    pipe.send({ type: 'acted', id: m.id, status: out.status, text: out.text });
  });
}

/** The pages and images, for both doors: the web prototype's HTTP server and the desktop app's pipe. */
function route(url) {
  // ?p=A&p=B: the projects picked in the view menu; no p is All projects.
  const picked = pickedFrom(url.searchParams);
  const app = () => renderApp({ board, picked, link, status, origin: ORIGIN, answered, projects, rules: rulesNow() });
  const html = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  if (url.pathname === '/') return { status: 200, headers: html, body: page(app()) };
  if (url.pathname === '/app') return { status: 200, headers: html, body: app() };
  if (url.pathname.startsWith('/icon/')) {
    // A bad address or a file that went away is a 404, never a crash.
    let icon = null;
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
    let body = null;
    try { if (file && statSync(file).isFile() && statSync(file).size <= 20 * 1024 * 1024) body = readFileSync(file); } catch { body = null; }
    if (!body || !isShot(body)) return { status: 404, headers: {}, body: '' };
    return { status: 200, headers: { 'content-type': SHOT_TYPES[extname(file).toLowerCase()], 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" }, body };
  }
  if (url.pathname === '/healthz') return { status: status.ok ? 200 : 503, headers: {}, body: status.ok ? 'ok' : String(status.error || '') };
  return { status: 404, headers: {}, body: '' };
}

// The desktop app's window asks for a page over the pipe: { type: 'get', id, path } -> { type: 'got', id, status, headers, body }.
// Only reads: actions keep their own message above.
if (DESKTOP) {
  pipe.on((m) => {
    if (!m || m.type !== 'get' || typeof m.path !== 'string') return;
    let out;
    try { out = route(new URL(m.path, 'http://x')); } catch { out = { status: 500, headers: {}, body: 'The Pass could not build that page.' }; }
    const body = Buffer.isBuffer(out.body) ? out.body : Buffer.from(String(out.body));
    pipe.send({ type: 'got', id: m.id, status: out.status, headers: out.headers, body: body.toString('base64') });
  });
}

const web = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/act') {
    const reply = (status, text) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(text);
    let input, line;
    try {
      const why = await refuse({ headers: req.headers, peerPort: req.socket.remotePort, serverPort: PORT, origin: PAGE_ORIGIN, allowPath: ALLOW });
      input = await readForm(req);
      line = { at: new Date().toISOString(), kind: input.kind, thread: input.thread, login: req.headers['tailscale-user-login'] || '-' };
      if (why) { audit({ ...line, refused: why }); return reply(403, why); }
    } catch (ex) {
      return reply(ex.tooLarge ? 413 : 400, ex.tooLarge ? 'That is too long to send. Shorten the note.' : 'The Pass could not read that request.');
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
  const out = route(url);
  res.writeHead(out.status, out.headers).end(out.body);
});
// The desktop app opens no port (Dan, 2026-11-08): its window reads the pages over the IPC pipe instead
// (desktop/main.mjs, the yeschef:// scheme). The web prototype keeps its local address.
if (!DESKTOP) web.listen(PORT, '127.0.0.1', () => console.log(`The Pass prototype on http://127.0.0.1:${PORT} (T3: ${ORIGIN})`));

// Stop: end the stream and revoke its key, so no read-only key outlives Yes Chef. The app asks over the pipe before
// it quits (desktop/main.mjs); Ctrl-C or a kill does the same here. A run that dies without it leaves a key that the
// next start revokes (keys.sweep).
let stopping = null;
function stopLive() {
  return (stopping ??= (async () => {
    changes.stop(); baseChecks.stop(); prSizes.stop();
    await live.stop();
    try { console.log(`Revoked ${await keys.revokeMine()} read-only stream key(s).`); }
    catch (ex) { console.log(`Could not revoke the stream key: ${String(ex.message).slice(0, 120)}`); }
  })());
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => { const t = setTimeout(() => process.exit(0), 5000); stopLive().finally(() => { clearTimeout(t); process.exit(0); }); });
}
if (DESKTOP) {
  pipe.on((m) => {
    if (m?.type === 'stop') stopLive().finally(() => pipe.send({ type: 'stopped' }));
    else if (m?.type === 'wake') live.probe('woke from sleep');
  });
}
// The stream starts before the MCP sign-in: it needs no approval, only T3 Code's CLI on this Mac.
keys.sweep().then((n) => { if (n) console.log(`Revoked ${n} read-only stream key(s) left by an earlier run.`); })
  .catch((ex) => console.log(`Could not look for old stream keys: ${String(ex.message).slice(0, 120)}`))
  .finally(() => { if (!stopping) live.start(); });

// The desktop app keeps a sign-in in the macOS Keychain (desktop/main.mjs) and hands it over this pipe on request.
// The request goes out after the listener is set, so the answer cannot arrive before anything hears it.
// Two minutes: after an update macOS may ask Dan to let Yes Chef use its Keychain key before main can answer.
function savedSignIn() {
  if (!DESKTOP) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pipe.off(hear); resolve(null); }, 120000);
    function hear(m) { if (m && m.type === 'auth') { clearTimeout(timer); pipe.off(hear); resolve(m.auth || null); } }
    pipe.on(hear);
    pipe.send({ type: 'auth-please' });
  });
}
let auth = null;
const saved = await savedSignIn();
if (saved) {
  try {
    await connect(saved).call('t3_environment_read', {});
    auth = saved;
  } catch (ex) {
    // Only T3 Code's own refusal (revoked or expired) ends a saved sign-in. T3 Code being down does not:
    // the sign-in stays saved, and this start fails at the next call, as a fresh sign-in would.
    if (ex.auth) { console.log('The saved sign-in was refused by T3 Code. Sign in again.'); pipe.send({ type: 'auth-lost' }); }
    else auth = saved;
  }
}
if (auth) console.log(`Signed in. Scope: ${auth.scope} (saved sign-in)`);
else {
  // The desktop app (desktop/main.mjs) names itself with its version. The callback takes any free port unless
  // YESCHEF_CALLBACK_PORT names one.
  const name = process.env.YESCHEF_CLIENT_NAME || 'The Pass (web prototype)';
  console.log(`Signing in to T3 Code at ${ORIGIN} as "${name}".`);
  auth = await signIn(ORIGIN, { name, port: Number(process.env.YESCHEF_CALLBACK_PORT || 0), onLink: (l) => {
    writeFileSync(join(OUT, 'link.txt'), l + '\n', { mode: 0o600 });
    console.log(`Sign in to T3: ${l}\n(link file: ${join(OUT, 'link.txt')})`);
  } });
  console.log(`Signed in. Scope: ${auth.scope}`);
  if (DESKTOP) pipe.send({ type: 'auth-new', auth });
}
canOperate = String(auth.scope || '').split(' ').includes('orchestration:operate');
t3 = connect(auth);
envId = (await t3.call('t3_environment_read', {})).environmentId;
// The address T3 gives this sign-in for a thread, so the board links where it linked when it read threads over MCP.
try {
  const row = (await t3.call('t3_thread_list', { allProjects: true, includeSubagents: true, limit: 1 })).threads?.[0];
  const tail = row ? encodeURIComponent(row.threadId) : '';
  if (row && typeof row.link === 'string' && /^https?:/.test(row.link) && row.link.endsWith(tail)) linkBase = row.link.slice(0, -tail.length);
} catch (ex) { console.log(`Thread links fall back to ${ORIGIN}: ${String(ex.message).slice(0, 120)}`); }
// An action or a saved rule asks for a refresh at once; the stream brings T3's side of it.
var wake = kick;
kick();
setInterval(kick, BEAT_MS);
