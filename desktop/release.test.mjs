// The release build's rules (build/release.mjs): which certificate signs, which fuses ship, and the feed rewrite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FUSES, FUSE_WIRE, TEAM_ID, appUpdateProblems, checkApp, checkDmg, entitlementKeys, feedProblems, fuseProblems, identities, literalPattern, machOFiles, pickIdentity, resultLine, rewriteFeed, runningFrom, targetsFor, topLevel, writesAppUpdate } from './build/release.mjs';
import { assetProblems, changelogEntry, ghArgs, newestNightly, nightlyDue, parseArgs, pickRelease, releaseFiles, releaseNotes, releaseTitle, settle } from './build/publish.mjs';

const DEV = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const DEVID = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const OTHER = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const SELF = 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
const listing = (...lines) => `  ${lines.map((l, i) => `${i + 1}) ${l}`).join('\n  ')}\n     ${lines.length} valid identities found\n`;
const dev = `${DEV} "Apple Development: someone@example.com (ABCDE12345)"`;
const devId = `${DEVID} "Developer ID Application: Someone (${TEAM_ID})"`;
const otherTeam = `${OTHER} "Developer ID Application: Someone Else (ZZZZZZZZZZ)"`;
const selfSigned = `${SELF} "Yes Chef Local"`;
const teams = { [DEV]: TEAM_ID, [DEVID]: TEAM_ID, [OTHER]: 'ZZZZZZZZZZ', [SELF]: null };
const teamOf = (hash) => teams[hash];

test('identities keeps Developer ID Application and Apple Development only', () => {
  assert.deepEqual(identities(listing(dev, selfSigned, devId)).map((i) => i.kind), ['development', 'developer-id']);
});

test('a build for this Mac prefers Developer ID, then Apple Development, from our team only', () => {
  assert.equal(pickIdentity(listing(dev, devId), { teamOf }).hash, DEVID);
  assert.equal(pickIdentity(listing(dev), { teamOf }).hash, DEV);
  // Another team's Developer ID never signs: the Keychain would stop trusting Yes Chef.
  assert.equal(pickIdentity(listing(otherTeam, dev), { teamOf }).hash, DEV);
  assert.equal(pickIdentity(listing(selfSigned), { teamOf }), null);
});

test('a release takes only Developer ID Application from our team', () => {
  assert.equal(pickIdentity(listing(dev, devId), { release: true, teamOf }).hash, DEVID);
  assert.equal(pickIdentity(listing(dev), { release: true, teamOf }), null);
  assert.equal(pickIdentity(listing(otherTeam), { release: true, teamOf }), null);
});

test('YESCHEF_SIGN_IDENTITY narrows the choice and cannot pick another team', () => {
  assert.equal(pickIdentity(listing(dev, devId), { want: DEV.toLowerCase(), teamOf }).hash, DEV);
  assert.equal(pickIdentity(listing(dev, devId), { want: 'Apple Development', teamOf }).hash, DEV);
  assert.equal(pickIdentity(listing(otherTeam), { want: OTHER, teamOf }), null);
  assert.equal(pickIdentity(listing(dev), { want: 'Apple Development', release: true, teamOf }), null);
});

test('the fuse settings and the wire check agree', () => {
  const index = { runAsNode: 0, enableCookieEncryption: 1, enableNodeOptionsEnvironmentVariable: 2, enableNodeCliInspectArguments: 3,
    enableEmbeddedAsarIntegrityValidation: 4, onlyLoadAppFromAsar: 5, grantFileProtocolExtraPrivileges: 7 };
  assert.deepEqual(Object.keys(FUSES).sort(), Object.keys(index).sort());
  for (const [name, on] of Object.entries(FUSES)) assert.equal(FUSE_WIRE[index[name]], on ? 49 : 48, name);
  // RunAsNode stays off above all: it would let anyone run the signed binary as Node.
  assert.equal(FUSES.runAsNode, false);
});

test('fuseProblems names each fuse that is wrong', () => {
  const stock = { 0: 49, 1: 48, 2: 49, 3: 49, 4: 48, 5: 48, 6: 48, 7: 49, 8: 49, version: '1' };
  assert.equal(fuseProblems(stock).length, 7);
  assert.match(fuseProblems(stock)[0], /^RunAsNode is on, should be off$/);
  assert.deepEqual(fuseProblems({ ...stock, ...FUSE_WIRE }), []);
});

// electron-builder 26.16.1's latest-mac.yml, as a dry run wrote it (2026-11-09).
const FEED = `version: 0.1.0
files:
  - url: Yes-Chef-0.1.0-arm64.zip
    sha512: ZIPSUM==
    size: 116320257
  - url: Yes-Chef-0.1.0-arm64.dmg
    sha512: OLDDMG==
    size: 120342277
path: Yes-Chef-0.1.0-arm64.zip
sha512: ZIPSUM==
releaseDate: '2026-11-09T23:16:51.850Z'
`;

test('rewriteFeed changes only the DMG entry', () => {
  const out = rewriteFeed(FEED, 'Yes-Chef-0.1.0-arm64.dmg', { sha512: 'NEWDMG==', size: 120400000 });
  assert.equal(out, FEED.replace('OLDDMG==', 'NEWDMG==').replace('size: 120342277', 'size: 120400000'));
  // The ZIP, which the updater downloads, and the top-level entry for it are untouched.
  assert.match(out, /^path: Yes-Chef-0\.1\.0-arm64\.zip\nsha512: ZIPSUM==$/m);
});

test('rewriteFeed updates the top-level sha512 when the first file is the one rewritten', () => {
  const out = rewriteFeed(FEED, 'Yes-Chef-0.1.0-arm64.zip', { sha512: 'NEWZIP==', size: 1 });
  assert.equal((out.match(/NEWZIP==/g) || []).length, 2);
  assert.doesNotMatch(out, /ZIPSUM/);
});

test('rewriteFeed refuses a file the feed does not list, or an entry without both fields', () => {
  assert.throws(() => rewriteFeed(FEED, 'Yes-Chef-0.2.0-arm64.dmg', { sha512: 'X', size: 1 }), /lists no/);
  assert.throws(() => rewriteFeed(FEED.replace('    size: 120342277\n', ''), 'Yes-Chef-0.1.0-arm64.dmg', { sha512: 'X', size: 1 }), /needs one sha512 and one size/);
});

test('machOFiles finds Mach-O files by their magic number and skips symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yeschef-macho-'));
  try {
    mkdirSync(join(dir, 'A', 'MacOS'), { recursive: true });
    writeFileSync(join(dir, 'A', 'MacOS', 'Helper'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])); // 64-bit Mach-O
    writeFileSync(join(dir, 'A', 'lib.dylib'), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])); // universal
    writeFileSync(join(dir, 'A', 'notes.txt'), 'not code');
    writeFileSync(join(dir, 'tiny'), 'ab');
    symlinkSync('A', join(dir, 'Current'));
    assert.deepEqual(machOFiles(dir).map((p) => p.slice(dir.length + 1)).sort(), ['A/MacOS/Helper', 'A/lib.dylib']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('entitlementKeys reads every key in codesign\'s XML', () => {
  const xml = '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>';
  assert.deepEqual(entitlementKeys(xml), ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation']);
  assert.deepEqual(entitlementKeys(''), []);
});

// electron-builder 26.16.1's app-update.yml, as the 0.0.8 dry run wrote it (2026-11-10).
const APP_UPDATE = `owner: ddmirolli
repo: yeschef
provider: github
channel: latest
releaseType: release
updaterCacheDirName: yeschef-desktop-updater
`;
const STABLE_BUILD = { feed: { provider: 'github', owner: 'ddmirolli', repo: 'yeschef' }, pkg: 'yeschef-desktop', channel: 'latest' };

test('topLevel reads electron-builder\'s simple YAML', () => {
  assert.deepEqual(topLevel(APP_UPDATE).updaterCacheDirName, 'yeschef-desktop-updater');
  assert.equal(topLevel(FEED).releaseDate, '2026-11-09T23:16:51.850Z');
  assert.equal(topLevel(FEED).version, '0.1.0');
});

test('the app\'s update settings must name the source repo, its channel and its own cache', () => {
  assert.deepEqual(appUpdateProblems(APP_UPDATE, STABLE_BUILD), []);
  // A Nightly build that kept Stable's cache or channel would share Stable's updates.
  const nightly = { ...STABLE_BUILD, pkg: 'yeschef-desktop-nightly', channel: 'nightly' };
  assert.deepEqual(appUpdateProblems(APP_UPDATE, nightly), [
    'updaterCacheDirName is yeschef-desktop-updater, should be yeschef-desktop-nightly-updater',
    'channel is latest, should be nightly',
  ]);
  assert.deepEqual(appUpdateProblems(APP_UPDATE.replace('repo: yeschef', 'repo: agent-brigade'), STABLE_BUILD), ['repo is agent-brigade, should be yeschef']);
  assert.match(appUpdateProblems('', STABLE_BUILD).join(), /provider is missing/);
});

test('every build, npm run app too, gets app-update.yml: electron-builder writes it on the Mac only for a dmg or zip target', () => {
  assert.deepEqual(targetsFor({ dist: true }), ['dmg', 'zip']);
  assert.deepEqual(targetsFor({ dist: false }), ['zip']);
  assert.ok(writesAppUpdate(targetsFor({ dist: false })), 'npm run app must build a target that writes the updater settings');
  assert.ok(!writesAppUpdate(['dir']), 'a dir build has no app-update.yml, so its updates are off');
  // The rule, as the pinned electron-builder has it. If an upgrade changes it, check writesAppUpdate again.
  const source = readFileSync(createRequire(import.meta.url).resolve('app-builder-lib/out/publish/PublishManager.js'), 'utf8');
  assert.match(source, /if \(!event\.targets\.some\(it => it\.name === "dmg" \|\| it\.name === "zip"\)\) \{\s*return;/);
});

test('the feed must offer this version\'s ZIP and list its DMG', () => {
  const want = { version: '0.1.0', zip: 'Yes-Chef-0.1.0-arm64.zip', dmg: 'Yes-Chef-0.1.0-arm64.dmg' };
  assert.deepEqual(feedProblems(FEED, want), []);
  assert.deepEqual(feedProblems(FEED, { ...want, version: '0.1.1' }), ['version is 0.1.0, should be 0.1.1']);
  assert.deepEqual(feedProblems(FEED.replace(/^path: .*$/m, 'path: Yes-Chef-0.1.0-arm64.dmg'), want), ['path is Yes-Chef-0.1.0-arm64.dmg, should be Yes-Chef-0.1.0-arm64.zip']);
});

// gh release list --json tagName,isDraft,isPrerelease
const rel = (tagName, { draft = false, pre = tagName.includes('-') } = {}) => ({ tagName, isDraft: draft, isPrerelease: pre });
const NOW = new Date('2026-11-12T10:00:00Z');

test('a Nightly release numbers itself after the newest Stable and the day\'s runs', () => {
  assert.deepEqual(pickRelease({ arg: 'nightly', pkgVersion: '0.1.0', releases: [], date: NOW }),
    { version: '0.1.1-nightly.20261112.1', channel: 'nightly', tag: 'v0.1.1-nightly.20261112.1', from: null });
  const releases = [rel('v0.2.0'), rel('v0.2.1-nightly.20261112.1'), rel('v0.2.1-nightly.20261111.4')];
  assert.equal(pickRelease({ arg: 'nightly', pkgVersion: '0.1.0', releases, date: NOW }).version, '0.2.1-nightly.20261112.2');
});

test('a Stable release builds the newest Nightly and must be newer than every Stable', () => {
  const releases = [rel('v0.2.0'), rel('v0.2.1-nightly.20261111.1'), rel('v0.2.1-nightly.20261112.2'), rel('v0.2.1-nightly.20261112.1')];
  assert.deepEqual(pickRelease({ arg: '0.2.1', pkgVersion: '0.2.0', releases, date: NOW }),
    { version: '0.2.1', channel: 'latest', tag: 'v0.2.1', from: 'v0.2.1-nightly.20261112.2' });
  assert.throws(() => pickRelease({ arg: '0.2.0', pkgVersion: '0.2.0', releases, date: NOW }), /already a release/);
  assert.throws(() => pickRelease({ arg: '0.1.9', pkgVersion: '0.2.0', releases, date: NOW }), /Stable 0\.2\.0 is already out/);
  assert.throws(() => pickRelease({ arg: '0.3.0', pkgVersion: '0.2.0', releases: [rel('v0.2.0')], date: NOW }), /No Nightly is published yet/);
  for (const bad of ['v0.3.0', '0.3', '0.3.1-nightly.20261112.1', '']) assert.throws(() => pickRelease({ arg: bad, pkgVersion: '0.2.0', releases, date: NOW }), /not a Stable version/);
});

test('a draft left from an earlier run stops the release', () => {
  const releases = [rel('v0.2.0'), rel('v0.2.1-nightly.20261112.1', { draft: true })];
  assert.throws(() => pickRelease({ arg: 'nightly', pkgVersion: '0.2.0', releases, date: NOW }), /draft release is left.*v0\.2\.1-nightly\.20261112\.1/);
});

test('a prerelease never counts as a Stable, even with a Stable-looking tag', () => {
  const releases = [rel('v0.2.1-nightly.20261112.1'), rel('v0.3.0', { pre: true })];
  assert.equal(pickRelease({ arg: '0.2.1', pkgVersion: '0.2.0', releases, date: NOW }).from, 'v0.2.1-nightly.20261112.1');
  // Its tag is taken all the same.
  assert.throws(() => pickRelease({ arg: '0.3.0', pkgVersion: '0.2.0', releases, date: NOW }), /v0\.3\.0 is already a release/);
});

test('the release carries the DMG, the ZIP, its blockmap and the channel\'s feed', () => {
  assert.deepEqual(releaseFiles('0.2.0'), ['Yes-Chef-0.2.0-arm64.dmg', 'Yes-Chef-0.2.0-arm64.zip', 'Yes-Chef-0.2.0-arm64.zip.blockmap', 'latest-mac.yml']);
  assert.deepEqual(releaseFiles('0.2.1-nightly.20261112.1').slice(-1), ['nightly-mac.yml']);
  assert.equal(releaseTitle('0.2.0'), 'Yes Chef 0.2.0');
  assert.equal(releaseTitle('0.2.1-nightly.20261112.1'), 'Yes Chef (Nightly) 0.2.1-nightly.20261112.1');
});

test('the draft must hold exactly the built files, fully uploaded', () => {
  const local = [{ name: 'a.zip', size: 10 }, { name: 'latest-mac.yml', size: 2 }];
  assert.deepEqual(assetProblems(local, [{ name: 'a.zip', size: 10, state: 'uploaded' }, { name: 'latest-mac.yml', size: 2, state: 'uploaded' }]), []);
  assert.deepEqual(assetProblems(local, [{ name: 'a.zip', size: 9, state: 'uploaded' }, { name: 'x.dmg', size: 1, state: 'uploaded' }]),
    ['a.zip is 9 bytes on GitHub, 10 here', 'latest-mac.yml is not attached', 'x.dmg should not be attached']);
  assert.deepEqual(assetProblems([{ name: 'a.zip', size: 10 }], [{ name: 'a.zip', size: 10, state: 'starter' }]), ['a.zip is starter']);
});

test('gh makes a draft at the built commit, then publishes Nightly as a prerelease and Stable as latest', () => {
  const nightly = ghArgs({ tag: 'v0.2.1-nightly.20261112.1', version: '0.2.1-nightly.20261112.1', channel: 'nightly', commit: 'abc123' }, 'notes.md');
  assert.deepEqual(nightly.create, ['release', 'create', 'v0.2.1-nightly.20261112.1', '--repo', 'ddmirolli/yeschef', '--draft', '--target', 'abc123',
    '--title', 'Yes Chef (Nightly) 0.2.1-nightly.20261112.1', '--notes-file', 'notes.md', '--prerelease']);
  assert.deepEqual(nightly.publish, ['release', 'edit', 'v0.2.1-nightly.20261112.1', '--repo', 'ddmirolli/yeschef', '--draft=false', '--prerelease', '--latest=false']);
  const stable = ghArgs({ tag: 'v0.2.1', version: '0.2.1', channel: 'latest', commit: 'def456' }, 'notes.md');
  assert.deepEqual(stable.create.slice(-4), ['--title', 'Yes Chef 0.2.1', '--notes-file', 'notes.md']);
  assert.deepEqual(stable.publish.slice(-2), ['--draft=false', '--latest']);
  assert.equal(releaseNotes({ channel: 'latest', notes: '- Updates itself.', from: 'v0.2.1-nightly.20261112.1', commit: 'def4567890abcdef' }),
    '- Updates itself.\n\nBuilt from v0.2.1-nightly.20261112.1 (def4567890ab), the Nightly build it ships.\n');
});

test('a Stable release\'s notes are its CHANGELOG section', () => {
  const log = '# Changes\n\nIntro.\n\n## 0.2.1\n\n- One.\n- Two.\n\n## 0.2.0\n\n- Zero.\n\n## 0.1.9\n';
  assert.equal(changelogEntry(log, '0.2.1'), '- One.\n- Two.');
  assert.equal(changelogEntry(log, '0.2.0'), '- Zero.');
  assert.equal(changelogEntry(log, '0.1.9'), null, 'an empty section is no notes');
  assert.equal(changelogEntry(log, '0.2'), null);
  assert.equal(changelogEntry(log, '0.3.0'), null);
});

test('literalPattern escapes every extended regular expression character', () => {
  assert.equal(literalPattern('/Applications/Yes Chef (Nightly).app/Contents/MacOS/'), '/Applications/Yes Chef \\(Nightly\\)\\.app/Contents/MacOS/');
  assert.equal(literalPattern('a.b*c+d?e^f$g|h[i]j{k}l\\m'), 'a\\.b\\*c\\+d\\?e\\^f\\$g\\|h\\[i\\]j\\{k\\}l\\\\m');
});

test('runningFrom sees a running Nightly, whose path holds parentheses (PR-Agent r1 on #66)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yeschef-running-'));
  const nightly = join(dir, 'Yes Chef (Nightly).app');
  const stable = join(dir, 'Yes Chef.app');
  // A shell that stays alive with the bundle's executable folder in its command line, as the app's processes have.
  const child = spawn('/bin/sh', ['-c', 'sleep 30; :', `${nightly}/Contents/MacOS/Yes Chef (Nightly)`], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(runningFrom(nightly), true);
    assert.equal(runningFrom(stable), false);
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(runningFrom(nightly), false);
});

// GitHub Actions (.github/workflows/release.yml): the scheduled Nightly's gate, the dry run, and the --ci path.

test('the newest published Nightly is the highest Nightly version, never a draft or a Stable', () => {
  assert.equal(newestNightly([]), null);
  assert.equal(newestNightly([rel('v0.2.0'), rel('v0.3.0', { pre: true })]), null);
  const releases = [rel('v0.2.1-nightly.20261112.1'), rel('v0.2.1-nightly.20261112.3', { draft: true }), rel('v0.2.1-nightly.20261111.9'), rel('v0.2.0')];
  assert.equal(newestNightly(releases), 'v0.2.1-nightly.20261112.1');
});

test('the scheduled Nightly runs only when main has commits since the newest Nightly', () => {
  const never = () => false;
  assert.equal(nightlyDue({ head: 'a'.repeat(40), last: null, lastTag: null, isAncestor: never }).due, true);
  const same = nightlyDue({ head: 'b'.repeat(40), last: 'b'.repeat(40), lastTag: 'v0.2.1-nightly.20261112.1', isAncestor: never });
  assert.deepEqual(same, { due: false, reason: 'main (bbbbbbbbbbbb) has nothing new since v0.2.1-nightly.20261112.1.' });
  // main behind the Nightly's commit (it never should be) is nothing new either.
  assert.equal(nightlyDue({ head: 'c'.repeat(40), last: 'd'.repeat(40), lastTag: 'v1', isAncestor: (a, b) => a === 'c'.repeat(40) && b === 'd'.repeat(40) }).due, false);
  assert.equal(nightlyDue({ head: 'e'.repeat(40), last: 'f'.repeat(40), lastTag: 'v1', isAncestor: never }).due, true);
});

test('a dry run plans the next Nightly or the version given, and a draft does not stop it', () => {
  const releases = [rel('v0.2.0'), rel('v0.2.1-nightly.20261112.1', { draft: true })];
  assert.deepEqual(pickRelease({ arg: 'dry-run', pkgVersion: '0.1.0', releases, date: NOW }),
    { version: '0.2.1-nightly.20261112.2', channel: 'nightly', tag: 'v0.2.1-nightly.20261112.2', from: null, dryRun: true });
  assert.deepEqual(pickRelease({ arg: 'dry-run', pkgVersion: '0.1.0', releases: [], date: NOW, dryRunVersion: '0.2.0' }),
    { version: '0.2.0', channel: 'latest', tag: 'v0.2.0', from: null, dryRun: true });
  assert.throws(() => pickRelease({ arg: 'dry-run', pkgVersion: '0.1.0', releases: [], date: NOW, dryRunVersion: 'v0.2.0' }), /not a version Yes Chef builds/);
  // A real release still stops on the draft.
  assert.throws(() => pickRelease({ arg: 'nightly', pkgVersion: '0.1.0', releases, date: NOW }), /draft release is left/);
});

test('the command line takes its flags anywhere and refuses unknown ones', () => {
  assert.deepEqual(parseArgs(['plan', 'nightly', '/tmp/p.json', '--ci', '--if-changed']),
    { cmd: 'plan', args: ['nightly', '/tmp/p.json'], ci: true, ifChanged: true, version: '' });
  assert.deepEqual(parseArgs(['--ci', 'plan', 'dry-run', '--version', '0.2.0', 'p.json']),
    { cmd: 'plan', args: ['dry-run', 'p.json'], ci: true, ifChanged: false, version: '0.2.0' });
  assert.deepEqual(parseArgs(['build', 'p.json']), { cmd: 'build', args: ['p.json'], ci: false, ifChanged: false, version: '' });
  assert.throws(() => parseArgs(['build', 'p.json', '--no-check']), /Unknown option --no-check/);
});

test('settle asks again until a check passes, then gives the last problems', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  let n = 0;
  assert.deepEqual(await settle(async () => (++n < 3 ? ['not yet'] : []), { tries: 5, wait: 7, sleep }), []);
  assert.equal(n, 3);
  assert.deepEqual(waits, [7, 7]);
  n = 0;
  assert.deepEqual(await settle(async () => [`try ${++n}`], { tries: 3, wait: 1, sleep }), ['try 3']);
});

test('an unsigned dry run reports the certificate checks as skip, and a release cannot be unsigned', async () => {
  assert.equal(resultLine({ name: 'team', ok: true, skipped: true, detail: 'why' }), 'skip team: why');
  assert.equal(resultLine({ name: 'fuses', ok: true, detail: '' }), 'ok   fuses');
  assert.equal(resultLine({ name: 'fuses', ok: false, detail: 'a\nb' }), 'FAIL fuses: a | b');
  await assert.rejects(() => checkApp('/nonexistent.app', { release: true, signed: false }), /always signed/);
  assert.throws(() => checkDmg('/nonexistent.dmg', { release: true, signed: false }), /always signed/);
  const dir = mkdtempSync(join(tmpdir(), 'yeschef-dmg-'));
  try {
    writeFileSync(join(dir, 'x.dmg'), 'not a disk image');
    const results = checkDmg(join(dir, 'x.dmg'), { release: false, signed: false });
    assert.deepEqual(results.map((r) => [r.name, r.ok, !!r.skipped]),
      [['DMG codesign --verify --strict', true, true], [`DMG signed by team ${TEAM_ID}`, true, true], ['not empty', true, false]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const HERE = new URL('.', import.meta.url).pathname;
const publishCli = (args, env = {}) => spawnSync(process.execPath, [join(HERE, 'build', 'publish.mjs'), ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GITHUB_ACTIONS: '', ...env } });

test('--ci runs only where GitHub Actions says it runs, and drops only the terminal guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yeschef-ci-'));
  try {
    const notDue = join(dir, 'not-due.json');
    writeFileSync(notDue, JSON.stringify({ due: false, reason: 'nothing new' }));
    const dry = join(dir, 'dry.json');
    writeFileSync(dry, JSON.stringify({ due: true, dryRun: true, version: '0.2.0', files: [{ name: 'a', size: 1, sha512: 'x' }] }));
    // Off Actions, --ci is refused, and without a terminal build and publish are refused.
    let r = publishCli(['build', notDue, '--ci']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--ci is the GitHub Actions path/);
    r = publishCli(['build', notDue]);
    assert.match(r.stderr, /in your own Terminal window/);
    // In Actions, build and publish pass the terminal guard and stop at the plan's own rules.
    r = publishCli(['build', notDue, '--ci'], { GITHUB_ACTIONS: 'true' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /The plan has nothing to build/);
    r = publishCli(['publish', dry, '--ci'], { GITHUB_ACTIONS: 'true' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /A dry run is never published/);
    r = publishCli(['plan', 'nightly', join(dir, 'p.json'), '--version', '0.2.0']);
    assert.match(r.stderr, /--version is for a dry run/);
    r = publishCli(['plan', '0.2.0', join(dir, 'p.json'), '--if-changed']);
    assert.match(r.stderr, /--if-changed is for the scheduled Nightly only/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ci-signing.sh refuses to run outside GitHub Actions, so it never touches this Mac\'s keychains', () => {
  for (const mode of ['load', 'rehearse', 'cleanup']) {
    const r = spawnSync('/bin/bash', [join(HERE, 'build', 'ci-signing.sh'), mode], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_TEMP: '', GITHUB_ENV: '' } });
    assert.equal(r.status, 1, mode);
    assert.match(r.stderr, /runs only in GitHub Actions on macOS/);
  }
  assert.equal(existsSync(join(tmpdir(), 'yeschef-signing')), false);
});
