// Updates, the way T3 Code does them (docs/desktop-release-plan-v0_1.md, section 6; T3 Code's
// apps/desktop/src/updates/DesktopUpdates.ts):
//
//   - The first check runs 15 seconds after start, then one every 4 minutes.
//   - Nothing downloads on its own (autoDownload off) and nothing installs on quit (autoInstallOnAppQuit off).
//     The user starts the download, then picks Restart, or When I Quit, which is the only way install on quit turns on.
//   - Stable takes only Stable releases; Nightly only Nightly releases (channels.mjs). Never an older version.
//
// No Electron import here: main.mjs passes in electron-updater's autoUpdater, Electron's own (Squirrel.Mac) autoUpdater
// and the app, so the rules below run under `node --test` with stand-ins (desktop/updates.test.mjs).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHANNELS, channelOf } from './channels.mjs';

export const FIRST_CHECK_MS = 15 * 1000;
export const CHECK_EVERY_MS = 4 * 60 * 1000;
// When I Quit: how long a quit waits for Squirrel.Mac to finish taking the update (about a second in the drill).
export const STAGE_WAIT_MS = 30 * 1000;
// electron-updater sends a random per-install ID with every request to the feed, for staged rollouts. Yes Chef stages
// nothing and sends no ID that could tell one Mac from another (section 6, "no telemetry"): every copy sends this one.
export const NO_ID = '00000000-0000-0000-0000-000000000000';

/**
 * YESCHEF_UPDATE_FEED, for testing an update on this Mac without GitHub: a feed folder served on this Mac only.
 * Only http on 127.0.0.1 or localhost counts; anything else is refused, so it can never move the feed off the Mac.
 * Even then Squirrel.Mac installs only a bundle signed to the running app's own code requirement.
 */
export function feedOverride(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && !u.username && !u.password) {
      return u.href.endsWith('/') ? u.href : `${u.href}/`;
    }
  } catch { /* not a URL */ }
  return null;
}

/** Squirrel.Mac cannot replace an app on a disk image or one macOS runs from a translocated copy. */
export const canUpdateInPlace = (appPath) => !/^\/Volumes\//.test(appPath) && !appPath.includes('/AppTranslocation/');

/**
 * electron-updater 6.8.9 hands the downloaded ZIP to Squirrel.Mac by serving it from an HTTP server on 127.0.0.1
 * (MacUpdater.updateDownloaded). Yes Chef opens no port on this Mac (Dan, 2026-11-08), so it hands Squirrel a file
 * instead: a feed on disk that points at the ZIP electron-updater already downloaded and checked against the sha512 in
 * the release's feed. Squirrel then checks the app inside against the running app's code requirement, as before.
 * Returns false, and changes nothing, when this electron-updater has no such step: the caller then turns updates off
 * rather than let the library open its port.
 */
export function fileHandoff(updater, squirrel) {
  if (typeof Object.getPrototypeOf(updater)?.updateDownloaded !== 'function') return false;
  updater.updateDownloaded = async function updateDownloaded(zipFileInfo, event) {
    const feed = join(dirname(event.downloadedFile), 'squirrel-feed.json');
    writeFileSync(feed, JSON.stringify({ url: pathToFileURL(event.downloadedFile).href }), { mode: 0o600 });
    squirrel.setFeedURL({ url: pathToFileURL(feed).href });
    this.dispatchUpdateDownloaded(event);
    // As the library does: with install on quit, Squirrel takes the update now and installs it when the app quits.
    if (this.autoInstallOnAppQuit) squirrel.checkForUpdates();
    return [];
  };
  return true;
}

/** One short line from an updater error, for the card. */
export function shortError(e) {
  const text = String(e?.message || e || 'unknown error').split('\n')[0].trim();
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|net::ERR_/.test(text)) return 'No connection to the update server. Try again later.';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/**
 * The card the window shows for an update state, or null. Copy only; the preload draws it (preload.cjs), and keeps
 * `version` on one line in the title (a Nightly version would break at its hyphen).
 * `current` is the running version; `inPlace` is canUpdateInPlace for this copy.
 */
export function cardFor(state, { name, current, inPlace = true }) {
  const v = state.version;
  switch (state.status) {
    case 'available':
      return inPlace
        ? { id: 'available', version: v, title: `${name} ${v} is available`, body: `You have ${current}.`,
            buttons: [{ id: 'later', label: 'Later' }, { id: 'download', label: 'Download', primary: true }] }
        : { id: 'available', version: v, title: `${name} ${v} is available`, body: `You have ${current}. ${name} can update itself only from Applications.`,
            buttons: [{ id: 'later', label: 'Later' }, { id: 'move', label: 'Move to Applications', primary: true }] };
    case 'downloading':
      return { id: 'downloading', version: v, title: `Downloading ${name} ${v}`, body: `${state.percent || 0}%`, progress: state.percent || 0,
        buttons: [{ id: 'later', label: 'Hide' }] };
    case 'ready':
      return state.onQuit ? null : { id: 'ready', version: v, title: `${name} ${v} is ready`, body: `Restart ${name} to finish the update.`,
        buttons: [{ id: 'on-quit', label: 'When I Quit' }, { id: 'restart', label: 'Restart', primary: true }] };
    case 'checking':
      return state.manual ? { id: 'checking', title: 'Checking for updates…', body: '', buttons: [] } : null;
    case 'current':
      return state.manual ? { id: 'current', title: `${name} is up to date`, body: `You have ${current}, the newest ${CHANNELS[channelOf(current)].label} version.`,
        buttons: [{ id: 'ok', label: 'OK', primary: true }] } : null;
    case 'error':
      return state.manual ? { id: 'error', title: `Could not update ${name}`, body: state.message || '', buttons: [{ id: 'ok', label: 'OK', primary: true }] } : null;
    default:
      return null;
  }
}

/** The one-time offer to move the app into Applications (section 6, "Where the app runs from"). */
export const moveCard = (name) => ({ id: 'move', title: `Move ${name} to Applications?`, body: `${name} can update itself only from the Applications folder.`,
  buttons: [{ id: 'stay', label: 'Not Now' }, { id: 'move', label: 'Move', primary: true }] });

/** The update items in the app menu, by state. An item with an `id` runs that action (the controller's act, or main's move). */
export function menuFor(state, { name, inPlace = true }) {
  const v = state.version;
  switch (state.status) {
    case 'off': return [{ label: 'Check for Updates…', enabled: false, toolTip: state.message }];
    case 'checking': return [{ label: 'Checking for Updates…', enabled: false }];
    case 'available': return [inPlace ? { id: 'download', label: `Download ${name} ${v}` } : { id: 'move', label: `Move to Applications to Update` }];
    case 'downloading': return [{ label: `Downloading ${name} ${v} (${state.percent || 0}%)`, enabled: false }];
    case 'ready': return [{ id: 'restart', label: `Restart to Update ${name}` },
      state.onQuit ? { label: `Updates When ${name} Quits`, enabled: false } : { id: 'on-quit', label: `Update When ${name} Quits` }];
    default: return [{ id: 'check', label: 'Check for Updates…' }];
  }
}

/**
 * Wire electron-updater for this copy of the app and start the checks.
 *   updater   electron-updater's autoUpdater (a MacUpdater)
 *   squirrel  Electron's autoUpdater (Squirrel.Mac)
 *   app       { isPackaged, quit }; version: app.getVersion()
 *   feed      feedOverride(process.env.YESCHEF_UPDATE_FEED), or null for the GitHub feed in app-update.yml
 *   onChange  called with each new state; the card and the menu follow it
 */
export function createUpdates({ updater, squirrel, app, version, feed = null, inPlace = true, log = console, onChange = () => {}, timers = globalThis }) {
  const channel = channelOf(version);
  let state = { status: 'idle' };
  let doing = null; // 'check' | 'download' | 'install' while one runs; a background check is 'poll'
  let checking = null; // the check that runs now, so its end is told apart from a later one's
  let staging = null; // When I Quit: settles true once Squirrel.Mac has the update, false if it failed to take it
  let timer = null;
  let poller = null;
  const set = (next) => { state = next; onChange(state); };
  const api = {
    channel,
    get state() { return state; },
    check, download, install, installOnQuit, hide, whenStaged,
    act(id) { return ({ check: () => check({ manual: true }), download, restart: install, 'on-quit': installOnQuit, later: hide, ok: hide })[id]?.(); },
    stop() { timers.clearTimeout(timer); timers.clearInterval(poller); },
  };

  if (!app.isPackaged) { set({ status: 'off', message: 'Updates work only in a built Yes Chef.' }); return api; }
  if (!fileHandoff(updater, squirrel)) { set({ status: 'off', message: 'This build cannot install updates without opening a port.' }); return api; }

  updater.logger = log;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  // The channel setter also allows downgrades; nothing here may go back a version, so allowDowngrade is set after it.
  updater.channel = channel;
  updater.allowDowngrade = false;
  updater.allowPrerelease = channel === 'nightly';
  updater.requestHeaders = { 'x-user-staging-id': NO_ID };
  if (feed) updater.setFeedURL({ provider: 'generic', url: feed, channel });

  updater.on('checking-for-update', () => { if (doing === 'check') set({ status: 'checking', manual: true }); });
  updater.on('update-available', (info) => {
    const manual = doing === 'check';
    doing = null;
    // A background check that finds the version the card already offers keeps the card as it is (hidden or not).
    if (!manual && state.status === 'available' && state.version === info.version) return;
    set({ status: 'available', version: info.version, manual });
  });
  updater.on('update-not-available', () => {
    const manual = doing === 'check';
    doing = null;
    if (manual) set({ status: 'current', manual: true });
    else if (state.status === 'checking' || state.status === 'error') set({ status: 'idle' });
  });
  updater.on('download-progress', (p) => {
    const percent = Math.floor(Number(p?.percent) || 0);
    if (state.status !== 'downloading' || percent !== state.percent) set({ ...state, status: 'downloading', percent });
  });
  updater.on('update-downloaded', (info) => { doing = null; set({ status: 'ready', version: info?.version || state.version, manual: true }); });
  updater.on('error', (e) => {
    const was = doing;
    doing = null;
    log.error?.(`Update ${was || 'check'} failed: ${shortError(e)}`);
    // A background check that fails (offline, GitHub busy) stays quiet and tries again in 4 minutes.
    if (was === 'poll' || was === null) { if (state.status === 'checking') set({ status: 'idle' }); return; }
    set({ status: 'error', message: shortError(e), manual: true });
  });

  timer = timers.setTimeout(() => {
    check();
    poller = timers.setInterval(check, CHECK_EVERY_MS);
  }, FIRST_CHECK_MS);
  return api;

  /**
   * A check. Background checks skip while an update is offered, downloads or waits for its restart: the offer stands
   * until the user acts on it, and no check holds up its Download (PR-Agent r3 on #66). A withdrawn release then fails
   * the download with its error, and the next check starts afresh.
   */
  function check({ manual = false } = {}) {
    if (state.status === 'off') return;
    // A check by hand while an update is offered, downloading or ready shows its card again instead.
    if (['available', 'downloading', 'ready'].includes(state.status) && manual) { set({ ...state, hidden: false }); return; }
    // A check by hand during a background check takes that check over: the user sees it run and sees its result.
    if (manual && doing === 'poll') { doing = 'check'; set({ status: 'checking', manual: true }); return; }
    if (doing || ['available', 'downloading', 'ready'].includes(state.status)) return;
    doing = manual ? 'check' : 'poll';
    const mine = {};
    checking = mine;
    // Errors arrive as the 'error' event too; the promise's own rejection is handled there. A check that ends with no
    // event at all (electron-updater returns null when it is not active) must not block every check after it.
    Promise.resolve()
      .then(() => updater.checkForUpdates())
      .catch(() => {})
      .finally(() => {
        if (checking !== mine) return;
        checking = null;
        if (doing !== 'check' && doing !== 'poll') return;
        doing = null;
        if (state.status === 'checking') set({ status: 'idle' });
      });
  }
  function download() {
    if (state.status !== 'available' || doing) return;
    doing = 'download';
    set({ status: 'downloading', version: state.version, percent: 0, manual: true });
    Promise.resolve(updater.downloadUpdate()).catch(() => {});
  }
  /** Restart: quit, let Squirrel.Mac put the new app in place, and open it. */
  function install() {
    if (state.status !== 'ready') return;
    doing = 'install';
    updater.quitAndInstall();
  }
  /**
   * When I Quit: the user's choice to install on quit. Squirrel.Mac takes the update now and installs it on the next
   * quit. Taking it (copy, unzip, check the signature) needs a moment, so a quit waits for it: see whenStaged.
   */
  function installOnQuit() {
    if (state.status !== 'ready' || state.onQuit) return;
    doing = 'install';
    updater.autoInstallOnAppQuit = true;
    staging = new Promise((resolve) => {
      const done = (ok) => {
        squirrel.removeListener('update-downloaded', taken);
        squirrel.removeListener('error', failed);
        // The error itself reaches the user through electron-updater's 'error' event (the card above).
        if (!ok) updater.autoInstallOnAppQuit = false;
        resolve(ok);
      };
      const taken = () => done(true);
      const failed = () => done(false);
      squirrel.once('update-downloaded', taken);
      squirrel.once('error', failed);
    });
    squirrel.checkForUpdates();
    set({ ...state, onQuit: true });
  }
  /**
   * For main's before-quit: resolves when the quit may go on. With When I Quit chosen, that is once Squirrel.Mac has
   * the update (true) or failed to take it (false), or after STAGE_WAIT_MS (false). Otherwise at once (true).
   */
  function whenStaged() {
    if (!staging) return Promise.resolve(true);
    return Promise.race([staging, new Promise((resolve) => timers.setTimeout(() => resolve(false), STAGE_WAIT_MS))]);
  }
  /** Later, Hide or OK: the card goes until something changes. The menu keeps the update. */
  function hide() {
    if (['current', 'error', 'checking'].includes(state.status)) set({ status: 'idle' });
    else set({ ...state, manual: false, hidden: true });
  }
}

/** The card for a state, unless the user hid it. */
export const visibleCard = (state, ctx) => (state.hidden ? null : cardFor(state, ctx));
