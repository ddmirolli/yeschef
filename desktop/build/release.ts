// What a Yes Chef build must be, and the checks that prove it (docs/desktop-release-plan-v0_1.md, sections 2 and 3).
// build/package.ts builds with these settings and runs the checks; `npm run check -- <app or dmg>` runs them alone.
// The pure parts (identity choice, fuse states, the feed rewrite) are tested in desktop/release.test.ts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** One check's result, as report prints it. `skipped` marks a check an unsigned dry run cannot run. */
export interface Result { name: string; ok: boolean; detail: string; skipped?: boolean }
/** A signing identity in the keychain. */
export interface Identity { hash: string; name: string; kind: 'developer-id' | 'development' }
/** What a build must be (build/package.ts): its bundle ID, name, version, channel, update cache, feed and files. */
export interface Expected {
  appId: string; name: string; version: string; channel: string; pkg: string;
  feed: { readonly provider: string; readonly owner: string; readonly repo: string }; dmg: string; zip: string;
}

// Dan's personal Apple team (ruling 2026-11-09). Every signature, local or released, must carry it: the Keychain
// ties "Yes Chef Safe Storage" to this Team ID, so the saved sign-in survives updates.
export const TEAM_ID = '8J2K26SZNK';
// Apple silicon, macOS 13 or later (ruling 2026-11-09).
export const ARCH = 'arm64';
export const MIN_MACOS = '13.0';

// electron-builder's targets. On the Mac it writes app-update.yml, the updater's settings, only for a dmg or zip
// target (app-builder-lib, PublishManager), so `npm run app` builds the ZIP too: a `dir` build has no updates.
export const targetsFor = ({ dist }: { dist: boolean }): string[] => (dist ? ['dmg', 'zip'] : ['zip']);
export const writesAppUpdate = (targets: readonly string[]): boolean => targets.some((t) => t === 'dmg' || t === 'zip');

// The fuses (section 3), as electron-builder's `electronFuses` takes them. It flips them right before signing.
export const FUSES = {
  runAsNode: false, // nobody can run the signed binary as plain Node (ELECTRON_RUN_AS_NODE)
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false,
};
// The same, by position in Electron's fuse wire, as read back from a built app: 49 is on, 48 is off.
// Fuses not named here (6, the browser-only V8 snapshot; 8 and on, newer than @electron/fuses 1.8.0) keep Electron's default.
export const FUSE_WIRE: Readonly<Record<number, number>> = { 0: 48, 1: 49, 2: 48, 3: 48, 4: 49, 5: 49, 7: 48 };
const FUSE_NAMES = ['RunAsNode', 'EnableCookieEncryption', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar', 'LoadBrowserProcessSpecificV8Snapshot', 'GrantFileProtocolExtraPrivileges'];
const onOff = (v: unknown) => (v === 49 ? 'on' : v === 48 ? 'off' : `state ${v}`);

/** The fuses in `wire` (from @electron/fuses getCurrentFuseWire) that differ from FUSE_WIRE, as readable lines. */
export function fuseProblems(wire: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(FUSE_WIRE)
    .filter(([i, want]) => wire[i] !== want)
    .map(([i, want]) => `${FUSE_NAMES[Number(i)]} is ${onOff(wire[i])}, should be ${onOff(want)}`);
}

/**
 * The signing identities in `security find-identity -v -p codesigning` output that can sign Yes Chef:
 * Developer ID Application and Apple Development, as { hash, name, kind }.
 */
export function identities(found: unknown): Identity[] {
  const ids: Identity[] = [];
  for (const line of String(found).split('\n')) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/.exec(line);
    if (!m) continue;
    const kind = m[2]!.startsWith('Developer ID Application: ') ? 'developer-id' : m[2]!.startsWith('Apple Development: ') ? 'development' : null;
    if (kind) ids.push({ hash: m[1]!, name: m[2]!, kind });
  }
  return ids;
}

/**
 * The identity to sign with, or null. `teamOf(hash)` gives a certificate's Team ID; only TEAM_ID counts.
 * A release takes only Developer ID Application. A build for this Mac takes Developer ID if there is one, else
 * Apple Development; both keep the Keychain's trust. `want` (YESCHEF_SIGN_IDENTITY) narrows the choice by hash or name.
 */
export function pickIdentity(found: unknown, { release = false, want = '', teamOf }: { release?: boolean; want?: string; teamOf: (hash: string) => string | null }): Identity | null {
  const pool = identities(found)
    .filter((id) => !want || id.hash === want.toUpperCase() || id.name.includes(want))
    .filter((id) => teamOf(id.hash) === TEAM_ID);
  return pool.find((id) => id.kind === 'developer-id') || (release ? null : pool.find((id) => id.kind === 'development')) || null;
}

const sh = (cmd: string, args: string[], input?: string) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
};

/** The Team ID (the certificate's OU) of the keychain certificate with this SHA-1 hash, or null. */
export function teamOf(hash: string): string | null {
  // Each certificate prints as a "SHA-1 hash:" line, then its PEM.
  const all = sh('/usr/bin/security', ['find-certificate', '-a', '-Z', '-p']).stdout;
  const at = all.indexOf(`SHA-1 hash: ${hash}`);
  const begin = at < 0 ? -1 : all.indexOf('-----BEGIN CERTIFICATE-----', at);
  const end = begin < 0 ? -1 : all.indexOf('-----END CERTIFICATE-----', begin);
  if (end < 0) return null;
  const subject = sh('/usr/bin/openssl', ['x509', '-noout', '-subject', '-nameopt', 'RFC2253'], all.slice(begin, end + 25)).stdout;
  return /(?:^subject=|,)OU=([A-Z0-9]{10})(?:,|\s*$)/m.exec(subject)?.[1] || null;
}

/** `text` as an extended regular expression that matches only itself, for `pgrep -f`. */
export function literalPattern(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Whether a process runs from this app bundle. `pgrep -f` reads a regular expression, so the path is escaped first:
 * unescaped, the parentheses of "Yes Chef (Nightly).app" form a group and a running Nightly goes unseen (PR-Agent r1
 * on #66). Only pgrep's "no match" (exit 1) counts as not running; an error counts as running, so nothing is replaced.
 */
export function runningFrom(bundle: string): boolean {
  return spawnSync('/usr/bin/pgrep', ['-f', literalPattern(`${bundle}/Contents/MacOS/`)], { stdio: 'ignore' }).status !== 1;
}

/** sha512 as base64, the form electron-builder writes in latest-mac.yml. */
export function sha512(file: string): string {
  return createHash('sha512').update(readFileSync(file)).digest('base64');
}

/**
 * latest-mac.yml with one file's sha512 and size replaced (section 2: stapling the DMG changes its bytes).
 * The feed is electron-builder's own simple YAML: a `files:` list of `- url:` items, then a top-level `path:` and
 * `sha512:` for the first file. Throws when `url` is not listed, so a renamed file never leaves a stale entry.
 */
export function rewriteFeed(yml: string, url: string, { sha512: sum, size }: { sha512: string; size: number }): string {
  const lines = yml.split('\n');
  const start = lines.indexOf(`  - url: ${url}`);
  if (start < 0) throw new Error(`latest-mac.yml lists no ${url}`);
  let set = 0;
  for (let i = start + 1; i < lines.length && /^ {4}\S/.test(lines[i]!); i++) {
    if (lines[i]!.startsWith('    sha512: ')) { lines[i] = `    sha512: ${sum}`; set++; }
    else if (lines[i]!.startsWith('    size: ')) { lines[i] = `    size: ${size}`; set++; }
  }
  if (set !== 2) throw new Error(`latest-mac.yml: ${url} needs one sha512 and one size`);
  // The top-level path and sha512 describe the first file; they change only when that file is this one.
  if (lines.includes(`path: ${url}`)) {
    const top = lines.findIndex((l) => l.startsWith('sha512: '));
    if (top < 0) throw new Error('latest-mac.yml has a top-level path but no sha512');
    lines[top] = `sha512: ${sum}`;
  }
  return lines.join('\n');
}

// The only entitlement any signed code in the app may carry.
const ALLOWED = ['com.apple.security.cs.allow-jit'];

/** Every Mach-O file in a bundle (by its magic number, not its name), skipping symlinks such as Versions/Current. */
export function machOFiles(dir: string): string[] {
  const out: string[] = [];
  const magic = new Set(['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca']);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { out.push(...machOFiles(p)); continue; }
    if (!st.isFile() || st.size < 4) continue;
    const fd = openSync(p, 'r');
    const head = Buffer.alloc(4);
    try { readSync(fd, head, 0, 4, 0); } finally { closeSync(fd); }
    if (magic.has(head.toString('hex'))) out.push(p);
  }
  return out;
}

/** The entitlement keys in `codesign -d --entitlements - --xml` output. */
export const entitlementKeys = (xml: unknown): string[] => [...String(xml).matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]!);

// Why an unsigned dry run skips a check (see `signed` below).
const AD_HOC = 'ad hoc signature: only a certificate build can pass this';

/**
 * The section 2 checks on a built app: signature, hardened runtime, team, entitlements and fuses. With `release`,
 * also the Developer ID authority, Gatekeeper and the stapled ticket, which only a notarized build passes.
 * `signed: false` is an unsigned dry run on a machine with no certificate, such as the GitHub runner before the
 * signing secrets exist (as T3 Code builds when CSC_LINK is missing): the hardened runtime and team checks are
 * reported as skipped, not passed. A release is always signed.
 * Returns a list of { name, ok, detail, skipped? }.
 */
export async function checkApp(app: string, { release = false, signed = true }: { release?: boolean; signed?: boolean } = {}): Promise<Result[]> {
  if (release && !signed) throw new Error('A release build is always signed.');
  const results: Result[] = [];
  const add = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail: detail.trim() });
  const skip = (name: string) => results.push({ name, ok: true, skipped: true, detail: AD_HOC });
  const verify = sh('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  add('codesign --verify --deep --strict', verify.ok, verify.ok ? '' : verify.out);
  const info = sh('/usr/bin/codesign', ['-dvvv', app]).out;
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(info)?.[1] || '';
  if (signed) add('hardened runtime', flags.split(',').includes('runtime'), `flags: ${flags || 'none'}`);
  else skip('hardened runtime');
  const team = /TeamIdentifier=(\S+)/.exec(info)?.[1] || 'none';
  if (signed) add(`team ${TEAM_ID}`, team === TEAM_ID, `TeamIdentifier=${team}`);
  else skip(`team ${TEAM_ID}`);
  if (release) {
    const authority = /Authority=(.+)/.exec(info)?.[1] || 'none';
    add('Developer ID signature', authority.startsWith('Developer ID Application: '), `Authority=${authority}`);
  }
  const keys = entitlementKeys(sh('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', app]).stdout);
  add('entitlements: allow-jit only', keys.length === 1 && keys[0] === ALLOWED[0], keys.join(', ') || 'none');
  // Every helper, framework and library too (PR-Agent r1 on #64): --deep verifies signatures, not this policy.
  const loose: string[] = [];
  const files = machOFiles(join(app, 'Contents'));
  for (const file of files) {
    const name = relative(app, file);
    const flagsOf = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(sh('/usr/bin/codesign', ['-dv', file]).out)?.[1] || '';
    if (signed && !flagsOf.split(',').includes('runtime')) loose.push(`${name}: no hardened runtime`);
    const extra = entitlementKeys(sh('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', file]).stdout).filter((k) => !ALLOWED.includes(k));
    if (extra.length) loose.push(`${name}: ${extra.join(', ')}`);
  }
  add(`every signed file${signed ? ' hardened,' : ':'} allow-jit at most (${files.length} files)`, files.length > 0 && loose.length === 0, loose.join('; '));
  if (!signed) skip('every signed file hardened');
  const { getCurrentFuseWire } = await import('@electron/fuses');
  const bad = fuseProblems(await getCurrentFuseWire(app));
  add('fuses', bad.length === 0, bad.join('; '));
  if (release) {
    const gk = sh('/usr/sbin/spctl', ['-a', '-vvv', '-t', 'exec', app]);
    add('Gatekeeper (spctl -t exec)', gk.ok && /accepted/.test(gk.out) && /Notarized Developer ID/.test(gk.out), gk.out);
    const st = sh('/usr/bin/xcrun', ['stapler', 'validate', app]);
    add('stapled ticket (app)', st.ok, st.ok ? '' : st.out);
  }
  return results;
}

/**
 * The section 2 checks on a DMG: its signature and, with `release`, Gatekeeper's open check (`-t install` is for
 * installer packages) and the stapled ticket. electron-builder leaves an ad hoc build's DMG unsigned, so with
 * `signed: false` (as for checkApp) the two signature checks are reported as skipped.
 */
export function checkDmg(dmg: string, { release = true, signed = true }: { release?: boolean; signed?: boolean } = {}): Result[] {
  if (release && !signed) throw new Error('A release build is always signed.');
  const results: Result[] = [];
  const add = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail: detail.trim() });
  if (signed) {
    // Verify the signature, not only read it (PR-Agent r1 on #64): -d prints a signer even for changed bytes.
    const verify = sh('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', dmg]);
    add('DMG codesign --verify --strict', verify.ok, verify.ok ? '' : verify.out);
    const sig = sh('/usr/bin/codesign', ['-dvv', dmg]);
    const team = /TeamIdentifier=(\S+)/.exec(sig.out)?.[1] || 'none';
    add(`DMG signed by team ${TEAM_ID}`, sig.ok && team === TEAM_ID, `TeamIdentifier=${team}`);
  } else {
    for (const name of ['DMG codesign --verify --strict', `DMG signed by team ${TEAM_ID}`]) results.push({ name, ok: true, skipped: true, detail: AD_HOC });
  }
  if (release) {
    const gk = sh('/usr/sbin/spctl', ['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmg]);
    add('Gatekeeper (spctl -t open)', gk.ok && /accepted/.test(gk.out), gk.out);
    const st = sh('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
    add('stapled ticket (DMG)', st.ok, st.ok ? '' : st.out);
  }
  add('not empty', statSync(dmg).size > 0, `${statSync(dmg).size} bytes`);
  return results;
}

/** The top-level `key: value` lines of electron-builder's simple YAML (app-update.yml, the feed), quotes removed. */
export function topLevel(yml: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(yml).split('\n')) {
    const m = /^([A-Za-z][\w]*): ?(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  }
  return out;
}

/**
 * What the app's own update settings must say (app-update.yml, in Contents/Resources): the GitHub feed on the source
 * repo, and an update cache named after this channel's package, so Stable and Nightly never share one.
 * `expected` is { feed: { provider, owner, repo }, pkg, channel }. Returns the problems, empty when right.
 */
export function appUpdateProblems(yml: string, expected: Pick<Expected, 'feed' | 'pkg' | 'channel'>): string[] {
  const got = topLevel(yml);
  const want = { ...expected.feed, updaterCacheDirName: `${expected.pkg}-updater` };
  const problems = Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k} is ${got[k] ?? 'missing'}, should be ${v}`);
  if ((got.channel ?? 'latest') !== expected.channel) problems.push(`channel is ${got.channel ?? 'missing'}, should be ${expected.channel}`);
  return problems;
}

/**
 * What the update feed must say (latest-mac.yml or nightly-mac.yml): this version, the ZIP the updater downloads as
 * its main file, and the DMG. `expected` is { version, zip, dmg }.
 */
export function feedProblems(yml: string, expected: Pick<Expected, 'version' | 'zip' | 'dmg'>): string[] {
  const got = topLevel(yml);
  const urls = [...String(yml).matchAll(/^ {2}- url: (.+)$/gm)].map((m) => m[1]!.trim());
  const problems: string[] = [];
  if (got.version !== expected.version) problems.push(`version is ${got.version ?? 'missing'}, should be ${expected.version}`);
  if (got.path !== expected.zip) problems.push(`path is ${got.path ?? 'missing'}, should be ${expected.zip}`);
  for (const f of [expected.zip, expected.dmg]) if (!urls.includes(f)) problems.push(`no entry for ${f}`);
  return problems;
}

/**
 * The checks that tell Stable and Nightly apart in a built app: bundle ID, name, version and update settings.
 * `expected` is { appId, name, version, channel, pkg, feed } (build/package.ts).
 */
export function checkBuild(app: string, expected: Omit<Expected, 'dmg' | 'zip'>): Result[] {
  const results: Result[] = [];
  const add = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail: detail.trim() });
  let plist: Record<string, unknown> = {};
  try { plist = JSON.parse(sh('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')]).stdout); } catch { plist = {}; }
  add(`bundle ID ${expected.appId}`, plist.CFBundleIdentifier === expected.appId, `CFBundleIdentifier=${plist.CFBundleIdentifier || 'none'}`);
  add(`name ${expected.name}`, plist.CFBundleName === expected.name && plist.CFBundleDisplayName === expected.name,
    `CFBundleName=${plist.CFBundleName || 'none'}, CFBundleDisplayName=${plist.CFBundleDisplayName || 'none'}`);
  add(`version ${expected.version}`, plist.CFBundleShortVersionString === expected.version, `CFBundleShortVersionString=${plist.CFBundleShortVersionString || 'none'}`);
  let yml = '';
  try { yml = readFileSync(join(app, 'Contents', 'Resources', 'app-update.yml'), 'utf8'); } catch { yml = ''; }
  const bad = yml ? appUpdateProblems(yml, expected) : ['no app-update.yml'];
  add(`update settings: ${expected.feed.owner}/${expected.feed.repo}, ${expected.channel}`, bad.length === 0, bad.join('; '));
  return results;
}

/** The feed file's checks (feedProblems), as results. */
export function checkFeed(file: string, expected: Pick<Expected, 'version' | 'zip' | 'dmg'>): Result[] {
  let yml = '';
  try { yml = readFileSync(file, 'utf8'); } catch { yml = ''; }
  const bad = yml ? feedProblems(yml, expected) : [`no ${file}`];
  return [{ name: `feed ${file.split('/').pop()}: ${expected.version}`, ok: bad.length === 0, detail: bad.join('; ') }];
}

/** One result as a line: ok, FAIL, or skip for a check an unsigned dry run cannot run. */
export const resultLine = (r: Result): string => `${r.skipped ? 'skip' : r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `: ${r.detail.split('\n').join(' | ')}` : ''}`;

/** Print results; true when every check passed or was skipped. */
export function report(results: readonly Result[]): boolean {
  for (const r of results) console.log(resultLine(r));
  return results.every((r) => r.ok);
}
