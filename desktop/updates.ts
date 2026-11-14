// Updates, the way T3 Code does them (docs/desktop-release-plan-v0_1.md, section 6; T3 Code's
// apps/desktop/src/updates/DesktopUpdates.ts):
//
//   - The first check runs 15 seconds after start, then one every 4 minutes.
//   - Nothing downloads on its own (autoDownload off) and nothing installs on quit (autoInstallOnAppQuit off).
//     The user starts the download, then picks Restart, or When I Quit, which is the only way install on quit turns on.
//   - Stable takes only Stable releases; Nightly only Nightly releases (channels.ts). Never an older version on its
//     own track. The track is the user's choice (Update Track in the app menu), saved, as T3 Code's update channel;
//     until one is saved it is the running build's own. Switching track (setChannel) checks the other track, takes
//     its newest build even when that is an older version, downloads it and restarts into it, as T3 Code's track
//     switch does (apps/desktop/src/updates/DesktopUpdates.ts setChannel; Dan, 2026-11-14).
//
// No Electron import here: main.ts passes in electron-updater's autoUpdater, Electron's own (Squirrel.Mac) autoUpdater
// and the app, so the rules below run under vitest with stand-ins (desktop/updates.test.ts).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OutgoingHttpHeaders } from 'node:http';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { CHANNELS, channelOf } from './channels.ts';
import type { ChannelName } from './channels.ts';

// What electron-updater sends with its events, read as T3 Code reads it (apps/desktop/src/updates/DesktopUpdates.ts,
// UpdateInfo and DownloadProgressInfo). An event that does not match is never acted on as a guess. The percent must
// be finite: NaN or Infinity would put "NaN%" on the card.
const UpdateInfo = Schema.Struct({ version: Schema.String });
const DownloadProgress = Schema.Struct({ percent: Schema.Finite });
const readUpdateInfo = Schema.decodeUnknownOption(UpdateInfo);
const readProgress = Schema.decodeUnknownOption(DownloadProgress);
/** The error an update or a download gets when Yes Chef cannot read what the update server sent about it. */
const UNREADABLE = 'The update server sent an answer Yes Chef cannot read.';

/** Where the updater is: off, idle, checking, an update available, downloading, ready to install, current, or failed. */
export type UpdateStatus = 'off' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'current' | 'error';
export interface UpdateState {
  status: UpdateStatus; version?: string | undefined; percent?: number; manual?: boolean; hidden?: boolean; onQuit?: boolean; message?: string;
  /** While a track switch runs: the track it switches to. */
  switching?: ChannelName;
}
export interface CardButton { id: string; label: string; primary?: boolean }
/** The update card's copy. The preload draws it. */
export interface Card { id: string; version?: string | undefined; title: string; body: string; progress?: number; buttons: CardButton[] }
export interface MenuItem { id?: string; label: string; enabled?: boolean; toolTip?: string | undefined }
/** What the card and the menu read besides the state. */
export interface CardContext { name: string; current?: string; inPlace?: boolean; channel?: ChannelName }

/** electron-updater's autoUpdater, as this file uses it (a MacUpdater; the tests pass a stand-in). */
export interface Updater {
  logger: unknown; autoDownload: boolean; autoInstallOnAppQuit: boolean; channel: string | null; allowDowngrade: boolean;
  allowPrerelease: boolean; requestHeaders: OutgoingHttpHeaders | null;
  setFeedURL(options: { provider: 'generic'; url: string; channel: string }): void;
  on(event: 'checking-for-update' | 'update-not-available', listener: () => void): unknown;
  // What these events carry is read through the Schemas above, so it arrives here as unknown.
  on(event: 'update-available' | 'download-progress' | 'update-downloaded' | 'error', listener: (payload: unknown) => void): unknown;
  checkForUpdates(): unknown;
  downloadUpdate(): unknown;
  quitAndInstall(): void;
}
/** Electron's own autoUpdater (Squirrel.Mac), as this file uses it. */
export interface Squirrel {
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  once(event: 'update-downloaded' | 'error', listener: () => void): unknown;
  removeListener(event: 'update-downloaded' | 'error', listener: () => void): unknown;
}
/** MacUpdater's step that hands the download to Squirrel.Mac, which fileHandoff replaces. */
interface Handoff {
  autoInstallOnAppQuit: boolean;
  dispatchUpdateDownloaded(event: unknown): void;
  updateDownloaded(zipFileInfo: unknown, event: { downloadedFile: string }): Promise<unknown[]>;
}
/** electron-updater's logger, as the app passes it (console); the update errors go to its error. */
export interface Logger { info?: (line: string) => void; warn?: (line: string) => void; error?: (line: string) => void; debug?: (line: string) => void }
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
}
export interface Updates {
  /** The saved track: the one checks follow. */
  readonly channel: ChannelName;
  readonly state: UpdateState;
  /** Whether the track can change now: not while updates are off, an update downloads, or one waits for the quit. */
  canSwitch(): boolean;
  /** Save the track and, when it is not the running build's own, download that track's newest build and restart into it. */
  setChannel(next: ChannelName): boolean;
  check(options?: { manual?: boolean }): void;
  download(): void;
  install(): void;
  installOnQuit(): void;
  hide(): void;
  whenStaged(): Promise<boolean>;
  act(id: string): void;
  stop(): void;
}

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
export function feedOverride(value: string | null | undefined): string | null {
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
export const canUpdateInPlace = (appPath: string): boolean => !/^\/Volumes\//.test(appPath) && !appPath.includes('/AppTranslocation/');

/**
 * electron-updater 6.8.9 hands the downloaded ZIP to Squirrel.Mac by serving it from an HTTP server on 127.0.0.1
 * (MacUpdater.updateDownloaded). Yes Chef opens no port on this Mac (Dan, 2026-11-08), so it hands Squirrel a file
 * instead: a feed on disk that points at the ZIP electron-updater already downloaded and checked against the sha512 in
 * the release's feed. Squirrel then checks the app inside against the running app's code requirement, as before.
 * Returns false, and changes nothing, when this electron-updater has no such step: the caller then turns updates off
 * rather than let the library open its port.
 */
export function fileHandoff(updater: object, squirrel: Pick<Squirrel, 'setFeedURL' | 'checkForUpdates'>): boolean {
  if (typeof (Object.getPrototypeOf(updater) as Partial<Handoff> | null)?.updateDownloaded !== 'function') return false;
  (updater as Handoff).updateDownloaded = async function updateDownloaded(this: Handoff, _zipFileInfo: unknown, event: { downloadedFile: string }) {
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
export function shortError(e: unknown): string {
  const text = (String((e as { message?: unknown } | null | undefined)?.message || e || 'unknown error').split('\n')[0] ?? '').trim();
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|net::ERR_/.test(text)) return 'No connection to the update server. Try again later.';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/**
 * The card the window shows for an update state, or null. Copy only; the preload draws it (preload.cts), and keeps
 * `version` on one line in the title (a Nightly version would break at its hyphen).
 * `current` is the running version; `inPlace` is canUpdateInPlace for this copy.
 */
export function cardFor(state: UpdateState, ctx: CardContext): Card | null {
  const { name, current, inPlace = true } = ctx;
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
      return state.manual ? { id: 'checking', title: state.switching ? `Switching to ${CHANNELS[state.switching].label}…` : 'Checking for updates…', body: '', buttons: [] } : null;
    case 'current':
      return state.manual ? { id: 'current', title: `${name} is up to date`, body: `You have ${current}, the newest ${CHANNELS[ctx.channel || channelOf(current)].label} version.`,
        buttons: [{ id: 'ok', label: 'OK', primary: true }] } : null;
    case 'error':
      return state.manual ? { id: 'error', title: `Could not update ${name}`, body: state.message || '', buttons: [{ id: 'ok', label: 'OK', primary: true }] } : null;
    default:
      return null;
  }
}

/** The one-time offer to move the app into Applications (section 6, "Where the app runs from"). */
export const moveCard = (name: string): Card => ({ id: 'move', title: `Move ${name} to Applications?`, body: `${name} can update itself only from the Applications folder.`,
  buttons: [{ id: 'stay', label: 'Not Now' }, { id: 'move', label: 'Move', primary: true }] });

/** The update items in the app menu, by state. An item with an `id` runs that action (the controller's act, or main's move). */
export function menuFor(state: UpdateState, { name, inPlace = true }: CardContext): MenuItem[] {
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
export function createUpdates({ updater, squirrel, app, version, channel: saved = null, saveChannel = () => {}, feed = null, inPlace = true, log = console, onChange = () => {}, timers = globalThis }: {
  updater: Updater; squirrel: Squirrel; app: { isPackaged: boolean }; version: string; feed?: string | null; inPlace?: boolean;
  /** The saved track, or null for the running build's own; saveChannel keeps a new choice (main.ts, in the data folder). */
  channel?: ChannelName | null; saveChannel?: (channel: ChannelName) => void;
  log?: Logger; onChange?: (state: UpdateState) => void; timers?: Timers;
}): Updates {
  const own = channelOf(version);
  let channel: ChannelName = saved || own;
  let switching: ChannelName | null = null; // a switch that runs: it downloads what it finds and restarts into it
  let queued: ChannelName | null = null; // a switch asked for while a check ran: electron-updater would answer it with that check
  let state: UpdateState = { status: 'idle' };
  let doing: 'check' | 'poll' | 'download' | 'install' | null = null; // while one runs; a background check is 'poll'
  let checking: object | null = null; // the check that runs now, so its end is told apart from a later one's
  let staging: Promise<boolean> | null = null; // When I Quit: settles true once Squirrel.Mac has the update, false if it failed to take it
  let timer: unknown = null;
  let poller: unknown = null;
  const set = (next: UpdateState) => { state = next; onChange(state); };
  const api: Updates = {
    get channel() { return channel; },
    get state() { return state; },
    check, download, install, installOnQuit, hide, whenStaged, canSwitch, setChannel,
    act(id) { const acts: Record<string, () => void> = { check: () => check({ manual: true }), download, restart: install, 'on-quit': installOnQuit, later: hide, ok: hide }; return acts[id]?.(); },
    stop() { timers.clearTimeout(timer); timers.clearInterval(poller); },
  };

  if (!app.isPackaged) { set({ status: 'off', message: 'Updates work only in a built Yes Chef.' }); return api; }
  if (!fileHandoff(updater, squirrel)) { set({ status: 'off', message: 'This build cannot install updates without opening a port.' }); return api; }

  updater.logger = log;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.requestHeaders = { 'x-user-staging-id': NO_ID };
  follow(channel);

  updater.on('checking-for-update', () => { if (doing === 'check') set({ status: 'checking', manual: true, ...(switching ? { switching } : {}) }); });
  updater.on('update-available', (raw: unknown) => {
    const info = readUpdateInfo(raw);
    // Never offered without a version: a check by hand shows the error, a background check stays quiet (failed).
    if (Option.isNone(info)) return failed(new Error(UNREADABLE));
    const { version: found } = info.value;
    const manual = doing === 'check';
    doing = null;
    // Only a build of the saved track is offered, as T3 Code ignores an update outside the selected channel: a check
    // that ran on the track before a switch, or a feed that lists the other track, offers nothing.
    if (channelOf(found) !== channel) { log.info?.(`Update ${found} ignored: not on the ${CHANNELS[channel].label} track.`); return nothingFound(manual); }
    // A background check that finds the version the card already offers keeps the card as it is (hidden or not).
    if (!manual && state.status === 'available' && state.version === found) return settle();
    set({ status: 'available', version: found, manual, ...(switching ? { switching } : {}) });
    // A switch takes what it found at once: the user asked for it in the menu.
    if (switching) download();
    settle();
  });
  updater.on('update-not-available', () => nothingFound(doing === 'check'));
  updater.on('download-progress', (raw: unknown) => {
    const progress = readProgress(raw);
    // As in T3 Code: a tick that cannot be read is logged and the bar keeps its place until the next one.
    if (Option.isNone(progress)) { log.warn?.(`Update download progress not read: ${UNREADABLE}`); return; }
    const percent = Math.floor(progress.value.percent);
    if (state.status !== 'downloading' || percent !== state.percent) set({ ...state, status: 'downloading', percent });
  });
  updater.on('update-downloaded', (raw: unknown) => {
    const info = readUpdateInfo(raw);
    // Never ready on the version the card offered before: the download's own version, or the error.
    if (Option.isNone(info)) return failed(new Error(UNREADABLE));
    doing = null;
    // Never installs a build of the other track: a download the saved track no longer wants (T3 Code installs only a
    // build its track switch accepts).
    if (channelOf(info.value.version) !== channel) {
      switching = null;
      set({ status: 'error', manual: true, message: `Yes Chef downloaded ${info.value.version}, which is not a ${CHANNELS[channel].label} build. Nothing was installed.` });
      return settle();
    }
    set({ status: 'ready', version: info.value.version, manual: true, ...(switching ? { switching } : {}) });
    // A switch restarts into the build it downloaded.
    if (switching) install();
  });
  updater.on('error', failed);

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
  function check({ manual = false }: { manual?: boolean } = {}): void {
    if (state.status === 'off') return;
    // A check by hand while an update is offered, downloading or ready shows its card again instead.
    if (['available', 'downloading', 'ready'].includes(state.status) && manual) { set({ ...state, hidden: false }); return; }
    // A check by hand during a background check takes that check over: the user sees it run and sees its result.
    if (manual && doing === 'poll') { doing = 'check'; set({ status: 'checking', manual: true }); return; }
    if (doing || ['available', 'downloading', 'ready'].includes(state.status)) return;
    doing = manual ? 'check' : 'poll';
    const mine: object = {};
    checking = mine;
    // Errors arrive as the 'error' event too; the promise's own rejection is handled there. A check that ends with no
    // event at all (electron-updater returns null when it is not active) must not block every check after it.
    Promise.resolve()
      .then(() => updater.checkForUpdates())
      .catch(() => {})
      .finally(() => {
        if (checking !== mine) return;
        checking = null;
        if (doing !== 'check' && doing !== 'poll') return settle();
        doing = null;
        // No answer at all: a switch that asked stops, so a later background check never downloads on its behalf.
        switching = null;
        if (state.status === 'checking') set({ status: 'idle' });
        settle();
      });
  }
  /** A check that found no build of the saved track. A switch says so and keeps the saved track, so it can be tried again. */
  function nothingFound(manual: boolean): void {
    doing = null;
    if (switching) {
      const label = CHANNELS[switching].label;
      switching = null;
      set({ status: 'error', manual: true, message: `There is no ${label} build to switch to yet. Try again in a few minutes.` });
    } else if (manual) set({ status: 'current', manual: true });
    else if (state.status === 'checking' || state.status === 'error') set({ status: 'idle' });
    settle();
  }
  /** Point electron-updater at a track. Its channel setter also allows downgrades, so allowDowngrade is set after it:
   *  only a track other than the running build's own may offer an older version (T3 Code: "Only leaving the running
   *  build's track can need an older release"). */
  function follow(next: ChannelName): void {
    updater.channel = next;
    updater.allowDowngrade = next !== own;
    updater.allowPrerelease = next === 'nightly';
    if (feed) updater.setFeedURL({ provider: 'generic', url: feed, channel: next });
  }
  function canSwitch(): boolean {
    return state.status !== 'off' && doing !== 'download' && doing !== 'install' && state.status !== 'downloading' && !state.onQuit;
  }
  /** The track switch (T3 Code's setChannel): saved first, so a switch that stops part way keeps the user's choice. */
  function setChannel(next: ChannelName): boolean {
    if (!canSwitch()) return false;
    // A check that runs now would answer for the old track: the switch starts when it ends.
    if (doing === 'check' || doing === 'poll') { queued = next; return true; }
    switchTo(next);
    return true;
  }
  function switchTo(next: ChannelName): void {
    channel = next;
    saveChannel(next);
    follow(next);
    // Back to the running build's own track, nothing reinstalls: picking it again undoes a switch that stopped part way.
    switching = next === own ? null : next;
    set({ status: 'idle' });
    if (switching) { set({ status: 'checking', manual: true, switching }); check({ manual: true }); }
    else check();
  }
  /** After a check ends: a switch asked for while it ran starts now. */
  function settle(): void {
    if (!queued || doing) return;
    const next = queued;
    queued = null;
    switchTo(next);
  }
  function download(): void {
    if (state.status !== 'available' || doing) return;
    doing = 'download';
    set({ status: 'downloading', version: state.version, percent: 0, manual: true });
    Promise.resolve(updater.downloadUpdate()).catch(() => {});
  }
  /** Restart: quit, let Squirrel.Mac put the new app in place, and open it. */
  function install(): void {
    if (state.status !== 'ready') return;
    doing = 'install';
    updater.quitAndInstall();
  }
  /**
   * When I Quit: the user's choice to install on quit. Squirrel.Mac takes the update now and installs it on the next
   * quit. Taking it (copy, unzip, check the signature) needs a moment, so a quit waits for it: see whenStaged.
   */
  function installOnQuit(): void {
    if (state.status !== 'ready' || state.onQuit) return;
    doing = 'install';
    updater.autoInstallOnAppQuit = true;
    staging = new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
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
  function whenStaged(): Promise<boolean> {
    if (!staging) return Promise.resolve(true);
    return Promise.race([staging, new Promise<boolean>((resolve) => timers.setTimeout(() => resolve(false), STAGE_WAIT_MS))]);
  }
  /** Later, Hide or OK: the card goes until something changes. The menu keeps the update. */
  function hide(): void {
    if (['current', 'error', 'checking'].includes(state.status)) set({ status: 'idle' });
    else set({ ...state, manual: false, hidden: true });
  }
  /** An updater error, or an update or a download Yes Chef cannot read. */
  function failed(e: unknown): void {
    const was = doing;
    doing = null;
    log.error?.(`Update ${was || 'check'} failed: ${shortError(e)}`);
    // A switch that fails stops: the saved track stays, and Update Track tries it again.
    if (switching && was !== 'poll') { switching = null; set({ status: 'error', message: shortError(e), manual: true }); settle(); return; }
    // A background check that fails (offline, GitHub busy) stays quiet and tries again in 4 minutes.
    if (was === 'poll' || was === null) { if (state.status === 'checking') set({ status: 'idle' }); settle(); return; }
    set({ status: 'error', message: shortError(e), manual: true });
  }
}

/** The card for a state, unless the user hid it. */
export const visibleCard = (state: UpdateState, ctx: CardContext): Card | null => (state.hidden ? null : cardFor(state, ctx));
