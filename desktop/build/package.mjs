// Build Yes Chef for the Mac with electron-builder, as T3 Code builds its own (docs/desktop-release-plan-v0_1.md,
// sections 2, 3 and 6). Apple silicon, macOS 13 or later.
//
//   npm run app                  Yes Chef.app for this Mac, in out/builder/mac-arm64 (with a ZIP: see targetsFor)
//   npm run app -- --install     the same, then put it in /Applications (quit Yes Chef first)
//   npm run dist                 the release files in out/builder: Yes-Chef-<version>-arm64.dmg and .zip, latest-mac.yml
//   npm run dist -- --dry-run    the same files signed with this Mac's certificate and not notarized, to test the build.
//                                Never publish them: Gatekeeper rejects them on any other Mac. With no certificate
//                                (the GitHub runner's dry run) they are signed ad hoc, and the checks only a
//                                certificate build can pass print as skip.
//   --version <version>          build that version instead of package.json's: 0.2.0 for Stable, or
//                                0.2.1-nightly.20261110.1 for Nightly (desktop/channels.mjs). `npm run release` passes it.
//
// The version picks the channel. A Nightly build is its own app, "Yes Chef (Nightly)", with its own bundle ID, icon
// (build/icon-nightly.png) and feed file (nightly-mac.yml), so it never shares Stable's data, Keychain item or updates.
//
// Every build flips the fuses (build/release.mjs), then signs every helper, framework and the app, inside out, with the
// hardened runtime and build/entitlements.mac.plist. `app` signs with Developer ID if this Mac has it, else Apple
// Development, both from team 8J2K26SZNK, so the Keychain keeps trusting Yes Chef; with neither it signs ad hoc and warns.
// YESCHEF_SIGN_IDENTITY narrows the choice by hash or name.
//
// `dist` refuses without a Developer ID Application certificate and notarization credentials. It reads them from the
// environment as electron-builder does, and never prints them:
//   APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID and APPLE_API_ISSUER: an App Store Connect team key, as T3 Code uses;
//   or APPLE_KEYCHAIN_PROFILE: a profile saved with `xcrun notarytool store-credentials` (the app-specific password route).
// APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD are refused: they would put the password on a command line.
// electron-builder notarizes and staples the app. This script then notarizes and staples the DMG, so a downloaded DMG
// passes Gatekeeper before it is opened, rewrites the DMG's size and sha512 in latest-mac.yml (stapling changes its
// bytes), and runs the section 2 checks on the app inside the ZIP and on the DMG.
//
// The app is one asar: desktop/ (main.mjs, t3.mjs, preload.cjs, updates.mjs, channels.mjs, keybindings.mjs, the Dock icon), client/
// without its tests (its .mjs and .ts files, which Electron's Node runs with the types stripped, and pass.css, the board's
// base stylesheet) and electron-updater with its dependencies, in the repo's own
// layout, so main.mjs finds the board server at ../client as in the repo. The asar integrity and "only load the app
// from asar" fuses then cover the board server and the updater too. Last, a hidden --capture start of the built app
// on an empty temporary data folder proves it starts and loads all its code (release plan, section 7, step 4).
import builder from 'electron-builder';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNELS, FEED, channelOf, isReleaseVersion } from '../channels.mjs';
import { ARCH, FUSES, MIN_MACOS, TEAM_ID, checkApp, checkBuild, checkDmg, checkFeed, pickIdentity, report, rewriteFeed, runningFrom, sha512, targetsFor, teamOf } from './release.mjs';

const { build, Platform, Arch } = builder;
const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(DESKTOP, '..');
const STAGE = join(DESKTOP, 'out', 'stage');
const OUT = join(DESKTOP, 'out', 'builder');
const DIST = process.argv.includes('--dist');
const DRY = DIST && process.argv.includes('--dry-run');
const RELEASE = DIST && !DRY;
const INSTALL = process.argv.includes('--install');
const ENTITLEMENTS = join(DESKTOP, 'build', 'entitlements.mac.plist');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
const fail = (text) => { console.error(text); process.exit(1); };

if (process.platform !== 'darwin' || process.arch !== ARCH) fail('Yes Chef builds on an Apple silicon Mac only.');
const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'));
const at = process.argv.indexOf('--version');
const VERSION = at < 0 ? pkg.version : String(process.argv[at + 1] || '');
if (!isReleaseVersion(VERSION)) fail(`Not a version Yes Chef builds: "${VERSION}". Use 1.2.3, or 1.2.4-nightly.20261110.1 for Nightly.`);
const CHANNEL = channelOf(VERSION);
const C = CHANNELS[CHANNEL];
console.log(`Building ${C.name} ${VERSION} (${C.label}).`);
const expected = { appId: C.appId, name: C.name, version: VERSION, channel: CHANNEL, pkg: C.pkg, feed: FEED, dmg: `Yes-Chef-${VERSION}-${ARCH}.dmg`, zip: `Yes-Chef-${VERSION}-${ARCH}.zip` };
const electronVersion = JSON.parse(readFileSync(join(DESKTOP, 'node_modules', 'electron', 'package.json'), 'utf8')).version;

// The signing identity. A release takes only Developer ID Application from TEAM_ID.
const found = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
const identity = pickIdentity(found, { release: RELEASE, want: process.env.YESCHEF_SIGN_IDENTITY || '', teamOf });
if (RELEASE && !identity) fail(`No Developer ID Application certificate from team ${TEAM_ID} on this Mac. A release needs one (release plan, Dan's actions).`);
if (RELEASE && !notaryArgs()) fail('No notarization credentials: set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER, or APPLE_KEYCHAIN_PROFILE (see the top of this file).');
if (!identity) console.warn('No Developer ID or Apple Development certificate from team ' + TEAM_ID + ': signing ad hoc. macOS will ask for the Keychain again after every update.');
console.log(`Signing with ${identity ? identity.name : 'ad hoc'}.`);
// On a pull request build (GITHUB_BASE_REF is set) electron-builder skips all signing, to keep a fork's build away
// from signing secrets, and leaves the bundle unsealed. An ad hoc signature uses no secret, so it may sign then. A
// certificate build never gets this: on a pull request it stays unsigned and fails its checks.
if (!identity) process.env.CSC_FOR_PULL_REQUEST = 'true';

// The Dock icon as .icns, from the channel's PNG (build/icon.png or build/icon-nightly.png), with the macOS tools.
const work = mkdtempSync(join(tmpdir(), 'yeschef-build-'));
const set = join(work, 'icon.iconset');
mkdirSync(set);
for (const size of [16, 32, 128, 256, 512]) {
  run('/usr/bin/sips', ['-z', String(size), String(size), join(DESKTOP, 'build', C.icon), '--out', join(set, `icon_${size}x${size}.png`)]);
  run('/usr/bin/sips', ['-z', String(size * 2), String(size * 2), join(DESKTOP, 'build', C.icon), '--out', join(set, `icon_${size}x${size}@2x.png`)]);
}
const icns = join(work, 'icon.icns');
run('/usr/bin/iconutil', ['-c', 'icns', set, '-o', icns]);

// What ships, in the repo's layout. No tests (section 3), and nothing else from the repo.
rmSync(STAGE, { recursive: true, force: true });
for (const f of ['main.mjs', 't3.mjs', 'preload.cjs', 'updates.mjs', 'channels.mjs', 'keybindings.mjs']) cpSync(join(DESKTOP, f), join(STAGE, 'desktop', f));
cpSync(join(DESKTOP, 'build', C.icon), join(STAGE, 'desktop', 'build', C.icon));
for (const f of readdirSync(join(REPO, 'client'))) {
  const code = (f.endsWith('.mjs') && !f.endsWith('.test.mjs')) || (f.endsWith('.ts') && !f.endsWith('.test.ts'));
  if (code || f === 'pass.css') cpSync(join(REPO, 'client', f), join(STAGE, 'client', f));
}
// The one runtime library, electron-updater, and what it needs: copied from desktop/node_modules as `npm ci` installed
// them from package-lock.json, so the app ships the files the tests ran against. Each package is copied without its
// own node_modules; npm lists the nested ones separately.
const listed = spawnSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: DESKTOP, encoding: 'utf8' });
if (listed.status !== 0) fail(`npm ls failed. Run npm ci in desktop/ first.\n${listed.stderr}`);
const MODULES = join(DESKTOP, 'node_modules');
const runtime = listed.stdout.split('\n').filter((p) => p.startsWith(`${MODULES}/`));
if (!runtime.some((p) => p === join(MODULES, 'electron-updater'))) fail('electron-updater is not installed. Run npm ci in desktop/ first.');
for (const p of runtime) {
  cpSync(p, join(STAGE, relative(DESKTOP, p)), { recursive: true, filter: (src) => src !== join(p, 'node_modules') && !src.startsWith(`${join(p, 'node_modules')}/`) });
}
// The bundle's name, version and feed come from here: electron-builder names the updater's cache after `name`.
writeFileSync(join(STAGE, 'package.json'), JSON.stringify({
  name: C.pkg, productName: C.name, version: VERSION, description: pkg.description,
  author: 'Daniel Mirolli', license: 'MIT', type: 'module', main: 'desktop/main.mjs',
  dependencies: pkg.dependencies,
}, null, 2) + '\n');

rmSync(OUT, { recursive: true, force: true });
await build({
  projectDir: DESKTOP,
  targets: Platform.MAC.createTarget(targetsFor({ dist: DIST }), Arch.arm64),
  publish: 'never',
  config: {
    appId: C.appId,
    productName: C.name,
    copyright: 'Copyright © 2026 Daniel Mirolli',
    artifactName: 'Yes-Chef-${version}-${arch}.${ext}',
    // electron-builder fetches this Electron's official zip (checked against Electron's checksums, cached after the
    // first build) and leaves out Electron's demo app, default_app.asar, which a local unpacked copy would keep.
    electronVersion,
    directories: { app: STAGE, output: OUT, buildResources: join(DESKTOP, 'build') },
    files: ['**/*'],
    asar: true,
    // Invite links open Join in the app: yeschef://join#<invite>, from the site's /join page (step 3b).
    protocols: [{ name: C.name, schemes: ['yeschef'] }],
    npmRebuild: false,
    electronFuses: FUSES,
    mac: {
      icon: icns,
      category: 'public.app-category.developer-tools',
      minimumSystemVersion: MIN_MACOS,
      // Ad hoc signing cannot keep library validation on, so only a certificate build gets the hardened runtime.
      hardenedRuntime: !!identity,
      entitlements: ENTITLEMENTS,
      entitlementsInherit: ENTITLEMENTS,
      identity: identity ? identity.hash : '-',
      // electron-builder notarizes and staples the app when the environment has credentials; a build for this Mac never does.
      notarize: RELEASE,
    },
    // The DMG is signed too, then notarized and stapled below.
    dmg: { sign: true, title: `${C.name} \${version}` },
    // The update feed: GitHub Releases on the public source repo, as T3 Code's (section 6). The app reads it from
    // app-update.yml; its channel names the feed file, latest-mac.yml or nightly-mac.yml. Builds never publish;
    // the release script does (build/publish.mjs).
    publish: [{ ...FEED, channel: CHANNEL, releaseType: CHANNEL === 'nightly' ? 'prerelease' : 'release' }],
  },
});
rmSync(work, { recursive: true, force: true });

const appIn = (dir) => join(dir, `${C.name}.app`);
if (!DIST) {
  const bundle = appIn(join(OUT, `mac-${ARCH}`));
  // An ad hoc build has no team and no hardened runtime, so only a certificate build must pass.
  const ok = report([...(await checkApp(bundle)), ...checkBuild(bundle, expected), ...smoke(bundle)]);
  if (!ok && identity) fail('The build failed its checks.');
  console.log(`Built ${bundle}`);
  if (INSTALL) {
    const target = `/Applications/${C.name}.app`;
    // Never swap the app out from under itself: quit Yes Chef first.
    if (runningFrom(target)) fail(`${C.name} is running from /Applications. Quit it, then run this again.`);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    // ditto keeps the bundle's symlinks, permissions and signature intact.
    run('/usr/bin/ditto', [bundle, target]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
    console.log(`Installed ${target}`);
  }
  process.exit(0);
}

// The release files.
const name = `Yes-Chef-${VERSION}-${ARCH}`;
const dmg = join(OUT, `${name}.dmg`);
const zip = join(OUT, `${name}.zip`);
const feed = join(OUT, `${CHANNEL}-mac.yml`);
for (const f of [dmg, zip, feed]) if (!existsSync(f)) fail(`electron-builder made no ${basename(f)}.`);

if (DRY) {
  // The feed rewrite on the real file: with the DMG unchanged it must give back the same feed.
  const before = readFileSync(feed, 'utf8');
  if (rewriteFeed(before, basename(dmg), { sha512: sha512(dmg), size: statSync(dmg).size }) !== before) fail(`${basename(feed)} does not match the DMG.`);
  // With no certificate (a GitHub runner before the signing secrets exist) the build is ad hoc: the checks only a
  // certificate build can pass are reported as skipped, and every other check still has to pass.
  const signed = !!identity;
  const unzipped = mkdtempSync(join(tmpdir(), 'yeschef-check-'));
  run('/usr/bin/ditto', ['-x', '-k', zip, unzipped]);
  const ok = report([...(await checkApp(appIn(unzipped), { signed })), ...checkBuild(appIn(unzipped), expected), ...checkFeed(feed, expected), ...smoke(appIn(unzipped)),
    ...checkDmg(dmg, { release: false, signed })]);
  rmSync(unzipped, { recursive: true, force: true });
  if (!ok) fail('The dry run failed its checks.');
  console.log(`Dry run${signed ? '' : ', unsigned'}: files in ${OUT}, not notarized. Never publish them.`);
  process.exit(0);
}

// Notarize and staple the DMG.
const notary = notaryArgs();
const submit = spawnSync('/usr/bin/xcrun', ['notarytool', 'submit', dmg, ...notary, '--wait', '--output-format', 'json'], { encoding: 'utf8' });
let result = {};
try { result = JSON.parse(submit.stdout); } catch { result = {}; }
if (result.status !== 'Accepted') {
  console.error(`Notarizing the DMG: ${result.status || 'no answer'} ${result.message || submit.stderr || ''}`.trim());
  if (result.id) spawnSync('/usr/bin/xcrun', ['notarytool', 'log', result.id, ...notary], { stdio: 'inherit' });
  fail('The DMG was not notarized.');
}
run('/usr/bin/xcrun', ['stapler', 'staple', dmg]);
// Stapling changed the DMG: its entry in the feed must match the new bytes. Its blockmap no longer does,
// and the updater downloads the ZIP, so the stale DMG blockmap is removed rather than shipped.
writeFileSync(feed, rewriteFeed(readFileSync(feed, 'utf8'), basename(dmg), { sha512: sha512(dmg), size: statSync(dmg).size }));
rmSync(`${dmg}.blockmap`, { force: true });

// The checks: the app as the updater installs it (from the ZIP), and the DMG as a browser downloads it.
const unzipped = mkdtempSync(join(tmpdir(), 'yeschef-check-'));
run('/usr/bin/ditto', ['-x', '-k', zip, unzipped]);
const ok = report([...(await checkApp(appIn(unzipped), { release: true })), ...checkBuild(appIn(unzipped), expected), ...checkFeed(feed, expected),
  ...smoke(appIn(unzipped)), ...checkDmg(dmg)]);
rmSync(unzipped, { recursive: true, force: true });
if (!ok) fail('The release failed its checks. Do not publish it.');
console.log(`Release files in ${OUT}: ${basename(dmg)}, ${basename(zip)}, ${basename(zip)}.blockmap, ${basename(feed)}`);

/**
 * A hidden --capture start of the built app on an empty temporary data folder. With no saved sign-in a capture stops
 * before signing in (no-sign-in.png), or finds no T3 Code (no-t3.png); either way the app started and loaded its code.
 * The notarization credentials stay out of its environment.
 */
function smoke(bundle) {
  const tmp = mkdtempSync(join(tmpdir(), 'yeschef-smoke-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('APPLE_') && !k.startsWith('YESCHEF_')));
  const r = spawnSync(join(bundle, 'Contents', 'MacOS', C.name), ['--capture'],
    { env: { ...env, YESCHEF_USER_DATA: join(tmp, 'data'), YESCHEF_CAPTURE_DIR: join(tmp, 'out') }, encoding: 'utf8', timeout: 120000 });
  const shot = ['no-sign-in.png', 'no-t3.png'].find((f) => existsSync(join(tmp, 'out', f)));
  rmSync(tmp, { recursive: true, force: true });
  // Chromium's own log lines ([pid:date/time:ERROR:file.cc:line] ...) are left out: on a runner with no GPU they come
  // last and push the app's own message out of the tail.
  const chromium = /^\[\d+:\d+\/\d+\.\d+:[A-Z]+:/;
  const tail = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').filter((l) => l.trim() && !chromium.test(l)).slice(-6).join(' | ');
  const retries = (r.stdout || '').split('\n').filter((l) => l.startsWith('capturePage failed')).length;
  const again = retries ? `, after ${retries} failed capturePage ${retries === 1 ? 'try' : 'tries'}` : '';
  return [{ name: 'hidden --capture start, empty data folder', ok: r.status === 0 && !!shot, detail: shot ? `stopped at ${shot}${again}` : `exit ${r.status}${r.error ? ` (${r.error.message})` : ''}: ${tail}` }];
}

/**
 * notarytool's credential arguments from the environment, or null. Only an API key (paths and IDs) or a saved
 * notarytool profile: an app-specific password would sit on a command line, where any process on the Mac can read it.
 * For the password route, save it once with `xcrun notarytool store-credentials yeschef-notary --apple-id <email>
 * --team-id 8J2K26SZNK` (it asks for the password at a hidden prompt), then set APPLE_KEYCHAIN_PROFILE=yeschef-notary.
 */
function notaryArgs() {
  const e = process.env;
  if (e.APPLE_ID || e.APPLE_APP_SPECIFIC_PASSWORD) return null;
  if (e.APPLE_API_KEY || e.APPLE_API_KEY_ID || e.APPLE_API_ISSUER) {
    return e.APPLE_API_KEY && e.APPLE_API_KEY_ID && e.APPLE_API_ISSUER && existsSync(e.APPLE_API_KEY)
      ? ['--key', e.APPLE_API_KEY, '--key-id', e.APPLE_API_KEY_ID, '--issuer', e.APPLE_API_ISSUER] : null;
  }
  if (e.APPLE_KEYCHAIN_PROFILE) return ['--keychain-profile', e.APPLE_KEYCHAIN_PROFILE, ...(e.APPLE_KEYCHAIN ? ['--keychain', e.APPLE_KEYCHAIN] : [])];
  return null;
}
