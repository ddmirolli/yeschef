// Yes Chef desktop: The Pass in a window, signed in to the T3 Code that runs on this machine.
// It finds T3 Code (desktop/t3.mjs), starts the same board server as the web prototype (client/server.mjs) in an
// Electron utility process, opens T3 Code's own sign-in page in the browser for approval, and shows the board.
// Dan's 1a (2026-11-07): the sign-in stays across restarts. Main keeps it in userData, encrypted with
// safeStorage (its key lives in the macOS Keychain), and hands it to the board server over the IPC pipe.
// T3 Code refusing it (revoked in Settings -> Sharing & access, or past its 30 days) deletes it; so does
// Yes Chef -> Sign Out of T3 Code.
// Actions (answer, Merge, Request changes, Reply, Hold, Settle) go page -> preload bridge -> main -> the server's IPC pipe,
// so no other process on this Mac can send them. The pages come the same way: the window loads yeschef://board/,
// and main asks the board server for each page over the pipe, so the app opens no port on this Mac (Dan, 2026-11-08).
// T3 Code caps actions at the level approved at sign-in: Read only acts on nothing, and a thread that runs
// with Full access takes actions only from a Full access sign-in.
//
//   npm start                 open the app
//   npm run capture           hidden window; saves out/board.png once the board loads, checks the action
//                             path with a ticket that cannot exist, then quits
//   npm run app               build Yes Chef.app (build/package.mjs); `npm run app -- --install` puts it in /Applications
//
// T3 Code's address comes from the file T3 Code writes when it starts (~/.t3/userdata/server-runtime.json).
// YESCHEF_T3_ORIGIN overrides it; http://127.0.0.1:3773 is the fallback.
// YESCHEF_CALLBACK_PORT pins sign-in's callback port; by default sign-in takes any free one.
// YESCHEF_USER_DATA points the app at another data folder. Capture mode never reads or saves a sign-in
// unless it is set, so a test run cannot replace Dan's. Nor does it ever start a sign-in: without a saved one it
// saves out/no-sign-in.png and quits, so a test never registers a client with T3 Code.
//
// Updates (updates.mjs): checked 15 s after start, then every 4 minutes, against GitHub Releases. The user starts the
// download and the restart from a card in the window or the Yes Chef menu. YESCHEF_UPDATE_FEED points the check at a
// feed served on 127.0.0.1, to test an update without GitHub; with --capture and YESCHEF_UPDATE_DRILL=restart, quit or
// quit-now, the hidden window clicks through the update itself (see drill below).
import { app, BrowserWindow, Menu, autoUpdater as squirrel, dialog, ipcMain, nativeTheme, net, protocol, safeStorage, shell, utilityProcess } from 'electron';
import electronUpdater from 'electron-updater';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNELS, channelOf } from './channels.mjs';
import { TESTED_T3, findT3, older, t3Answers } from './t3.mjs';
import { canUpdateInPlace, createUpdates, feedOverride, menuFor, moveCard, visibleCard } from './updates.mjs';

const STARTED = Date.now();
const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE = process.argv.includes('--capture');
// One version, from package.json: the About panel, the menu and the name T3 Code lists under Sharing & access.
// A Nightly version (0.2.1-nightly.20261110.1) makes this copy "Yes Chef (Nightly)", with its own icon (channels.mjs).
const VERSION = app.getVersion();
const CHANNEL = channelOf(VERSION);
const NAME = CHANNELS[CHANNEL].name;
const CLIENT_NAME = `${NAME} ${VERSION}`;
const FEED = feedOverride(process.env.YESCHEF_UPDATE_FEED);
if (process.env.YESCHEF_UPDATE_FEED && !FEED) console.error('YESCHEF_UPDATE_FEED ignored: it must be http on 127.0.0.1 or localhost.');
const DRILL = CAPTURE && FEED && ['restart', 'quit', 'quit-now'].includes(process.env.YESCHEF_UPDATE_DRILL) ? process.env.YESCHEF_UPDATE_DRILL : '';
// T3 Code's address, set once T3 Code answers there (waitForT3). The saved sign-in is tied to it.
let T3 = null;

let server = null;
let serverUp = false;
let win = null;
let boardShown = false;

// The product is Yes Chef; The Pass is its main panel. Set before the app is ready so the
// menu, the About panel and Quit carry the name. The Dock icon is the approved cloche mark.
app.setName(NAME);
app.setAboutPanelOptions({ applicationName: NAME, applicationVersion: VERSION });
const ICON = join(HERE, 'build', CHANNELS[CHANNEL].icon);
if (process.env.YESCHEF_USER_DATA) app.setPath('userData', process.env.YESCHEF_USER_DATA);
const KEEP = !CAPTURE || !!process.env.YESCHEF_USER_DATA;
// The board's own address. A standard, secure scheme, so the page keeps relative links, fetch, EventSource
// and localStorage as it had on http://127.0.0.1:8632. It must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: 'yeschef', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const BOARD = 'yeschef://board';
const isBoard = (url) => { try { const u = new URL(url); return u.protocol === 'yeschef:' && u.host === 'board'; } catch { return false; } };

// The saved sign-in: one file, encrypted with the Keychain-held key, for this T3 Code address only.
const savedFile = () => join(app.getPath('userData'), 't3-sign-in.bin');
// Keychain reads and writes in flight. macOS may hold one on a prompt ("Yes Chef wants to use your
// confidential information") until Dan answers it; quitting then hangs, so quit ends the app at once (see below).
let keychainBusy = 0;
async function keychain(work) {
  keychainBusy++;
  // After three seconds on a prompt, the window says what macOS is waiting for.
  const hint = setTimeout(() => { if (win && !win.isDestroyed() && !boardShown) win.loadURL(waitingPage('keychain')).catch(() => {}); }, 3000);
  try { return await work(); } finally { clearTimeout(hint); keychainBusy--; }
}
async function loadSignIn() {
  try {
    // No saved file, no Keychain: a first start goes straight to T3 Code's approval page.
    if (!KEEP || !existsSync(savedFile())) return null;
    const { result, shouldReEncrypt } = await keychain(async () => {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('no Keychain');
      return safeStorage.decryptStringAsync(readFileSync(savedFile()));
    });
    const d = JSON.parse(result);
    // A minute of margin: a sign-in about to lapse is not handed over.
    if (!(d.origin === T3 && d.auth?.token && d.expiresAt > Date.now() + 60000)) return null;
    if (shouldReEncrypt) await writeSignIn(d);
    return d.auth;
  } catch { return null; }
}
async function writeSignIn(d) {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(savedFile(), await keychain(() => safeStorage.encryptStringAsync(JSON.stringify(d))), { mode: 0o600 });
}
async function saveSignIn(auth) {
  try {
    if (!KEEP || !auth?.token || !(await keychain(() => safeStorage.isAsyncEncryptionAvailable()))) return;
    await writeSignIn({ origin: T3, auth, expiresAt: Date.now() + Math.max(0, Number(auth.expiresIn) || 0) * 1000 });
  } catch (e) { console.error('Could not save the sign-in:', e.message); }
}
/** Delete the saved sign-in. Returns the error if the file is still there (force: true covers "already gone"). */
function forgetSignIn() {
  if (!KEEP) return null;
  try { rmSync(savedFile(), { force: true }); return null; }
  catch (e) { console.error('Could not delete the saved sign-in:', e.message); return e; }
}

function startServer() {
  // An Electron utility process runs the board server with the app's own Node: no separate Node install, and no
  // ELECTRON_RUN_AS_NODE, which the release build turns off (release plan, section 3). Messages go over its port.
  server = utilityProcess.fork(join(HERE, '..', 'client', 'server.mjs'), [T3], {
    serviceName: 'Yes Chef board',
    stdio: 'pipe',
    env: { ...process.env, YESCHEF_CLIENT_NAME: CLIENT_NAME, YESCHEF_DESKTOP: '1',
      YESCHEF_CALLBACK_PORT: process.env.YESCHEF_CALLBACK_PORT || '0',
      // Rules live in the app's data folder (kitchen-rules.json), next to the sign-in. A capture run without its own folder keeps
      // them in a temp folder, so a test never changes Dan's.
      ...(KEEP ? { YESCHEF_RULES_FILE: join(app.getPath('userData'), 'kitchen-rules.json') } : {}) },
  });
  serverUp = true;
  let noSignIn = null;
  server.on('message', (m) => {
    if (!m) return;
    if (m.type === 'auth-please') {
      loadSignIn().then((auth) => {
        // A capture never starts a sign-in: the board server would register a client with T3 Code. It stops here,
        // before its two-minute wait for an answer runs out and it signs in anyway.
        if (!auth && CAPTURE) { noSignIn?.(); stopServer(); return; }
        if (serverUp) server.postMessage({ type: 'auth', auth });
      });
      return;
    }
    if (m.type === 'auth-new') { saveSignIn(m.auth); return; }
    if (m.type === 'auth-lost') { forgetSignIn(); return; }
    if (m.type === 'tick') { tick(m.data); return; }
    if (m.type === 'got') { const got = pages.get(m.id); if (got) { pages.delete(m.id); got(m); } return; }
    const done = m.type === 'acted' && pending.get(m.id);
    if (done) { pending.delete(m.id); done([m.status, m.text]); }
  });
  server.on('exit', () => {
    serverUp = false;
    for (const done of pending.values()) done([502, 'Not confirmed: the board server stopped. Check the thread in T3 Code before you send again.']);
    pending.clear();
    for (const got of pages.values()) got({ status: 502, headers: {}, body: '' });
    pages.clear();
    // The page's event stream ends too, so it shows "lost the connection" instead of a board that looks current.
    for (const c of streams) { try { c.close(); } catch { /* already closed */ } }
    streams.clear();
  });
  // Resolves 'signed-in', or 'no-sign-in' for a capture with no saved sign-in.
  return new Promise((resolve, reject) => {
    let opened = false;
    noSignIn = () => resolve('no-sign-in');
    // Whole lines only: a sign-in link split across two chunks must never open half a URL.
    createInterface({ input: server.stdout }).on('line', (text) => {
      console.log(text);
      const link = /Sign in to T3: (\S+)/.exec(text);
      if (link && !opened) { opened = true; if (!CAPTURE) { openOutside(link[1]); win?.loadURL(waitingPage(true)).catch(() => {}); } }
      if (/^Signed in\./.test(text)) resolve('signed-in');
    });
    server.stderr.on('data', (c) => process.stderr.write(c));
    server.on('exit', (code) => reject(new Error(`board server exited (${code})`)));
  });
}

/** Only web links leave the app, and only to the browser: no other URL scheme reaches the system. */
function openOutside(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.toString());
  } catch { /* not a URL: ignore */ }
}

// The pages: yeschef://board/<path> -> the board server over its IPC pipe -> the page. Only GET; actions go below.
// The event stream (/events) lives here in main: each poll's tick comes over the pipe and goes to every open stream.
const pages = new Map();
const streams = new Set();
const enc = new TextEncoder();
let nextPage = 0;
let ticks = 0;
function tick(data) {
  ticks++;
  for (const c of streams) { try { c.enqueue(enc.encode(`event: tick\ndata: ${data}\n\n`)); } catch { streams.delete(c); } }
}
function boardPage(req) {
  const u = new URL(req.url);
  if (u.host !== 'board' || req.method !== 'GET') return new Response('', { status: 404 });
  // An empty page at the board's address, for moving the old settings in before the board loads.
  if (u.pathname === '/blank') return new Response('<!doctype html><meta name="color-scheme" content="dark light"><body style="background:#0a0b0d">', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (!serverUp) return new Response('The board server is not running. Quit and start Yes Chef again.', { status: 503 });
  if (u.pathname === '/events') {
    let ctl;
    const body = new ReadableStream({
      start(c) { ctl = c; streams.add(c); c.enqueue(enc.encode('retry: 3000\n\n')); },
      cancel() { streams.delete(ctl); },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
  }
  const id = ++nextPage;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (pages.delete(id)) resolve(new Response('', { status: 504 })); }, 30000);
    pages.set(id, (m) => { clearTimeout(timer); resolve(new Response(m.body ? Buffer.from(m.body, 'base64') : null, { status: m.status, headers: m.headers })); });
    server.postMessage({ type: 'get', id, path: u.pathname + u.search });
  });
}

// One time: the board's saved settings and unsent notes move from the old address (http://127.0.0.1:8632, where
// the app served the board before 2026-11-08) to yeschef://board. Main answers that old address itself for the
// moment it takes, in a hidden window, so no port opens. A marker file keeps it to one run.
const OLD_BOARD = 'http://127.0.0.1:8632';
const movedFile = () => join(app.getPath('userData'), 'settings-moved');
async function readOldSettings() {
  if (!KEEP || existsSync(movedFile())) return null;
  const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  protocol.handle('http', (req) => (new URL(req.url).origin === OLD_BOARD
    ? new Response('<!doctype html><title>Yes Chef</title>', { headers: { 'content-type': 'text/html' } })
    : net.fetch(req, { bypassCustomProtocolHandlers: true })));
  try {
    await w.loadURL(`${OLD_BOARD}/`);
    const json = await w.webContents.executeJavaScript(
      'JSON.stringify(Object.keys(localStorage).filter(function(k){ return k.indexOf("yc.") === 0; }).map(function(k){ return [k, localStorage.getItem(k)]; }))');
    const list = JSON.parse(json);
    return Array.isArray(list) ? list.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') : [];
  } catch (e) { console.error('Could not read the old board settings; trying again next start:', e.message); return null; }
  finally { protocol.unhandle('http'); if (!w.isDestroyed()) w.destroy(); }
}
// Written into the new address before the board first loads there, so the board starts with them.
async function moveOldSettings(list) {
  if (!KEEP || !list || existsSync(movedFile())) return;
  try {
    if (list.length) {
      await win.loadURL(`${BOARD}/blank`);
      // Settings already saved at the new address win: they are newer.
      const n = await win.webContents.executeJavaScript(`(function(l){ var n = 0; l.forEach(function(e){ if (localStorage.getItem(e[0]) === null) { localStorage.setItem(e[0], e[1]); n++; } }); return n; })(${JSON.stringify(list)})`);
      console.log(`Moved ${n} board settings to the new address.`);
    }
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(movedFile(), new Date().toISOString() + '\n');
  } catch (e) { console.error('Could not move the old board settings:', e.message); }
}

// Actions: the board window -> preload bridge -> here -> the board server over its IPC pipe.
// Only the board page in this app's own window may act; any other sender is refused.
const pending = new Map();
let nextId = 0;
ipcMain.handle('yeschef:act', (event, body) => {
  const frame = event.senderFrame;
  let fromBoard = false;
  try { fromBoard = !!win && event.sender === win.webContents && !!frame && frame.parent === null && isBoard(frame.url); } catch { fromBoard = false; }
  if (!fromBoard) return [403, 'Actions come only from the Yes Chef board window.'];
  if (typeof body !== 'string') return [400, 'The Pass could not read that request.'];
  if (!serverUp) return [503, 'The board server is not running. Quit and start Yes Chef again.'];
  const id = ++nextId;
  return new Promise((resolve) => {
    // T3 Code may still take a slow send: after a minute the answer is "not confirmed", never "failed".
    const timer = setTimeout(() => { if (pending.delete(id)) resolve([504, 'Not confirmed: no answer within a minute. Check the thread in T3 Code before you send again.']); }, 60000);
    pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
    server.postMessage({ type: 'act', id, body });
  });
});

// Updates and the app's own card (updates.mjs draws the words, preload.cjs the card). The card shows over whatever page
// the window shows: an update, or the one-time offer to move to Applications.
// IN_PLACE: Squirrel.Mac can replace this copy where it runs (not on a disk image, not a translocated copy).
const IN_PLACE = canUpdateInPlace(process.execPath);
// electron-updater's autoUpdater, made only where it runs: a built app, outside a capture unless it is the drill.
const updater = app.isPackaged && (!CAPTURE || DRILL) ? electronUpdater.autoUpdater : null;
let updates = null;
let offerMove = false;
const updateWatchers = new Set();
function currentCard() {
  if (offerMove) return moveCard(NAME);
  return updates ? visibleCard(updates.state, { name: NAME, current: VERSION, inPlace: IN_PLACE }) : null;
}
function showCard() { if (win && !win.isDestroyed()) win.webContents.send('yeschef:card', currentCard()); }
function updateChanged(state) {
  showCard();
  buildMenu();
  for (const watch of [...updateWatchers]) watch(state);
}
// Only the main frame of this app's own window, on the board or a waiting page, reads the card or clicks it.
function fromWindow(event) {
  try {
    const frame = event.senderFrame;
    return !!win && event.sender === win.webContents && !!frame && frame.parent === null && (isBoard(frame.url) || frame.url.startsWith('data:text/html'));
  } catch { return false; }
}
// Appearance: the board's choice (Settings, the action bar, Option-Shift-Cmd-A), so the title bar, menus and the card
// follow it too. Only the board page in this window sets it, and only to one of the three; anything else is Match system.
ipcMain.handle('yeschef:theme', (event, t) => {
  let fromBoard = false;
  try { const frame = event.senderFrame; fromBoard = !!win && event.sender === win.webContents && !!frame && frame.parent === null && isBoard(frame.url); } catch { fromBoard = false; }
  if (!fromBoard) return false;
  nativeTheme.themeSource = t === 'light' || t === 'dark' ? t : 'system';
  return true;
});
// null asks for the card showing now; { card, button } is a click, which counts only on a button of that card.
ipcMain.handle('yeschef:card', (event, click) => {
  if (!fromWindow(event)) return null;
  const card = currentCard();
  if (click == null) return card;
  if (!card || typeof click !== 'object' || click.card !== card.id || !card.buttons.some((b) => b.id === click.button)) return null;
  if (card.id === 'move') {
    offerMove = false;
    // Not Now is the answer kept. A Move that did not happen (cancelled, or the copy in Applications is open) brings the
    // card back, so Move works again once that copy is closed (PR-Agent r3 on #66).
    if (click.button === 'stay') markMoveOffered();
    showCard();
    if (click.button === 'move' && !moveToApplications()) { offerMove = true; showCard(); }
  } else if (click.button === 'move') moveToApplications();
  else updates?.act(click.button);
  return null;
});

// Where the app runs from (release plan, section 6): on the first start outside Applications, the card offers to move
// it there. After Not Now it is not offered again; an update card still offers it.
const moveFile = () => join(app.getPath('userData'), 'move-offered');
function markMoveOffered() {
  try { mkdirSync(app.getPath('userData'), { recursive: true }); writeFileSync(moveFile(), new Date().toISOString() + '\n'); }
  catch (e) { console.error('Could not save the answer to the move offer:', e.message); }
}
/** Move this copy into /Applications. On success Electron quits it and opens the moved copy; false if it did not move. */
function moveToApplications() {
  try {
    return app.moveToApplicationsFolder({
      conflictHandler: (kind) => {
        // Electron's default would bring the running copy forward and quit this one, newer or not.
        if (kind === 'existsAndRunning') {
          dialog.showMessageBoxSync(win, { type: 'info', message: `${NAME} is open from Applications`, detail: `Quit it, then choose Move again.` });
          return false;
        }
        return dialog.showMessageBoxSync(win, { type: 'question', message: `Replace the ${NAME} in Applications?`,
          detail: `The copy in Applications goes to the Trash and this one, ${VERSION}, takes its place.`, buttons: ['Replace', 'Cancel'], defaultId: 0, cancelId: 1 }) === 0;
      },
    });
  } catch (e) { dialog.showErrorBox(`${NAME} could not move to Applications`, e.message); return false; }
}
function updateItems() {
  const state = updates ? updates.state : { status: 'off', message: CAPTURE ? 'Updates are off in a capture.' : 'Updates work only in a built Yes Chef.' };
  return menuFor(state, { name: NAME, inPlace: IN_PLACE })
    .map(({ id, ...item }) => (id ? { ...item, click: () => (id === 'move' ? moveToApplications() : updates?.act(id)) } : item));
}

// The standard Mac menus, plus Sign Out of T3 Code: it deletes the saved sign-in and quits, so the
// next start asks T3 Code again. Revoking the sign-in in T3 Code itself is under Settings -> Sharing & access.
// A sign-out that could not delete the file says so and keeps the app open: quitting would look like
// a sign-out while the next start reuses the sign-in (PR-Agent r1 on #26).
function signOut() {
  const failed = forgetSignIn();
  if (!failed) { app.quit(); return; }
  dialog.showErrorBox('Yes Chef is still signed in',
    `Yes Chef could not delete its saved sign-in (${failed.code || failed.message}). To end it, revoke Yes Chef in T3 Code under Settings → Sharing & access. It is listed as "${CLIENT_NAME}", or as "Yes Chef (desktop)" if you signed in before Yes Chef named its version.`);
}
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: NAME, submenu: [
      { role: 'about' }, ...updateItems(), { type: 'separator' },
      { label: 'Sign Out of T3 Code', click: signOut },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
      { type: 'separator' }, { label: `Version ${VERSION}`, enabled: false },
    ] },
    { role: 'editMenu' },
    // Reload refreshes the board in place, so a send waiting out its Undo and a half-written note stay (council 3).
    // Force Reload reloads the page once every waiting send has had its full Undo and gone (hill climb 2 r1).
    { label: 'View', submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: (item, win) => { if (win) win.webContents.executeJavaScript('window.__ycSoftReload ? window.__ycSoftReload() : location.reload()').catch(() => {}); } },
      { label: 'Force Reload', accelerator: 'Shift+CmdOrCtrl+R', click: (item, win) => { if (win) drain(win).then(() => { if (!win.isDestroyed()) win.webContents.reloadIgnoringCache(); }); } },
      { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
  ]));
}

function stopServer() { if (serverUp) server.kill(); }

// A send waiting out its Undo keeps its four seconds when you quit, close the window or Force Reload: the app waits
// while the page sends it (or you undo it) and T3 answers, then goes on (hill climb 2 r1, Sol). It asks the page every
// 150 ms, so a send queued meanwhile also gets its full Undo; there is no overall limit (r2, Astra). A page that does
// not answer within 2 s is hung and never holds the app open.
async function drain(w) {
  for (;;) {
    if (!w || w.isDestroyed()) return;
    const busy = await Promise.race([
      w.webContents.executeJavaScript('window.__ycBusy ? window.__ycBusy() : false').catch(() => false),
      new Promise((r) => setTimeout(() => r(false), 2000)),
    ]);
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}
let drained = false;

/** The window before the board: "Connecting" while a saved sign-in is checked, the approval note when T3 Code asks,
 *  and what to do when T3 Code is not running. */
function waitingPage(approve, where = '') {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const body = approve === 'no-t3'
    ? '<p style="color:#f2f3f5">T3 Code is not running on this Mac.</p>' +
      '<p>Yes Chef shows the threads of the T3 Code on this Mac. Open T3 Code and Yes Chef connects on its own.</p>' +
      '<p>No T3 Code yet? Get it at <a href="https://t3.codes" style="color:#7fb2ff">t3.codes</a>.</p>' +
      `<p style="font-size:13px">Looked for it at ${esc(where)}.</p>`
    : approve === 'keychain'
    ? '<p style="color:#f2f3f5">macOS is asking whether Yes Chef may use its saved sign-in.</p>' +
      '<p>Click <b>Always Allow</b> in the Keychain prompt. It may be behind this window. If you click Deny, Yes Chef asks T3 Code to sign in again.</p>'
    : approve
    ? '<p style="color:#f2f3f5">Approve Yes Chef in the T3 Code page that just opened in your browser.</p>' +
      '<p>Read only shows the board. To answer, merge or request changes, pick the level your threads run at, usually Full access. Yes Chef stays signed in after that.</p>'
    : '<p>Connecting to T3 Code…</p>';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><meta name="color-scheme" content="dark light"><body style="margin:0;display:grid;place-items:center;height:100vh;font:15px -apple-system,system-ui;background:#0a0b0d;color:#a1a6ad">' +
    '<div style="max-width:440px;line-height:1.5">' + body + '</div></body>');
}

// T3 Code must answer before the board server starts: without it the server stops at sign-in and the app with it.
// Until it answers, the window says so, and the app looks again every three seconds, so starting T3 Code is enough.
// T3 Code may come back on another port, so its own file is read again each time.
async function waitForT3() {
  for (let told = false; ;) {
    const found = findT3();
    if (await t3Answers(found.origin)) return found;
    console.log(`T3 Code is not answering at ${found.origin} (${found.from}).`);
    // The window closed while waiting: the app is quitting, and there is nothing to start.
    if (!win || win.isDestroyed()) return null;
    if (!told) {
      told = true;
      await win.loadURL(waitingPage('no-t3', found.origin)).catch(() => {});
      if (CAPTURE) { await capture('no-t3.png'); app.quit(); return null; }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// Capture mode saves what the hidden window shows.
async function capture(name) {
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage();
  const outDir = process.env.YESCHEF_CAPTURE_DIR || join(HERE, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, name), image.toPNG());
  console.log(`Saved ${join(outDir, name)}`);
}

async function main() {
  await app.whenReady();
  protocol.handle('yeschef', boardPage);
  buildMenu();
  if (app.dock && !CAPTURE) app.dock.setIcon(ICON);
  // The capture check runs hidden: no Dock icon.
  if (CAPTURE) app.setActivationPolicy('accessory');
  win = new BrowserWindow({ width: 1440, height: 900, show: !CAPTURE, title: NAME, icon: ICON, backgroundColor: '#0a0b0d',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: join(HERE, 'preload.cjs') } });
  // Closing the window (it quits the app) waits for any send still in its Undo, as Quit does.
  win.on('close', (event) => {
    if (drained) return;
    event.preventDefault();
    drain(win).then(() => { drained = true; if (!win.isDestroyed()) win.close(); });
  });
  // The page asks before a browser tab leaves mid-Undo; here the drain above has already run, so leaving goes ahead.
  win.webContents.on('will-prevent-unload', (event) => event.preventDefault());
  // Links out of the board (pull requests, T3 Code) open in the browser, not in the app.
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  // The window stays on the board: any other navigation goes to the browser instead.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isBoard(url)) { event.preventDefault(); openOutside(url); }
  });
  // Updates: off in a capture, unless it is the update drill. The first check runs 15 s after start, T3 Code or not.
  if (!CAPTURE || DRILL) {
    updates = createUpdates({ updater, squirrel, app, version: VERSION, feed: FEED, inPlace: IN_PLACE, onChange: updateChanged });
    buildMenu();
  }
  offerMove = app.isPackaged && !CAPTURE && !app.isInApplicationsFolder() && !existsSync(moveFile());
  await win.loadURL(waitingPage(false));
  const found = await waitForT3();
  if (!found) return;
  T3 = found.origin;
  console.log(`T3 Code: ${T3} (${found.from}), version ${found.version || 'not known'}. Yes Chef ${VERSION}.`);
  // An older T3 Code than the one this Yes Chef was tested with gets a note, never a refusal.
  if (found.version && older(found.version, TESTED_T3)) {
    const note = `T3 Code ${found.version} is older than ${TESTED_T3}, the version Yes Chef ${VERSION} was tested with. If something on the board looks wrong, update T3 Code.`;
    console.log(note);
    if (!CAPTURE) dialog.showMessageBox(win, { type: 'info', message: 'T3 Code is older than Yes Chef expects', detail: note }).catch(() => {});
  }
  await win.loadURL(waitingPage(false));
  const old = await readOldSettings();
  if (await startServer() === 'no-sign-in') {
    // A capture with no saved sign-in: the window stays on "Connecting" and the board never loads.
    console.log('No saved sign-in, and a capture never starts one.');
    if (DRILL) { await drill(); return; }
    await capture('no-sign-in.png');
    app.quit();
    return;
  }
  boardShown = true;
  await moveOldSettings(old);
  await win.loadURL(`${BOARD}/`);
  if (DRILL) { await new Promise((r) => setTimeout(r, 3500)); await drill(); return; }
  if (CAPTURE) {
    await new Promise((r) => setTimeout(r, 3500));
    await capture('board.png');
    // The action path, end to end, with a ticket that cannot exist: a read-only sign-in is refused
    // before T3 Code is called, and any other sign-in gets "no longer on the board". Nothing is sent.
    const probe = await win.webContents.executeJavaScript(
      "window.yeschef ? window.yeschef.act('kind=settle&thread=yeschef-capture-probe&nonce=capture-probe') : 'no bridge'");
    console.log('Action path:', JSON.stringify(probe));
    // The board as the window sees it, over yeschef:// (no port): its tickets, and whether it says the feed is lost.
    const seen = await win.webContents.executeJavaScript("JSON.stringify({ url: location.href, tickets: document.querySelectorAll('.tile').length, lost: !!document.querySelector('.netstrip') })");
    console.log('Board:', seen, `ticks: ${ticks}, open streams: ${streams.size}`);
    app.quit();
  }
}

// The update drill (YESCHEF_UPDATE_DRILL, with --capture and YESCHEF_UPDATE_FEED): the hidden window takes an update
// the way a user does, with the card's own buttons, and saves each card. The schedule is the real one, so the first
// check comes 15 s after start. `restart` clicks Restart: Squirrel.Mac installs as the app quits, but does not open the
// new copy, which would start without the test's data folder. `quit` clicks When I Quit, waits until Squirrel.Mac has
// the update, then quits. `quit-now` quits right after When I Quit, as a user who clicks it and then Quit does: the quit
// must wait for Squirrel.Mac (whenStaged). Each way, once the app has quit, the new version stands where this copy was.
async function drill() {
  const since = () => `${((Date.now() - STARTED) / 1000).toFixed(1)} s after start`;
  const menu = () => JSON.stringify(Menu.getApplicationMenu().items[0].submenu.items.filter((i) => i.label).map((i) => (i.enabled ? i.label : `(${i.label})`)));
  const until = (status, ms) => new Promise((resolve, reject) => {
    const watch = (s) => {
      const done = s.status === status;
      if (!done && s.status !== 'error' && s.status !== 'off') return;
      clearTimeout(timer);
      updateWatchers.delete(watch);
      if (done) resolve(s); else reject(new Error(`update ${s.status}: ${s.message || ''}`));
    };
    const timer = setTimeout(() => { updateWatchers.delete(watch); reject(new Error(`no "${status}" within ${ms / 1000} s`)); }, ms);
    updateWatchers.add(watch);
    watch(updates.state);
  });
  const press = (button) => win.webContents.executeJavaScript(`(function () {
    var host = document.querySelector('yeschef-card');
    var b = host && host.shadowRoot && host.shadowRoot.querySelector('[data-button=${JSON.stringify(button)}]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  try {
    const offered = await until('available', 60000);
    console.log(`Drill: ${offered.version} found ${since()}. Menu: ${menu()}`);
    await capture('update-available.png');
    if (!(await press('download'))) throw new Error('no Download button on the card');
    const ready = await until('ready', 180000);
    console.log(`Drill: ${ready.version} downloaded and checked ${since()}. Menu: ${menu()}`);
    await capture('update-ready.png');
    if (DRILL === 'restart') {
      updater.autoRunAppAfterInstall = false;
      if (!(await press('restart'))) throw new Error('no Restart button on the card');
      console.log('Drill: Restart clicked. Squirrel.Mac installs as the app quits.');
    } else if (DRILL === 'quit-now') {
      if (!(await press('on-quit'))) throw new Error('no When I Quit button on the card');
      console.log(`Drill: When I Quit clicked, then Quit at once ${since()}.`);
      squirrel.once('update-downloaded', () => console.log(`Drill: Squirrel.Mac has the update ${since()}; the quit waited for it.`));
      app.quit();
    } else {
      const taken = new Promise((resolve) => squirrel.once('update-downloaded', resolve));
      if (!(await press('on-quit'))) throw new Error('no When I Quit button on the card');
      await Promise.race([taken, new Promise((resolve, reject) => setTimeout(() => reject(new Error('Squirrel.Mac did not take the update within 60 s')), 60000))]);
      console.log(`Drill: When I Quit clicked; Squirrel.Mac has the update ${since()}. Menu: ${menu()}`);
      await capture('update-on-quit.png');
      app.quit();
    }
    // An install that never quits the app fails the drill.
    setTimeout(() => { console.error('Drill failed: the app did not quit within 60 s.'); stopServer(); app.exit(1); }, 60000);
  } catch (e) { console.error(`Drill failed: ${e.message}`); stopServer(); app.exit(1); }
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (drained) return;
  event.preventDefault();
  // When I Quit: the quit also waits for Squirrel.Mac to finish taking the update, so it installs (PR-Agent r2 on #66).
  Promise.all([drain(win), updates?.whenStaged()]).then(() => { drained = true; app.quit(); });
});
app.on('will-quit', () => {
  stopServer();
  // A Keychain call still waiting on a macOS prompt keeps Electron from ever finishing its quit: the window
  // and the board server close, and the app hangs. The board server is already stopped and nothing is left
  // to save, so the app ends here instead (found 2026-11-07).
  if (keychainBusy > 0) process.kill(process.pid, 'SIGKILL');
});
// app.exit() skips will-quit, so the board server is stopped here first.
main().catch((e) => { console.error(e); stopServer(); app.exit(1); });
