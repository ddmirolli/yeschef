// The release, steps 1 to 5 of docs/desktop-release-plan-v0_1.md, section 7. GitHub Actions runs it
// (.github/workflows/release.yml); `npm run release -- 0.2.0` (or `-- nightly`) runs the same three parts on Dan's Mac
// through build/release.zsh, around his Touch ID approval:
//
//   node build/publish.mjs plan <version|nightly|dry-run> <plan file>   check everything, pick the version and the commit
//   node build/publish.mjs build <plan file>                            export that commit, npm ci, build, notarize, check
//   node build/publish.mjs publish <plan file>                          draft release, attach the files, check them, publish
//
// Only `build` needs the signing certificate and the notarization key. `plan` only reads (and fetches main and the
// tags), so it runs anywhere; on Dan's Mac `build` and `publish` refuse to run without a terminal, as release.zsh does.
//
// --ci is the GitHub Actions path, and it refuses to run anywhere else. It changes three things and nothing more:
//   - `build` and `publish` run without a terminal;
//   - `plan` leaves the certificate check to `build` (package.mjs refuses a release without Developer ID before it
//     builds), because the plan runs on a Linux runner with no keychain and the certificate arrives only in `build`;
//   - `build` copies the release files next to the plan file, and `publish` reads them there, because the workflow
//     moves them from the macOS runner to the publishing job as an artifact. `publish` still checks every file's size
//     and sha512 against the build's.
// `plan nightly <file> --if-changed` is the scheduled Nightly: it writes `"due": false` and stops when main has nothing
// new since the newest published Nightly. `plan dry-run <file> [--version <version>]` plans an unsigned build of HEAD
// that is never published: any branch, no clean or main checks, and the next Nightly version unless one is given.
//
// The versions and the commits, as T3 Code's (section 5; its scripts/build-desktop-artifact.ts and release.yml):
//   - Nightly builds main as it is now. Its version is the patch after the newest Stable, then the UTC day and a run
//     number: 0.2.1-nightly.20261110.1 (desktop/channels.mjs). It is a GitHub prerelease, never "latest".
//   - Stable takes the version Dan names and builds the commit of the newest published Nightly, so it ships only a
//     build Nightly users already ran. With no Nightly yet, run `npm run release -- nightly` first.
//   - The version goes into the build (package.mjs --version), not into a commit, so a release pushes nothing to main.
//     The tag, v<version>, is made by GitHub when the release is published, at the commit that was built.
//   - A release stays a draft until every file is attached and checked, so a feed never points at a missing file.
//   - A Stable release's notes are its section in desktop/CHANGELOG.md on main (`## 0.2.0`); the release stops without
//     one (section 5). Nightly notes name the commit.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHANNELS, FEED, channelOf, compareVersions, isReleaseVersion, nextNightly, tagOf } from '../channels.mjs';
import { ARCH, pickIdentity, sha512, teamOf } from './release.mjs';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = join(DESKTOP, '..');
export const REPO = `${FEED.owner}/${FEED.repo}`;
const STABLE_FORM = /^\d+\.\d+\.\d+$/;

/** The release's title on GitHub: the app's name and the version. */
export const releaseTitle = (version) => `${CHANNELS[channelOf(version)].name} ${version}`;

/** The files a release carries: the DMG (for people), the ZIP and its blockmap (for the updater) and the feed. */
export function releaseFiles(version) {
  const name = `Yes-Chef-${version}-${ARCH}`;
  return [`${name}.dmg`, `${name}.zip`, `${name}.zip.blockmap`, `${channelOf(version)}-mac.yml`];
}

/**
 * The plan to publish in Actions: the Plan job's output (`planned`), plus only what the build adds, its time and its
 * files, from the build's plan file (`built`). That file comes from the build job, which runs npm's install scripts,
 * so it decides nothing else. Only `planned` passed the Stable gate. A changed planned field, an added field, or files
 * that are not the version's own stop the release.
 */
export function trustedPlan(planned, built) {
  const show = (v) => { const s = JSON.stringify(v) ?? 'nothing'; return s.length > 80 ? `${s.slice(0, 77)}...` : s; };
  const problems = [];
  if (planned?.due !== true) problems.push('the Plan job planned no release');
  for (const key of Object.keys(planned || {})) {
    if (JSON.stringify(built?.[key]) !== JSON.stringify(planned[key])) problems.push(`${key} is ${show(built?.[key])} in the build's plan, ${show(planned[key])} in Plan's`);
  }
  for (const key of Object.keys(built || {})) {
    if (!Object.hasOwn(planned || {}, key) && key !== 'built' && key !== 'files') problems.push(`the build's plan adds ${key}`);
  }
  const names = (Array.isArray(built?.files) ? built.files : []).map((f) => f?.name).sort();
  const want = planned?.version ? releaseFiles(planned.version).sort() : [];
  if (JSON.stringify(names) !== JSON.stringify(want)) problems.push(`the built files are ${names.join(', ') || 'none'}, not ${want.join(', ')}`);
  if (problems.length) throw new Error(`The build's plan does not match the Plan job's. Not published:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return { ...planned, built: built.built, files: built.files };
}

const versionOf = (tag) => String(tag).replace(/^v/, '');

/** The tag of the newest published Nightly in `releases` (as for pickRelease), or null when there is none. */
export function newestNightly(releases) {
  const nightlies = releases.filter((r) => !r.isDraft && r.isPrerelease).map((r) => versionOf(r.tagName))
    .filter((v) => isReleaseVersion(v) && channelOf(v) === 'nightly');
  return nightlies.length ? tagOf(nightlies.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b))) : null;
}

/**
 * Pick the version, and for Stable the Nightly it ships, from what is on GitHub. `releases` is `gh release list
 * --json tagName,isDraft,isPrerelease`, drafts included. Throws with the reason when the release must not happen.
 * Returns { version, channel, tag, from }: `from` is the Nightly tag a Stable builds (null for Nightly).
 * `arg` 'dry-run' plans a build that is never published: `dryRunVersion`, or else the next Nightly's version, and a
 * draft on GitHub does not stop it.
 */
export function pickRelease({ arg, pkgVersion, releases, date = new Date(), dryRunVersion = '' }) {
  const tags = releases.map((r) => String(r.tagName));
  const published = releases.filter((r) => !r.isDraft);
  const stables = published.filter((r) => !r.isPrerelease).map((r) => versionOf(r.tagName)).filter((v) => STABLE_FORM.test(v));
  if (arg === 'dry-run') {
    const version = dryRunVersion || nextNightly({ stable: [pkgVersion, ...stables], taken: tags, date });
    if (!isReleaseVersion(version)) throw new Error(`"${version}" is not a version Yes Chef builds. Use 1.2.3 or 1.2.4-nightly.20261110.1.`);
    return { version, channel: channelOf(version), tag: tagOf(version), from: null, dryRun: true };
  }
  const drafts = releases.filter((r) => r.isDraft).map((r) => r.tagName);
  if (drafts.length) throw new Error(`A draft release is left from an earlier run: ${drafts.join(', ')}. Check it on GitHub, delete it (gh release delete <tag> --repo ${REPO}), then run this again.`);

  if (arg === 'nightly') {
    const version = nextNightly({ stable: [pkgVersion, ...stables], taken: tags, date });
    return { version, channel: 'nightly', tag: tagOf(version), from: null };
  }
  const version = String(arg || '');
  if (!isReleaseVersion(version) || channelOf(version) !== 'latest') throw new Error(`"${version}" is not a Stable version. Use 1.2.3, or "nightly".`);
  if (tags.includes(tagOf(version))) throw new Error(`${tagOf(version)} is already a release.`);
  const newer = stables.find((v) => compareVersions(v, version) >= 0);
  if (newer) throw new Error(`Stable ${newer} is already out; the next Stable must be newer than every one before it.`);
  const from = newestNightly(releases);
  if (!from) throw new Error('No Nightly is published yet. Stable ships only a build Nightly users ran: release a Nightly first.');
  return { version, channel: 'latest', tag: tagOf(version), from };
}

/**
 * Whether the scheduled Nightly has anything to build: `head` is main now, `last` the commit of the newest published
 * Nightly (null when there is none), and `isAncestor(a, b)` is git's answer to "is a an ancestor of b?". Returns
 * { due, reason }.
 */
export function nightlyDue({ head, last, lastTag, isAncestor }) {
  if (!last) return { due: true, reason: 'No Nightly is published yet.' };
  if (head === last || isAncestor(head, last)) return { due: false, reason: `main (${head.slice(0, 12)}) has nothing new since ${lastTag}.` };
  return { due: true, reason: `main (${head.slice(0, 12)}) has commits since ${lastTag}.` };
}

/** The section `## <version>` of desktop/CHANGELOG.md, without its heading, or null when it is missing or empty. */
export function changelogEntry(text, version) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  const entry = lines.slice(start + 1, end < 0 ? lines.length : end).join('\n').trim();
  return entry || null;
}

/** The files on the draft that do not match the local ones by name and size, or are not fully uploaded. */
export function assetProblems(local, remote) {
  const problems = [];
  for (const f of local) {
    const r = remote.find((a) => a.name === f.name);
    if (!r) problems.push(`${f.name} is not attached`);
    else if (r.size !== f.size) problems.push(`${f.name} is ${r.size} bytes on GitHub, ${f.size} here`);
    else if (r.state && r.state !== 'uploaded') problems.push(`${f.name} is ${r.state}`);
  }
  for (const r of remote) if (!local.some((f) => f.name === r.name)) problems.push(`${r.name} should not be attached`);
  return problems;
}

/** gh's arguments to create the draft, then to publish it. Nightly is a prerelease and never "latest". */
export function ghArgs(plan, notesFile) {
  const nightly = plan.channel === 'nightly';
  return {
    create: ['release', 'create', plan.tag, '--repo', REPO, '--draft', '--target', plan.commit, '--title', releaseTitle(plan.version),
      '--notes-file', notesFile, ...(nightly ? ['--prerelease'] : [])],
    publish: ['release', 'edit', plan.tag, '--repo', REPO, '--draft=false', ...(nightly ? ['--prerelease', '--latest=false'] : ['--latest'])],
  };
}

/** The release notes: Stable's CHANGELOG entry and the Nightly it ships; for Nightly, the commit. */
export function releaseNotes(plan) {
  return plan.channel === 'nightly'
    ? `Nightly build of ${plan.commit.slice(0, 12)}. Yes Chef (Nightly) is its own app: it updates only to newer Nightly builds and keeps its own data.\n`
    : `${plan.notes}\n\nBuilt from ${plan.from} (${plan.commit.slice(0, 12)}), the Nightly build it ships.\n`;
}

/**
 * The command line after `node build/publish.mjs`: { cmd, args, ci, ifChanged, version }. Flags may come anywhere;
 * --version takes the next word. Throws on an unknown flag.
 */
export function parseArgs(argv) {
  const out = { cmd: '', args: [], ci: false, ifChanged: false, version: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--ci') out.ci = true;
    else if (a === '--if-changed') out.ifChanged = true;
    else if (a === '--version') out.version = String(argv[++i] ?? '');
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.`);
    else if (!out.cmd) out.cmd = a;
    else out.args.push(a);
  }
  return out;
}

/** Run `check` (an async function that returns a list of problems) until it returns none, up to `tries` times. */
export async function settle(check, { tries = 8, wait = 15000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let problems = await check();
  for (let i = 1; i < tries && problems.length; i++) {
    await sleep(wait);
    problems = await check();
  }
  return problems;
}

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const gh = (args) => sh('gh', args);
const git = (args) => sh('git', ['-C', REPO_DIR, ...args]);
const fail = (text) => { console.error(text); process.exit(1); };
// The GitHub Actions path (--ci, see the top of this file). Set once, from the command line.
let CI = false;
const needTerminal = () => { if (!CI && !process.stdin.isTTY) fail('Run `npm run release` in your own Terminal window, not from an agent.'); };
const readPlan = (file) => JSON.parse(readFileSync(file, 'utf8'));
const isAncestor = (a, b) => spawnSync('git', ['-C', REPO_DIR, 'merge-base', '--is-ancestor', a, b]).status === 0;

function plan(arg, file, { ifChanged = false, version = '' } = {}) {
  if (!arg || !file) fail('Usage: node build/publish.mjs plan <version|nightly|dry-run> <plan file> [--ci] [--if-changed] [--version <version>]');
  const dry = arg === 'dry-run';
  if (version && !dry) fail('--version is for a dry run. A Stable takes its version as the argument: plan 0.2.0 <plan file>.');
  if (ifChanged && arg !== 'nightly') fail('--if-changed is for the scheduled Nightly only.');
  const problems = [];
  const check = (ok, text) => { if (!ok) problems.push(text); return ok; };
  // A dry run builds whatever is checked out, from any branch, and is never published.
  if (!dry) {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    check(branch === 'main', `This checkout is on ${branch}. Release from main.`);
    check(git(['status', '--porcelain']) === '', 'This checkout has changes. Release from a clean main.');
    // The one write: fetch main and the tags, to compare with GitHub.
    let synced = false;
    try {
      git(['fetch', '--quiet', '--tags', 'origin', 'main']);
      synced = git(['rev-parse', 'HEAD']) === git(['rev-parse', 'origin/main']);
    } catch (e) { problems.push(`git fetch failed: ${e.message.split('\n')[0]}`); }
    check(synced, 'This main is not the same as origin/main. Pull, then run this again.');
  }
  let ghOk = true;
  try { gh(['auth', 'status']); } catch { ghOk = check(false, 'gh is not signed in. Run `gh auth login`.'); }
  if (ghOk) {
    // The app reads the feed with no sign-in: the repo must be public before the first release (section 8).
    const visibility = JSON.parse(gh(['repo', 'view', REPO, '--json', 'visibility'])).visibility;
    check(visibility === 'PUBLIC', `${REPO} is ${String(visibility).toLowerCase()}. The app can read releases only from a public repo.`);
  }
  // On Dan's Mac, before Touch ID. In Actions the plan runs on Linux and the certificate arrives only in `build`,
  // where package.mjs refuses a release without Developer ID from team 8J2K26SZNK before it builds anything.
  if (!CI && !dry) {
    const found = sh('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
    check(!!pickIdentity(found, { release: true, teamOf }), 'No Developer ID Application certificate from team 8J2K26SZNK in this Mac\'s Keychain.');
  }
  let releases = null;
  if (ghOk) {
    try { releases = JSON.parse(gh(['release', 'list', '--repo', REPO, '--limit', '1000', '--json', 'tagName,isDraft,isPrerelease'])); }
    catch (e) { problems.push(`gh release list failed: ${e.message.split('\n')[0]}`); }
  }
  // The scheduled Nightly: when main has nothing new since the newest Nightly, there is nothing to build, and the
  // workflow never reaches the signing step.
  if (ifChanged && releases && !problems.length) {
    const lastTag = newestNightly(releases);
    let last = null;
    try { last = lastTag ? git(['rev-parse', `refs/tags/${lastTag}^{commit}`]) : null; } catch (e) { problems.push(`No commit for ${lastTag}: ${e.message.split('\n')[0]}`); }
    if (!problems.length) {
      const gate = nightlyDue({ head: git(['rev-parse', 'HEAD']), last, lastTag, isAncestor });
      console.log(gate.reason);
      if (!gate.due) {
        writeFileSync(file, JSON.stringify({ due: false, reason: gate.reason }, null, 2) + '\n', { mode: 0o600 });
        console.log('No Nightly today.');
        return;
      }
    }
  }
  let picked = null;
  if (releases) {
    try {
      const pkgVersion = JSON.parse(git(['show', 'HEAD:desktop/package.json'])).version;
      picked = pickRelease({ arg, pkgVersion, releases, dryRunVersion: version });
    } catch (e) { problems.push(e.message); }
  }
  if (picked?.channel === 'latest' && !picked.dryRun) {
    let text = '';
    try { text = git(['show', 'HEAD:desktop/CHANGELOG.md']); } catch { text = ''; }
    picked.notes = changelogEntry(text, picked.version);
    check(!!picked.notes, `desktop/CHANGELOG.md on main has no "## ${picked.version}" section. Add one in a PR: it becomes the release notes.`);
  }
  let commit = null;
  if (picked) {
    try {
      commit = picked.from ? git(['rev-parse', `refs/tags/${picked.from}^{commit}`]) : git(['rev-parse', 'HEAD']);
      if (picked.from) check(isAncestor(commit, 'origin/main'), `${picked.from} (${commit.slice(0, 12)}) is not on main.`);
      if (!picked.dryRun) check(spawnSync('git', ['-C', REPO_DIR, 'rev-parse', '-q', '--verify', `refs/tags/${picked.tag}`]).status !== 0, `The tag ${picked.tag} already exists.`);
    } catch (e) { problems.push(`No commit for ${picked.from || 'HEAD'}: ${e.message.split('\n')[0]}`); }
  }
  if (problems.length) fail(`Not released:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  const p = { ...picked, due: true, commit, title: releaseTitle(picked.version), repo: REPO, plannedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(p, null, 2) + '\n', { mode: 0o600 });
  const what = p.dryRun ? 'DRY RUN, never published' : CHANNELS[p.channel].label;
  console.log(`\n  ${p.title}  (${what})\n  tag ${p.tag} at ${p.commit.slice(0, 12)}${p.from ? `, the commit of ${p.from}` : p.dryRun ? ', HEAD' : ', main now'}\n  repo ${REPO}\n`);
}

function build(file) {
  needTerminal();
  const p = readPlan(file);
  if (!p.due) fail('The plan has nothing to build.');
  // A clean copy of the commit being released: nothing local reaches the build.
  const work = mkdtempSync(join(tmpdir(), 'yeschef-release-'));
  const tree = execFileSync('git', ['-C', REPO_DIR, 'archive', '--format=tar', p.commit], { maxBuffer: 1024 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', work], { input: tree });
  const desktop = join(work, 'desktop');
  console.log(`Building ${p.title}${p.dryRun ? ' (dry run)' : ''} from ${p.commit.slice(0, 12)} in ${work}.`);
  const run = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: desktop, stdio: 'inherit' }); if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed.`); };
  run('npm', ['ci']);
  // Steps 2 to 4: build, fuses, Developer ID, notarize and staple the app and the DMG, the feed rewrite, the checks
  // and a hidden --capture start on a temporary data folder (build/package.mjs). A dry run skips Apple and is
  // signed with whatever this machine has, or ad hoc.
  run('node', ['build/package.mjs', '--dist', ...(p.dryRun ? ['--dry-run'] : []), '--version', p.version]);
  const out = join(desktop, 'out', 'builder');
  const files = releaseFiles(p.version).map((name) => {
    let path = join(out, name);
    if (!existsSync(path)) fail(`The build made no ${name}.`);
    // In Actions the files travel to the publishing job as an artifact, next to the plan file.
    if (CI) { const next = join(dirname(file), name); copyFileSync(path, next); path = next; }
    return { name, path, size: statSync(path).size, sha512: sha512(path) };
  });
  writeFileSync(file, JSON.stringify({ ...p, built: new Date().toISOString(), files }, null, 2) + '\n', { mode: 0o600 });
  console.log(`${p.dryRun ? 'Dry run built and checked, not notarized. Never publish it' : 'Built, notarized and checked'}: ${files.map((f) => f.name).join(', ')}`);
}

async function publish(file) {
  needTerminal();
  let p = readPlan(file);
  if (p.dryRun) fail('A dry run is never published.');
  // In Actions the plan file arrives from the build job, so the Plan job's output decides what is released.
  if (CI) {
    if (!process.env.RELEASE_PLAN) fail('RELEASE_PLAN is empty. In Actions, publish takes the plan from the Plan job\'s output.');
    try { p = trustedPlan(JSON.parse(process.env.RELEASE_PLAN), p); } catch (e) { fail(e.message); }
  }
  if (!p.files?.length) fail('The plan has no built files. Run the build first.');
  // In Actions the files arrive next to the plan file; on Dan's Mac they stay where the build left them.
  const at = (f) => (CI ? join(dirname(file), f.name) : f.path);
  for (const f of p.files) {
    if (!existsSync(at(f)) || statSync(at(f)).size !== f.size || sha512(at(f)) !== f.sha512) fail(`${f.name} changed after the build. Not published.`);
  }
  const notes = join(dirname(file), 'notes.md');
  writeFileSync(notes, releaseNotes(p));
  const args = ghArgs(p, notes);
  // Step 5: a draft first, with every file, then publish.
  gh(args.create);
  console.log(`Draft ${p.tag} created. Attaching ${p.files.length} files.`);
  spawnSync('gh', ['release', 'upload', p.tag, '--repo', REPO, ...p.files.map(at)], { stdio: 'inherit' });
  const view = JSON.parse(gh(['release', 'view', p.tag, '--repo', REPO, '--json', 'assets,isDraft']));
  const bad = assetProblems(p.files, view.assets || []);
  if (!view.isDraft) bad.push('the release is no longer a draft');
  if (bad.length) fail(`The draft ${p.tag} is not right, so it stays a draft:\n${bad.map((b) => `  - ${b}`).join('\n')}\nFix it on GitHub or delete it (gh release delete ${p.tag} --repo ${REPO}).`);
  gh(args.publish);
  console.log(`Published ${p.title}.`);

  // What the app reads, read the way the app reads it: with no sign-in. GitHub can take a minute to list a new
  // release, so this asks again for up to two minutes before it calls the release unseen.
  const feedName = `${p.channel}-mac.yml`;
  const feed = readFileSync(at(p.files.find((f) => f.name === feedName)), 'utf8');
  const after = await settle(async () => {
    const problems = [];
    const tagSha = gh(['api', `repos/${REPO}/git/ref/tags/${p.tag}`, '--jq', '.object.sha']);
    if (tagSha !== p.commit) problems.push(`tag ${p.tag} points at ${tagSha.slice(0, 12)}, built from ${p.commit.slice(0, 12)}`);
    const res = await fetch(`https://github.com/${REPO}/releases/download/${p.tag}/${feedName}`);
    const body = res.ok ? await res.text() : '';
    if (body !== feed) problems.push(`${feedName} on GitHub (${res.status}) is not the file that was built`);
    if (p.channel === 'latest') {
      const latest = await fetch(`https://github.com/${REPO}/releases/latest`, { headers: { accept: 'application/json' } });
      const tag = latest.ok ? (await latest.json()).tag_name : `HTTP ${latest.status}`;
      if (tag !== p.tag) problems.push(`GitHub's latest release is ${tag}, not ${p.tag}`);
    } else {
      const atom = await fetch(`https://github.com/${REPO}/releases.atom`);
      const text = atom.ok ? await atom.text() : '';
      if (!text.includes(`/releases/tag/${p.tag}`)) problems.push(`the releases feed does not list ${p.tag} yet`);
    }
    return problems;
  });
  if (after.length) fail(`Published, but the app may not see it:\n${after.map((a) => `  - ${a}`).join('\n')}`);
  console.log(`Checked: the ${CHANNELS[p.channel].label} feed offers ${p.version}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let o = null;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { fail(e.message); }
  // --ci drops the terminal guard, so it runs only where GitHub Actions says it runs.
  if (o.ci && process.env.GITHUB_ACTIONS !== 'true') fail('--ci is the GitHub Actions path. On a Mac, run `npm run release`.');
  CI = o.ci;
  if (o.cmd === 'plan') plan(o.args[0], o.args[1], o);
  else if (o.cmd === 'build') build(o.args[0]);
  else if (o.cmd === 'publish') await publish(o.args[0]);
  else fail('Usage: node build/publish.mjs plan <version|nightly|dry-run> <plan file> | build <plan file> | publish <plan file>  [--ci]');
}
