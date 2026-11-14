// The update rules (updates.ts) and the channels and versions (channels.ts), with stand-ins for electron-updater,
// Squirrel.Mac and the clock. The real update, end to end, is the drill in desktop/README.md.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHANNELS, FEED, channelOf, isChannel, compareVersions, isReleaseVersion, nextNightly, tagOf, utcDay } from './channels.ts';
import {
  CHECK_EVERY_MS, FIRST_CHECK_MS, NO_ID, STAGE_WAIT_MS, canUpdateInPlace, cardFor, createUpdates, feedOverride, fileHandoff, menuFor, moveCard, shortError, visibleCard,
} from './updates.ts';
import type { ChannelName } from './channels.ts';
import type { Card, CardContext, Logger, Squirrel, Timers, UpdateState, Updater } from './updates.ts';
import { nth } from '../client/test/expect.ts';

/** x, or the test fails. */
function must<X>(x: X | null | undefined, what = 'a value'): X { assert.ok(x != null, `no ${what}`); return x; }

// electron-updater's MacUpdater, as far as updates.ts uses it: updateDownloaded lives on the prototype. The fields
// updates.ts sets are declared only: a stand-in starts without them, as before the port.
class FakeUpdater extends EventEmitter {
  declare checks: number; declare downloads: number; declare installs: number; declare feed: unknown;
  declare logger: unknown; declare autoDownload: boolean; declare autoInstallOnAppQuit: boolean; declare autoRunAppAfterInstall: boolean;
  declare channel: string | null; declare allowDowngrade: boolean; declare allowPrerelease: boolean;
  declare requestHeaders: Record<string, string> | null;
  constructor() { super(); this.checks = 0; this.downloads = 0; this.installs = 0; this.feed = null; }
  updateDownloaded(_zipFileInfo?: unknown, _event?: unknown): Promise<unknown[]> { throw new Error('the library step must be replaced'); }
  dispatchUpdateDownloaded(event: unknown) { this.emit('update-downloaded', event); }
  checkForUpdates(): Promise<unknown> { this.checks++; return Promise.resolve(null); }
  downloadUpdate() { this.downloads++; return Promise.resolve([]); }
  quitAndInstall() { this.installs++; }
  setFeedURL(options: unknown) { this.feed = options; }
}
// Electron's autoUpdater (Squirrel.Mac): an event emitter that takes a feed and checks it.
class FakeSquirrel extends EventEmitter {
  declare feeds: unknown[]; declare checks: number;
  constructor() { super(); this.feeds = []; this.checks = 0; }
  setFeedURL(o: unknown) { this.feeds.push(o); }
  checkForUpdates() { this.checks++; }
}
const fakeSquirrel = () => new FakeSquirrel();
/** A timer the fake clock holds: its function and its delay. */
type Held = { fn: () => void; ms: number };
function fakeTimers() {
  const t = {
    timeouts: [] as Held[], intervals: [] as Held[],
    setTimeout(fn: () => void, ms: number) { const h = { fn, ms }; t.timeouts.push(h); return h; },
    setInterval(fn: () => void, ms: number) { const h = { fn, ms }; t.intervals.push(h); return h; },
    clearTimeout(h: unknown) { t.timeouts = t.timeouts.filter((x) => x !== h); },
    clearInterval(h: unknown) { t.intervals = t.intervals.filter((x) => x !== h); },
  } satisfies Timers & { timeouts: Held[]; intervals: Held[] };
  return t;
}
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
function setup<U extends EventEmitter = FakeUpdater>({ version = '0.2.0', packaged = true, feed = null as string | null, updater = new FakeUpdater() as unknown as U, log = quiet as Logger, channel = null as ChannelName | null }: {
  version?: string; packaged?: boolean; feed?: string | null; updater?: U; log?: Logger; channel?: ChannelName | null;
} = {}) {
  const squirrel = fakeSquirrel();
  const timers = fakeTimers();
  const seen: UpdateState[] = [];
  const saved: ChannelName[] = [];
  const updates = createUpdates({ updater: updater as unknown as Updater, squirrel: squirrel as unknown as Squirrel, app: { isPackaged: packaged }, version, channel, saveChannel: (c) => saved.push(c), feed, log, timers, onChange: (s) => seen.push(s) });
  return { updates, updater, squirrel, timers, seen, saved };
}
const ctx = { name: 'Yes Chef', current: '0.2.0' };
/** The card the window shows for a state, or the test fails. */
const shown = (state: UpdateState, c: CardContext = ctx): Card => must(visibleCard(state, c), 'card');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the schedule is T3 Code\'s: first check 15 s after start, then every 4 minutes', async () => {
  assert.equal(FIRST_CHECK_MS, 15000);
  assert.equal(CHECK_EVERY_MS, 240000);
  const { updater, timers } = setup();
  assert.equal(updater.checks, 0, 'nothing is checked at start');
  assert.deepEqual(timers.timeouts.map((t) => t.ms), [15000]);
  assert.equal(timers.intervals.length, 0);
  nth(timers.timeouts).fn();
  await tick();
  assert.equal(updater.checks, 1);
  assert.deepEqual(timers.intervals.map((t) => t.ms), [240000]);
  updater.emit('update-not-available', { version: '0.2.0' });
  nth(timers.intervals).fn();
  await tick();
  assert.equal(updater.checks, 2);
});

test('a check that ends with no event does not block the next one', async () => {
  const { updates, updater, timers } = setup();
  nth(timers.timeouts).fn();
  // Still running: the next poll waits for it.
  nth(timers.intervals).fn();
  await tick();
  assert.equal(updater.checks, 1);
  // It ended (the fake's promise settled) without an event.
  nth(timers.intervals).fn();
  await tick();
  assert.equal(updater.checks, 2);
  // A check by hand that ends with no event leaves no "Checking" card behind.
  await tick();
  updates.act('check');
  updater.emit('checking-for-update');
  assert.equal(updates.state.status, 'checking');
  await tick();
  assert.equal(updates.state.status, 'idle');
});

test('stop clears the schedule', () => {
  const { updates, timers } = setup();
  nth(timers.timeouts).fn();
  updates.stop();
  assert.equal(timers.timeouts.length, 0);
  assert.equal(timers.intervals.length, 0);
});

test('nothing downloads or installs on its own, and the feed gets no per-install ID', () => {
  const { updater } = setup();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  assert.deepEqual(updater.requestHeaders, { 'x-user-staging-id': NO_ID });
  assert.equal(updater.feed, null, 'the GitHub feed in app-update.yml stays');
});

test('the version picks the channel: Stable takes only releases, Nightly only Nightly builds', () => {
  const stable = setup({ version: '0.2.0' });
  assert.equal(stable.updates.channel, 'latest');
  assert.equal(stable.updater.channel, 'latest');
  assert.equal(stable.updater.allowPrerelease, false);
  const nightly = setup({ version: '0.2.1-nightly.20261110.1' });
  assert.equal(nightly.updates.channel, 'nightly');
  assert.equal(nightly.updater.channel, 'nightly');
  assert.equal(nightly.updater.allowPrerelease, true);
  // The channel setter allows downgrades; it must be turned off after it.
  assert.equal(nightly.updater.allowDowngrade, false);
});

test('a test feed on this Mac replaces the GitHub feed, for the same channel', () => {
  const { updater } = setup({ version: '0.2.1-nightly.20261110.1', feed: 'http://127.0.0.1:8765/' });
  assert.deepEqual(updater.feed, { provider: 'generic', url: 'http://127.0.0.1:8765/', channel: 'nightly' });
});

test('a copy that is not built, or an updater without the file handoff, turns updates off and schedules nothing', () => {
  const dev = setup({ packaged: false });
  assert.equal(dev.updates.state.status, 'off');
  assert.equal(dev.timers.timeouts.length, 0);
  assert.equal(dev.updater.autoDownload, undefined, 'the updater is left alone');
  class NoStep extends EventEmitter { checkForUpdates() {} }
  const old = setup({ updater: new NoStep() });
  assert.equal(old.updates.state.status, 'off');
  assert.match(must(old.updates.state.message), /port/);
  assert.equal(old.timers.timeouts.length, 0);
  old.updates.check({ manual: true });
  assert.equal(old.updates.state.status, 'off');
  assert.deepEqual(menuFor(old.updates.state, ctx), [{ label: 'Check for Updates…', enabled: false, toolTip: old.updates.state.message }]);
});

test('an update found in the background is offered; the download waits for the user', () => {
  const { updates, updater, timers } = setup();
  nth(timers.timeouts).fn();
  updater.emit('checking-for-update');
  assert.equal(updates.state.status, 'idle', 'a background check shows no card');
  updater.emit('update-available', { version: '0.2.1' });
  assert.equal(updates.state.status, 'available');
  assert.equal(updater.downloads, 0);
  assert.deepEqual(shown(updates.state).buttons.map((b) => b.id), ['later', 'download']);
  updates.act('download');
  assert.equal(updater.downloads, 1);
  assert.equal(updates.state.status, 'downloading');
  updater.emit('download-progress', { percent: 41.7 });
  assert.equal(updates.state.percent, 41);
  assert.equal(shown(updates.state).body, '41%');
  updater.emit('update-downloaded', { version: '0.2.1' });
  assert.equal(updates.state.status, 'ready');
  assert.equal(updater.installs, 0, 'nothing installs until the user picks Restart');
  assert.deepEqual(shown(updates.state).buttons.map((b) => b.id), ['on-quit', 'restart']);
  updates.act('restart');
  assert.equal(updater.installs, 1);
});

test('When I Quit is the only way install on quit turns on', () => {
  const { updates, updater, squirrel, timers } = setup();
  nth(timers.timeouts).fn();
  updater.emit('update-available', { version: '0.2.1' });
  updates.download();
  updater.emit('update-downloaded', { version: '0.2.1' });
  assert.equal(updater.autoInstallOnAppQuit, false);
  updates.act('on-quit');
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(squirrel.checks, 1, 'Squirrel.Mac takes the update now, to install it on quit');
  assert.equal(updates.state.onQuit, true);
  assert.equal(visibleCard(updates.state, ctx), null);
  assert.deepEqual(menuFor(updates.state, ctx).map((i) => [i.label, i.enabled !== false]),
    [['Restart to Update Yes Chef', true], ['Updates When Yes Chef Quits', false]]);
  updates.act('on-quit');
  assert.equal(squirrel.checks, 1, 'a second click does nothing');
});

test('background checks stay quiet on errors and skip while a download runs or an update waits', () => {
  const { updates, updater, timers } = setup();
  nth(timers.timeouts).fn();
  updater.emit('error', new Error('getaddrinfo ENOTFOUND github.com'));
  assert.equal(updates.state.status, 'idle');
  assert.equal(visibleCard(updates.state, ctx), null);
  nth(timers.intervals).fn();
  updater.emit('update-available', { version: '0.2.1' });
  updates.download();
  const before = updater.checks;
  nth(timers.intervals).fn();
  assert.equal(updater.checks, before, 'no check while downloading');
  updater.emit('update-downloaded', { version: '0.2.1' });
  nth(timers.intervals).fn();
  assert.equal(updater.checks, before, 'no check while an update waits for its restart');
});

test('a check by hand says what it found, errors included', () => {
  const { updates, updater } = setup();
  updates.act('check');
  updater.emit('checking-for-update');
  assert.equal(shown(updates.state).title, 'Checking for updates…');
  updater.emit('update-not-available', { version: '0.2.0' });
  assert.deepEqual([shown(updates.state).title, shown(updates.state).body],
    ['Yes Chef is up to date', 'You have 0.2.0, the newest Stable version.']);
  updates.act('ok');
  assert.equal(updates.state.status, 'idle');
  updates.act('check');
  updater.emit('error', new Error('HttpError: 404 Not Found\n"method: GET url: https://github.com/..."'));
  const card = shown(updates.state);
  assert.equal(card.title, 'Could not update Yes Chef');
  assert.equal(card.body, 'HttpError: 404 Not Found');
  updates.act('ok');
  assert.equal(visibleCard(updates.state, ctx), null);
});

test('a failed download or install shows its error', () => {
  const { updates, updater } = setup();
  updater.emit('update-available', { version: '0.2.1' });
  updates.download();
  updater.emit('error', new Error('sha512 checksum mismatch'));
  assert.equal(updates.state.status, 'error');
  assert.equal(shown(updates.state).body, 'sha512 checksum mismatch');
});

// What electron-updater sends with its events crosses a Schema, as in T3 Code (DesktopUpdates.ts, UpdateInfo and
// DownloadProgressInfo). An event Yes Chef cannot read is never acted on as a guess.
const UNREADABLE = 'The update server sent an answer Yes Chef cannot read.';
function logged() {
  const lines: { warn: string[]; error: string[] } = { warn: [], error: [] };
  return { lines, log: { ...quiet, warn: (l: string) => lines.warn.push(l), error: (l: string) => lines.error.push(l) } };
}

test('a download progress tick Yes Chef cannot read keeps the bar where it was', () => {
  const { lines, log } = logged();
  const { updates, updater } = setup({ log });
  updater.emit('update-available', { version: '0.2.1' });
  updates.download();
  updater.emit('download-progress', { percent: 41.7 });
  for (const tick of [{ percent: 'abc' }, { percent: '55' }, { percent: Number.NaN }, {}, null]) {
    updater.emit('download-progress', tick);
    assert.deepEqual([updates.state.status, updates.state.percent], ['downloading', 41], JSON.stringify(tick));
  }
  assert.equal(shown(updates.state).body, '41%');
  assert.equal(lines.warn.length, 5, 'each unread tick is logged');
  updater.emit('download-progress', { percent: 63.2 });
  assert.equal(updates.state.percent, 63);
});

test('an update without a version Yes Chef can read is never offered', async () => {
  for (const info of [{}, { version: 5 }, null, 'v0.2.1']) {
    const { lines, log } = logged();
    const { updates, updater, timers } = setup({ log });
    // By hand: the check answers with its error, not with "Yes Chef undefined is available".
    updates.act('check');
    updater.emit('update-available', info);
    assert.equal(updates.state.status, 'error', JSON.stringify(info));
    assert.deepEqual([shown(updates.state).title, shown(updates.state).body], ['Could not update Yes Chef', UNREADABLE]);
    updates.act('ok');
    await tick();
    // In the background: nothing is shown, the line is logged, and the next check runs as usual.
    nth(timers.timeouts).fn();
    updater.emit('update-available', info);
    assert.equal(updates.state.status, 'idle', JSON.stringify(info));
    assert.equal(visibleCard(updates.state, ctx), null);
    assert.equal(lines.error.length, 2);
    await tick();
    const before = updater.checks;
    nth(timers.intervals).fn();
    await tick();
    assert.equal(updater.checks, before + 1, 'the next background check runs');
  }
});

test('a download whose version Yes Chef cannot read is not ready on a guess', () => {
  for (const info of [null, {}, { version: 2 }]) {
    const { updates, updater } = setup();
    updater.emit('update-available', { version: '0.2.1' });
    updates.download();
    updater.emit('update-downloaded', info);
    assert.equal(updates.state.status, 'error', JSON.stringify(info));
    assert.equal(shown(updates.state).body, UNREADABLE);
    assert.equal(updater.installs, 0);
  }
  // The version the download names is the one the card shows.
  const { updates, updater } = setup();
  updater.emit('update-available', { version: '0.2.1' });
  updates.download();
  updater.emit('update-downloaded', { version: '0.2.2' });
  assert.deepEqual([updates.state.status, updates.state.version], ['ready', '0.2.2']);
});

test('Later hides the card until something changes; a check by hand brings it back', () => {
  const { updates, updater, timers } = setup();
  nth(timers.timeouts).fn();
  updater.emit('update-available', { version: '0.2.1' });
  updates.act('later');
  assert.equal(visibleCard(updates.state, ctx), null);
  assert.deepEqual(menuFor(updates.state, ctx), [{ id: 'download', label: 'Download Yes Chef 0.2.1' }], 'the menu keeps it');
  // The next background check finds the same version: the card stays hidden.
  nth(timers.intervals).fn();
  updater.emit('update-available', { version: '0.2.1' });
  assert.equal(visibleCard(updates.state, ctx), null);
  // A newer one shows again.
  nth(timers.intervals).fn();
  updater.emit('update-available', { version: '0.2.2' });
  assert.equal(shown(updates.state).title, 'Yes Chef 0.2.2 is available');
  updates.act('later');
  updates.act('check');
  assert.equal(shown(updates.state).title, 'Yes Chef 0.2.2 is available');
});

test('the file handoff gives Squirrel.Mac a feed on disk, never a port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yc-handoff-'));
  try {
    const updater = new FakeUpdater();
    const squirrel = fakeSquirrel();
    assert.equal(fileHandoff(updater, squirrel), true);
    const zip = join(dir, 'Yes-Chef-0.2.1-arm64.zip');
    const seen: unknown[] = [];
    updater.on('update-downloaded', (e) => seen.push(e));
    const event = { downloadedFile: zip, version: '0.2.1' };
    assert.deepEqual(await updater.updateDownloaded({ url: new URL('https://example.invalid/x.zip') }, event), []);
    const feed = join(dir, 'squirrel-feed.json');
    assert.deepEqual(JSON.parse(readFileSync(feed, 'utf8')), { url: pathToFileURL(zip).href });
    assert.equal(statSync(feed).mode & 0o777, 0o600);
    assert.deepEqual(squirrel.feeds, [{ url: pathToFileURL(feed).href }]);
    assert.deepEqual(seen, [event]);
    assert.equal(squirrel.checks, 0, 'Squirrel.Mac waits for Restart or When I Quit');
    updater.autoInstallOnAppQuit = true;
    await updater.updateDownloaded({}, event);
    assert.equal(squirrel.checks, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file handoff replaces the step electron-updater 6.8.9 really has', async () => {
  // If an upgrade renames or drops MacUpdater.updateDownloaded, this fails before a build ships a port.
  const source = readFileSync(new URL('./node_modules/electron-updater/out/MacUpdater.js', import.meta.url), 'utf8');
  assert.match(source, /async updateDownloaded\(zipFileInfo, event\) \{/);
  assert.match(source, /return this\.updateDownloaded\(zipFileInfo, event\);/);
  assert.equal(JSON.parse(readFileSync(new URL('./node_modules/electron-updater/package.json', import.meta.url), 'utf8')).version, '6.8.9');
});

test('the test feed must be http on this Mac', () => {
  assert.equal(feedOverride('http://127.0.0.1:8765'), 'http://127.0.0.1:8765/');
  assert.equal(feedOverride('http://localhost:8765/feed/'), 'http://localhost:8765/feed/');
  for (const bad of ['', undefined, 'https://127.0.0.1:8765/', 'http://0.0.0.0:8765/', 'http://192.168.1.2/', 'http://example.com/',
    'http://user:pw@127.0.0.1/', 'file:///tmp/feed/', 'not a url', 'http://127.0.0.1.example.com/']) {
    assert.equal(feedOverride(bad), null, String(bad));
  }
});

test('Squirrel.Mac can replace a copy in Applications or a home folder, not one on a disk image or translocated', () => {
  assert.equal(canUpdateInPlace('/Applications/Yes Chef.app/Contents/MacOS/Yes Chef'), true);
  assert.equal(canUpdateInPlace('/Users/someone/Downloads/Yes Chef.app/Contents/MacOS/Yes Chef'), true);
  assert.equal(canUpdateInPlace('/Volumes/Yes Chef 0.2.0/Yes Chef.app/Contents/MacOS/Yes Chef'), false);
  assert.equal(canUpdateInPlace('/private/var/folders/xy/T/AppTranslocation/1234/d/Yes Chef.app/Contents/MacOS/Yes Chef'), false);
});

test('a copy outside Applications is offered the move instead of a download', () => {
  const card = must(cardFor({ status: 'available', version: '0.2.1' }, { ...ctx, inPlace: false }));
  assert.match(card.body, /only from Applications/);
  assert.deepEqual(card.buttons.map((b) => b.id), ['later', 'move']);
  assert.deepEqual(menuFor({ status: 'available', version: '0.2.1' }, { ...ctx, inPlace: false }), [{ id: 'move', label: 'Move to Applications to Update' }]);
  assert.deepEqual(moveCard('Yes Chef').buttons.map((b) => [b.id, b.label]), [['stay', 'Not Now'], ['move', 'Move']]);
  assert.equal(moveCard('Yes Chef').title, 'Move Yes Chef to Applications?');
});

test('the cards name the channel the app is on', () => {
  const nightly = { name: 'Yes Chef', current: '0.2.1-nightly.20261110.1' };
  assert.equal(must(cardFor({ status: 'current', manual: true }, nightly)).body, 'You have 0.2.1-nightly.20261110.1, the newest Nightly version.');
  assert.equal(must(cardFor({ status: 'ready', version: '0.2.1-nightly.20261110.2' }, nightly)).title, 'Yes Chef 0.2.1-nightly.20261110.2 is ready');
  // Background results show no card; only a check by hand does.
  assert.equal(cardFor({ status: 'current' }, nightly), null);
  assert.equal(cardFor({ status: 'error', message: 'x' }, nightly), null);
  assert.equal(cardFor({ status: 'idle' }, nightly), null);
});

test('the menu follows the state', () => {
  assert.deepEqual(menuFor({ status: 'idle' }, ctx), [{ id: 'check', label: 'Check for Updates…' }]);
  assert.deepEqual(menuFor({ status: 'checking' }, ctx), [{ label: 'Checking for Updates…', enabled: false }]);
  assert.deepEqual(menuFor({ status: 'downloading', version: '0.2.1', percent: 7 }, ctx), [{ label: 'Downloading Yes Chef 0.2.1 (7%)', enabled: false }]);
  assert.deepEqual(menuFor({ status: 'ready', version: '0.2.1' }, ctx).map((i) => i.id), ['restart', 'on-quit']);
});

test('errors become one short line', () => {
  assert.equal(shortError(new Error('net::ERR_INTERNET_DISCONNECTED')), 'No connection to the update server. Try again later.');
  assert.equal(shortError(new Error('connect ECONNREFUSED 127.0.0.1:8765')), 'No connection to the update server. Try again later.');
  assert.equal(shortError('x'.repeat(200)).length, 160);
  assert.equal(shortError(null), 'unknown error');
});

test('Stable and Nightly are one app, as in T3 Code: only the icon differs', () => {
  const [s, n] = [CHANNELS.latest, CHANNELS.nightly];
  for (const key of ['name', 'appId', 'pkg'] as const) assert.equal(s[key], n[key], key);
  assert.notEqual(s.icon, n.icon);
  assert.equal(s.name, 'Yes Chef');
  assert.equal(s.appId, 'codes.yeschef.desktop', 'both keep the bundle ID the installed app has, so Squirrel.Mac lets one replace the other');
  assert.deepEqual(FEED, { provider: 'github', owner: 'ddmirolli', repo: 'yeschef' });
  assert.ok(isChannel('latest') && isChannel('nightly'));
  for (const v of ['stable', 'Nightly', '', null, 1]) assert.equal(isChannel(v), false, String(v));
});

// The track switch, as T3 Code's (apps/desktop/src/updates/DesktopUpdates.ts setChannel; Dan, 2026-11-14).
test('the saved track wins over the build\'s own, and only leaving the build\'s own track allows an older version', () => {
  const { updates, updater } = setup({ version: '0.2.4-nightly.20261114.1', channel: 'latest' });
  assert.equal(updates.channel, 'latest');
  assert.equal(updater.channel, 'latest');
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, true, 'a Nightly build on the Stable track takes the older Stable');
  const own = setup({ version: '0.2.3', channel: 'latest' });
  assert.equal(own.updater.allowDowngrade, false);
});

test('switching track saves it, checks the other track, downloads its newest build and restarts into it', async () => {
  const { updates, updater, saved } = setup({ version: '0.2.3' });
  assert.equal(updates.canSwitch(), true);
  assert.equal(updates.setChannel('nightly'), true);
  assert.deepEqual(saved, ['nightly']);
  assert.equal(updates.channel, 'nightly');
  assert.equal(updater.channel, 'nightly');
  assert.equal(updater.allowPrerelease, true);
  assert.equal(updater.allowDowngrade, true);
  assert.equal(updates.state.status, 'checking');
  assert.equal(shown(updates.state).title, 'Switching to Nightly…');
  // The fake's check ends at once, so its events come before the tick, as electron-updater's come before its promise.
  updater.emit('update-available', { version: '0.2.4-nightly.20261114.1' });
  await tick();
  assert.equal(updater.checks, 1);
  assert.equal(updater.downloads, 1, 'a switch downloads without a second click');
  assert.equal(updates.canSwitch(), false, 'no second switch while one downloads');
  assert.equal(updates.setChannel('latest'), false);
  updater.emit('update-downloaded', { version: '0.2.4-nightly.20261114.1' });
  assert.equal(updater.installs, 1, 'a switch restarts into the build it downloaded');
});

test('back to Stable from a Nightly build takes the older Stable', async () => {
  const { updates, updater } = setup({ version: '0.2.4-nightly.20261114.1' });
  updates.setChannel('latest');
  assert.equal(updater.allowDowngrade, true);
  assert.equal(updater.allowPrerelease, false);
  updater.emit('update-available', { version: '0.2.3' });
  updater.emit('update-downloaded', { version: '0.2.3' });
  assert.equal(updater.installs, 1);
});

test('a switch with no build on the other track says so and keeps the choice', async () => {
  const { updates, updater, saved } = setup({ version: '0.2.3' });
  updates.setChannel('nightly');
  updater.emit('update-not-available', { version: '0.2.3' });
  assert.equal(updates.state.status, 'error');
  assert.equal(shown(updates.state).body, 'There is no Nightly build to switch to yet. Try again in a few minutes.');
  assert.deepEqual(saved, ['nightly']);
  assert.equal(updater.downloads, 0);
});

test('a switch that fails stops with its error; picking the own track again reinstalls nothing', async () => {
  const { updates, updater, saved } = setup({ version: '0.2.3' });
  updates.setChannel('nightly');
  updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  assert.equal(updates.state.status, 'error');
  assert.equal(updates.state.manual, true);
  updates.setChannel('latest');
  assert.deepEqual(saved, ['nightly', 'latest']);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updates.state.status, 'idle', 'the own track is a quiet check, no card');
  await tick();
  updater.emit('update-not-available', { version: '0.2.3' });
  assert.equal(updates.state.status, 'idle');
  assert.equal(updater.downloads + updater.installs, 0);
});

test('only a build of the saved track is offered or installed', async () => {
  const { updates, updater } = setup({ version: '0.2.3', channel: 'nightly' });
  updates.check({ manual: true });
  updater.emit('update-available', { version: '0.2.4' });
  assert.equal(updates.state.status, 'current', 'a Stable release on the Nightly track is no update');
  const other = setup({ version: '0.2.3' });
  other.updates.setChannel('nightly');
  other.updater.emit('update-available', { version: '0.2.4-nightly.20261114.1' });
  other.updater.emit('update-downloaded', { version: '0.2.4' });
  assert.equal(other.updater.installs, 0);
  assert.match(must(other.updates.state.message), /not a Nightly build\. Nothing was installed\./);
});

test('a switch asked for during a background check starts when that check ends', async () => {
  const updater = new FakeUpdater();
  let end = () => {};
  updater.checkForUpdates = function () { this.checks++; return new Promise((r) => { end = () => r(null); }); };
  const { updates, timers } = setup({ version: '0.2.3', updater });
  nth(timers.timeouts).fn();
  await tick();
  assert.equal(updater.checks, 1);
  assert.equal(updates.setChannel('nightly'), true);
  assert.equal(updates.channel, 'latest', 'the running check answers for Stable');
  updater.emit('update-not-available', { version: '0.2.3' });
  assert.equal(updates.channel, 'nightly');
  end();
  await tick(); await tick();
  assert.equal(updater.checks, 2);
  assert.equal(updates.state.status, 'checking');
});

test('a switch whose check ends with no answer stops, and a later check does not download for it', async () => {
  const { updates, updater } = setup({ version: '0.2.3' });
  updates.setChannel('nightly');
  await tick();
  assert.equal(updates.state.status, 'idle');
  updates.check();
  updater.emit('update-available', { version: '0.2.4-nightly.20261114.1' });
  assert.equal(updates.state.status, 'available');
  assert.equal(updater.downloads, 0);
});

test('no switch while an update waits for the quit, or while updates are off', () => {
  const { updates, updater } = setup({ version: '0.2.3' });
  updates.check({ manual: true });
  updater.emit('update-available', { version: '0.2.4' });
  updates.download();
  updater.emit('update-downloaded', { version: '0.2.4' });
  updates.installOnQuit();
  assert.equal(updates.canSwitch(), false);
  const off = setup({ packaged: false });
  assert.equal(off.updates.canSwitch(), false);
});

test('the up-to-date card names the saved track', () => {
  assert.equal(must(cardFor({ status: 'current', manual: true }, { ...ctx, channel: 'nightly' })).body, 'You have 0.2.0, the newest Nightly version.');
});

test('versions: the two release forms only, and the channel each names', () => {
  for (const v of ['0.2.0', '1.10.3', '0.2.1-nightly.20261110.1', '0.2.1-nightly.20261231.12']) assert.equal(isReleaseVersion(v), true, v);
  for (const v of ['v0.2.0', '0.2', '0.2.0-beta.1', '0.2.1-nightly.2026111.1', '0.2.1-nightly.20261110.0', '0.2.1-nightly.20261110', '0.2.0 ', '']) {
    assert.equal(isReleaseVersion(v), false, JSON.stringify(v));
  }
  assert.equal(channelOf('0.2.0'), 'latest');
  assert.equal(channelOf('0.2.1-nightly.20261110.1'), 'nightly');
  assert.equal(channelOf('0.1.0'), 'latest', 'a local build is Stable');
  assert.equal(tagOf('0.2.1-nightly.20261110.1'), 'v0.2.1-nightly.20261110.1');
});

test('versions sort as semver does for these forms', () => {
  const sorted = ['0.2.1', '0.2.1-nightly.20261111.1', '0.2.0', '0.2.1-nightly.20261110.2', '0.10.0', '0.2.1-nightly.20261110.10']
    .sort(compareVersions);
  assert.deepEqual(sorted, ['0.2.0', '0.2.1-nightly.20261110.2', '0.2.1-nightly.20261110.10', '0.2.1-nightly.20261111.1', '0.2.1', '0.10.0']);
  assert.throws(() => compareVersions('0.2.0', 'v0.2.0'), /not a release version/);
});

test('the next Nightly builds on the patch after the newest Stable, numbered by UTC day', () => {
  const date = new Date('2026-11-10T23:30:00-05:00'); // 04:30 UTC on 11 November
  assert.equal(utcDay(date), '20261111');
  assert.equal(nextNightly({ stable: ['0.1.0'], date }), '0.1.1-nightly.20261111.1');
  assert.equal(nextNightly({ stable: ['0.1.0', '0.2.0', 'garbage'], date }), '0.2.1-nightly.20261111.1');
  const taken = ['v0.2.1-nightly.20261111.1', 'v0.2.1-nightly.20261111.2', 'v0.2.1-nightly.20261110.7', 'v0.2.0', 'v0.3.1-nightly.20261111.9'];
  assert.equal(nextNightly({ stable: ['0.2.0'], taken, date }), '0.2.1-nightly.20261111.3');
  assert.throws(() => nextNightly({ stable: [], date }), /no stable version/);
});

// When I Quit, then a quit: the quit waits until Squirrel.Mac has the update (PR-Agent r2 on #66).
function readyForQuit() {
  const t = setup();
  nth(t.timers.timeouts).fn();
  t.updater.emit('update-available', { version: '0.2.1' });
  t.updates.download();
  t.updater.emit('update-downloaded', { version: '0.2.1' });
  return t;
}
const settled = async (promise: Promise<unknown>) => { let out: unknown = 'pending'; promise.then((v) => { out = v; }); await tick(); return out; };

test('without When I Quit, a quit goes on at once', async () => {
  const { updates } = readyForQuit();
  assert.equal(await settled(updates.whenStaged()), true);
});

test('after When I Quit, a quit waits until Squirrel.Mac has the update', async () => {
  const { updates, squirrel } = readyForQuit();
  updates.act('on-quit');
  const quit = updates.whenStaged();
  assert.equal(await settled(quit), 'pending', 'Squirrel.Mac is still taking the update');
  squirrel.emit('update-downloaded');
  assert.equal(await settled(quit), true);
  assert.equal(await settled(updates.whenStaged()), true, 'a later quit does not wait again');
  assert.equal(squirrel.listenerCount('update-downloaded') + squirrel.listenerCount('error'), 0, 'no listener is left behind');
});

test('a quit after When I Quit goes on when Squirrel.Mac fails or takes too long', async () => {
  const failing = readyForQuit();
  failing.updates.act('on-quit');
  const quit = failing.updates.whenStaged();
  failing.squirrel.emit('error', new Error('code signature did not match'));
  assert.equal(await settled(quit), false);
  assert.equal(failing.updater.autoInstallOnAppQuit, false, 'install on quit is off again');

  const slow = readyForQuit();
  slow.updates.act('on-quit');
  const waiting = slow.updates.whenStaged();
  const limit = slow.timers.timeouts.find((t) => t.ms === STAGE_WAIT_MS);
  assert.ok(limit, `the wait is capped at ${STAGE_WAIT_MS} ms`);
  assert.equal(await settled(waiting), 'pending');
  limit.fn();
  assert.equal(await settled(waiting), false);
});

// A check that runs until the test ends it, as a slow or stalled network does.
class SlowUpdater extends FakeUpdater {
  declare finish: () => void;
  override checkForUpdates(): Promise<unknown> { this.checks++; return new Promise((resolve) => { this.finish = () => resolve(null); }); }
}
async function pollRunning() {
  const t = setup({ updater: new SlowUpdater() });
  nth(t.timers.timeouts).fn();
  await tick();
  assert.equal(t.updater.checks, 1, 'the background check is running');
  t.updates.act('check');
  assert.equal(t.updater.checks, 1, 'no second check: the one running is taken over');
  assert.equal(shown(t.updates.state).id, 'checking');
  return t;
}

test('a check by hand during a background check takes it over and shows its result', async () => {
  const { updates, updater } = await pollRunning();
  updater.emit('update-not-available', { version: '0.2.0' });
  assert.equal(shown(updates.state).id, 'current');
  updater.finish();
  await tick();
  assert.equal(updates.state.status, 'current', 'the end of the check keeps its result');

  const failed = await pollRunning();
  failed.updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  assert.equal(shown(failed.updates.state).id, 'error', 'its error is shown, not kept quiet as a background one');

  const silent = await pollRunning();
  silent.updater.finish();
  await tick();
  assert.equal(silent.updates.state.status, 'idle', 'a check that ends with no event clears the checking card');
  silent.updates.act('check');
  await tick();
  assert.equal(silent.updater.checks, 2, 'and the next check runs');
});

test('while an update is offered, background checks wait, so Download always starts (PR-Agent r3 on #66)', async () => {
  const { updates, updater, timers } = setup({ updater: new SlowUpdater() });
  nth(timers.timeouts).fn();
  await tick();
  updater.emit('update-available', { version: '0.2.1' });
  updater.finish();
  await tick();
  nth(timers.intervals).fn();
  await tick();
  assert.equal(updater.checks, 1, 'no background check runs under the offer');
  updates.act('download');
  assert.equal(updater.downloads, 1, 'Download starts at once');
  assert.equal(updates.state.status, 'downloading');
});
