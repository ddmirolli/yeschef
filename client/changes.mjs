// Changed files and line ranges per thread: a read-only `git diff` in each thread's folder, on this Mac.
// The folder is the thread's worktree from T3 Code's shell, or its project's root when it has none, as T3 runs it.
// Every git command here only reads. They are plumbing that never writes the index, with optional locks off: no
// fetch, no hooks, no external diff or text conversion, no fsmonitor daemon, and no clean filter: every configured
// filter driver is off for the read, so a changed file that one filters has an unknown size. Anything unknown is
// "not checked".
import { execFile } from 'node:child_process';
import { open, lstat, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFollower } from './follow.mjs';

export const LIMITS = { files: 2000, hunks: 300, untracked: 200, untrackedBytes: 512 * 1024, output: 32 * 1024 * 1024, timeout: 15000 };

// Lockfiles, which the size of a change leaves out (the Too big call).
export const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|go\.sum|Podfile\.lock|Package\.resolved|flake\.lock|pubspec\.lock|mix\.lock)$/;

// Settings that keep every command a pure read, whatever the repo's own config says.
const CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=true'];
// GIT_NO_LAZY_FETCH: a partial clone missing a blob says so, and is "not checked", instead of fetching it (Git 2.44 and
// later; PR-Agent r1 on #80).
const ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };
// A branch name from T3 Code's data goes to git only as refs/remotes/origin/<name>, and only when it is a name git takes
// for a branch (git check-ref-format --branch). Any other name is "not checked", never swapped for origin's default
// (PR-Agent r3 on #3).
export function branchOk(name) {
  const s = typeof name === 'string' ? name : '';
  if (!s || s.length > 255 || s.startsWith('-') || s === '@') return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(s) || s.includes('..') || s.includes('@{') || s.includes('//')) return false;
  if (s.startsWith('/') || s.endsWith('/') || s.endsWith('.')) return false;
  return s.split('/').every((c) => !c.startsWith('.') && !c.endsWith('.lock'));
}

/** Run one git command in `folder` and return its output. Inherited GIT_* variables are dropped, so nothing points it
 *  at another repo or index. `onStderr` hears what a command that succeeded still said on stderr (its warnings). */
export function execGit(folder, args, { input = null, git = process.env.YESCHEF_GIT || 'git', timeout = LIMITS.timeout, maxBuffer = LIMITS.output, onStderr = null } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return new Promise((done, fail) => {
    const child = execFile(git, [...CONFIG, ...args], { cwd: folder, env: { ...env, ...ENV }, timeout, maxBuffer }, (err, out, errOut) => {
      if (err) { err.stderr = String(errOut || '').trim(); fail(err); return; }
      if (onStderr && errOut) onStderr(String(errOut));
      done(String(out));
    });
    // Git may exit before it reads all of stdin: the exit reaches the callback above, and the broken pipe is not a
    // crash (PR-Agent r1 on #80).
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

/** Why a git command failed, in a few words. */
export function gitWhy(ex) {
  if (ex?.code === 'ENOENT') return 'git is not on this Mac';
  if (ex?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return `the diff is larger than ${LIMITS.output >> 20} MB`;
  if (ex?.killed) return `git took longer than ${LIMITS.timeout / 1000} s`;
  const line = String(ex?.stderr || ex?.message || 'git failed').split('\n').find(Boolean) || 'git failed';
  return line.replace(/^(fatal|error): /, '').slice(0, 160);
}

// Git's C-style quoting of a path ("a/caf\303\251 \"x\"") back to the path.
function unquote(s, i) {
  const bytes = [];
  const esc = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (i++; i < s.length && s[i] !== '"'; i++) {
    if (s[i] !== '\\') { bytes.push(...Buffer.from(s[i])); continue; }
    const c = s[++i];
    if (/[0-7]/.test(c)) { bytes.push(parseInt(s.slice(i, i + 3), 8)); i += 2; } else bytes.push(esc[c] ?? c.charCodeAt(0));
  }
  return { text: Buffer.from(bytes).toString('utf8'), end: i + 1 };
}

// The path in a "diff --git a/P b/P" header. Renames are off, so both sides name the same path.
function headerPath(rest) {
  if (rest.startsWith('"')) return unquote(rest, 0).text.slice(2);
  return rest.slice(2, 2 + (rest.length - 5) / 2);
}

/** Parse `git diff -U0` output into files with their hunks. A hunk is [oldStart, oldCount, newStart, newCount], as in
 *  its @@ line: old lines are the base's, new lines the worktree's. A pure deletion has newCount 0 and sits after
 *  line newStart; a pure addition has oldCount 0. */
export function parseDiff(text, limits = LIMITS) {
  const files = [];
  let f = null, truncated = false;
  for (const line of text.split('\n')) {
    // Content lines start with "+", "-", " " or "\", so none of them is read as a header below.
    if (line.startsWith('diff --git ')) {
      if (files.length >= limits.files) { truncated = true; f = null; continue; }
      f = { path: headerPath(line.slice(11)), kind: 'modified', added: 0, removed: 0, hunks: [] };
      files.push(f);
    } else if (!f) continue;
    else if (line.startsWith('new file mode ')) f.kind = 'added';
    else if (line.startsWith('deleted file mode ')) f.kind = 'deleted';
    else if (line.startsWith('Binary files ')) f.binary = true;
    else if (line.startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const h = [+m[1], m[2] === undefined ? 1 : +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
      f.removed += h[1]; f.added += h[3];
      if (f.hunks.length < limits.hunks) f.hunks.push(h); else { f.more = true; truncated = true; }
    }
  }
  // A modified file with no hunk changed only its mode or its stat data: no line of it changed.
  return { files: files.filter((x) => x.hunks.length || x.binary || x.kind !== 'modified'), truncated };
}

/** The line ranges a file changed, as [start, end] pairs (1-based, inclusive). `side` 'new' reads the worktree's lines,
 *  'old' the base's. A pure deletion is a range of zero length, [n + 1, n], between lines n and n + 1. */
export function rangesOf(file, side = 'new') {
  return (file.hunks || []).map(([os, oc, ns, nc]) => (side === 'old' ? (oc ? [os, os + oc - 1] : [os + 1, os]) : (nc ? [ns, ns + nc - 1] : [ns + 1, ns])));
}

// An untracked file's line count, read from at most `cap` bytes. Git calls a file with a NUL in its first 8000 bytes
// binary. A file over the cap is counted as unknown, never guessed.
async function countLines(path, cap) {
  const st = await lstat(path);
  if (st.isSymbolicLink()) return { lines: 1 };
  if (!st.isFile()) return { lines: null };
  if (st.size > cap) return { lines: null };
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    const b = buf.subarray(0, bytesRead);
    if (b.subarray(0, 8000).includes(0)) return { binary: true, lines: 0 };
    let n = 0;
    for (const c of b) if (c === 10) n++;
    if (b.length && b[b.length - 1] !== 10) n++;
    return { lines: n };
  } finally { await fh.close(); }
}

/** The repo a remote URL names, as { host, repo: 'owner/name' }, or null. Takes https, ssh and scp-style URLs. */
export function remoteRepo(url) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/:]+@)([^/:]+)(?::\d+)?[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? { host: m[1].toLowerCase(), repo: `${m[2]}/${m[3]}` } : null;
}

// The base as a full ref for git (a local branch or tag named "origin/main" must not stand in for it; PR-Agent r1 on
// #80), and as its short name for people.
async function baseOf(run, top, branch) {
  if (branch) {
    const full = `refs/remotes/origin/${branch}`;
    try { await run(top, ['rev-parse', '--verify', '--quiet', `${full}^{commit}`]); return { full, ref: `origin/${branch}`, branch, from: 'pull request' }; }
    catch { /* not fetched here: fall back to origin's default branch */ }
  }
  try {
    const full = (await run(top, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim();
    if (full.startsWith('refs/remotes/origin/')) return { full, ref: full.slice('refs/remotes/'.length), branch: full.slice('refs/remotes/origin/'.length), from: 'origin/HEAD' };
  } catch { /* none */ }
  return null;
}

// GIT_NO_LAZY_FETCH is Git 2.44's. An older git ignores it, and in a partial clone a diff could fetch a missing blob
// from the remote and write it (PR-Agent r1 on #3). So an older git reads only full clones. The version is read once
// per runner; one that cannot be read counts as old.
const versions = new WeakMap();
async function gitVersion(run, top) {
  if (!versions.has(run)) {
    const m = /git version (\d+)\.(\d+)/.exec(await run(top, ['version']).catch(() => ''));
    if (!m) return null;
    versions.set(run, { major: +m[1], minor: +m[2] });
  }
  return versions.get(run);
}
const noLazyFetch = (v) => !!v && (v.major > 2 || (v.major === 2 && v.minor >= 44));
// A partial clone names a promisor: extensions.partialClone, or a remote with promisor set. Any value but an explicit
// false counts. `config --get-regexp` exits 1 when nothing matches.
async function isPartial(run, top) {
  let out;
  try { out = await run(top, ['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$']); }
  catch (ex) { if (ex?.code === 1) return false; throw ex; }
  return out.split('\n').filter(Boolean).some((line) => {
    const [key, ...value] = line.split(' ');
    return /^extensions\.partialclone$/i.test(key) ? value.join(' ') !== '' : !/^(false|no|off|0)$/i.test(value.join(' '));
  });
}

// Clean filters: to diff a file whose stat data changed, git runs the repo's clean filter on it, and a filter may write
// (git-lfs stores the object it hashes in .git/lfs/objects) or run anything its config names (PR-Agent r2 on #3).
// The configured drivers, from every config scope; null when a name could not be passed to `-c`.
async function filterDrivers(run, top) {
  let out;
  // `.*`: git takes an empty driver name (`[filter ""]`, `filter=` in .gitattributes), and runs it (PR-Agent r3 on #3).
  try { out = await run(top, ['config', '-z', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$']); }
  catch (ex) { if (ex?.code === 1) return []; throw ex; }
  const names = new Set();
  for (const key of out.split('\0').filter(Boolean)) {
    const m = /^filter\.(.*)\.(clean|process)$/i.exec(key);
    if (!m || /[=\s]/.test(m[1])) return null;
    names.add(m[1]);
  }
  return [...names];
}
// An empty clean and process command turns a driver off, and required=false keeps git from failing a file over it.
const driversOff = (drivers) => drivers.flatMap((d) => ['-c', `filter.${d}.clean=`, '-c', `filter.${d}.process=`, '-c', `filter.${d}.required=false`]);

/** Read one folder's changes against its base branch: committed, staged, unstaged and untracked, from the point the
 *  folder's HEAD left the base (their merge base). `branch` is the base a thread's pull request names, if any.
 *  Returns { state: 'checked', … } or { state: 'not-checked', why }. */
export async function readChanges(folder, { branch = null, run = execGit, now = Date.now, limits = LIMITS } = {}) {
  const at = now();
  const no = (why) => ({ state: 'not-checked', why, at, folder });
  try { if (!(await stat(folder)).isDirectory()) return no('the folder is not a directory'); } catch { return no('the folder is gone'); }
  if (branch && !branchOk(branch)) return no(`the pull request's base branch ${JSON.stringify(String(branch).slice(0, 80))} is not a name git takes`);
  try {
    let top, head;
    try { [top, head] = (await run(folder, ['rev-parse', '--show-toplevel', 'HEAD'])).trim().split('\n'); }
    catch (ex) { return no(/unknown revision|ambiguous argument 'HEAD'/.test(ex.stderr || '') ? 'the folder has no commits yet' : gitWhy(ex)); }
    const version = await gitVersion(run, top);
    if (!noLazyFetch(version) && await isPartial(run, top)) {
      return no(`a partial clone, and ${version ? `git ${version.major}.${version.minor}` : 'this git'} may fetch from its remote to read it; Git 2.44 or later does not`);
    }
    const drivers = await filterDrivers(run, top);
    if (drivers === null) return no('a filter driver git cannot be told to skip');
    const off = driversOff(drivers);
    const base = await baseOf(run, top, branch);
    if (!base) return no(branch ? `no base branch: origin/${branch} is not here and origin/HEAD is not set` : 'no base branch: origin/HEAD is not set');
    let commit;
    try { commit = (await run(top, ['merge-base', 'HEAD', base.full])).trim(); } catch { return no(`HEAD shares no commit with ${base.ref}`); }
    const diff = await run(top, [...off, 'diff-index', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--ignore-submodules=dirty', '--src-prefix=a/', '--dst-prefix=b/', commit, '--']);
    const parsed = parseDiff(diff, limits);
    const files = parsed.files;
    let truncated = parsed.truncated;
    // A directory git cannot open is only a warning, and its files go unlisted: each one is a change of unknown size,
    // never a clean folder (PR-Agent r2 on #80).
    let warnings = '';
    const others = (await run(top, ['ls-files', '-z', '--others', '--exclude-standard'], { onStderr: (e) => { warnings += e; } })).split('\0').filter(Boolean);
    const unreadable = [...warnings.matchAll(/could not open directory '(.+?)': /g)].map((m) => m[1]);
    const room = Math.max(0, Math.min(limits.untracked, limits.files - files.length));
    if (others.length > room) truncated = true;
    for (const path of others.slice(0, room)) {
      // A file gone since git listed it is not a change. One this process cannot read is a change of unknown size,
      // never left out (PR-Agent r1 on #80).
      const n = await countLines(join(top, path), limits.untrackedBytes).catch((ex) => (ex?.code === 'ENOENT' ? null : { lines: null }));
      if (!n) continue;
      const f = { path, kind: 'untracked', added: n.lines, removed: 0, hunks: n.lines ? [[0, 0, 1, n.lines]] : [] };
      if (n.binary) f.binary = true;
      files.push(f);
    }
    for (const path of unreadable) {
      if (files.length >= limits.files) { truncated = true; break; }
      files.push({ path, kind: 'untracked', added: null, removed: 0, hunks: [], unreadable: true });
    }
    // Generated files (linguist-generated in .gitattributes) and lockfiles are left out of the size. A tracked file
    // that a configured driver filters was diffed as raw bytes, which are not what git would store: its size is
    // unknown, never the raw diff's.
    if (files.length) {
      const out = (await run(top, ['check-attr', '-z', '--stdin', 'linguist-generated', 'filter'], { input: files.map((f) => f.path).join('\0') })).split('\0');
      const generated = new Set(), filtered = new Set();
      for (let i = 0; i + 2 < out.length; i += 3) {
        if (out[i + 1] === 'linguist-generated' && (out[i + 2] === 'set' || out[i + 2] === 'true')) generated.add(out[i]);
        if (out[i + 1] === 'filter' && drivers.includes(out[i + 2])) filtered.add(out[i]);
      }
      for (const f of files) {
        if (generated.has(f.path)) f.generated = true;
        if (LOCKFILE.test(f.path)) f.lock = true;
        if (f.kind !== 'untracked' && filtered.has(f.path)) Object.assign(f, { added: null, removed: null, hunks: [], filtered: true });
      }
    }
    // Which repo this is, for its checks on GitHub (client/github.mjs).
    const remote = remoteRepo(await run(top, ['config', '--get', 'remote.origin.url']).catch(() => ''));
    const sum = (list, k) => list.reduce((n, f) => (n === null || f[k] === null ? null : n + f[k]), 0);
    const counted = files.filter((f) => !f.lock && !f.generated);
    return {
      state: 'checked', at, folder: top, head, base: { ref: base.ref, branch: base.branch, from: base.from, commit }, remote,
      files, added: sum(files, 'added'), removed: sum(files, 'removed'),
      size: { files: counted.length, added: sum(counted, 'added'), removed: sum(counted, 'removed') },
      truncated,
    };
  } catch (ex) { return no(gitWhy(ex)); }
}

/** Keeps every followed thread's changes current (client/follow.mjs): one read per folder and base, a few at a time,
 *  again when a thread in it moves (at most every 10 s) and every minute otherwise; a read over 3 minutes old is
 *  "not checked". want([{ id, folder, branch, stamp }]) each time the board refreshes; get(id); subscribe(fn). */
export function createChanges({ read = readChanges, ...opts } = {}) {
  const f = createFollower({ read: ({ folder, branch }) => read(folder, { branch }), every: 60000, gap: 10000, maxAge: 180000, name: 'changed files', ...opts });
  return {
    ...f,
    want(targets) {
      f.want(targets.map((x) => {
        if (!x.folder) return { id: x.id, why: 'T3 Code gives this thread no folder' };
        const folder = resolve(x.folder), branch = x.branch || null;
        return { id: x.id, key: `${folder}\0${branch || ''}`, args: { folder, branch }, stamp: x.stamp };
      }));
    },
  };
}

// `node client/changes.mjs <folder> [base branch]` prints what the board would read for that folder.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [folder, branch] = process.argv.slice(2);
  if (!folder) { console.error('usage: node client/changes.mjs <folder> [base branch]'); process.exit(2); }
  const r = await readChanges(resolve(folder), { branch: branch || null });
  if (r.state === 'checked') r.files = r.files.map((f) => ({ ...f, ranges: rangesOf(f) }));
  console.log(JSON.stringify(r, null, 1));
}
