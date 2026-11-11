// Changed files and line ranges, from git's own diff format. No repository is made: git's answers are fixtures,
// and a temp folder holds the untracked files.
import { test, onTestFinished } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDiff, rangesOf, readChanges, createChanges, execGit, gitWhy, LOCKFILE, LIMITS, remoteRepo, branchOk } from './changes.ts';
import type { ChangesRead, GitRunner, ReadChangesOptions } from './changes.ts';
import { checked, nth, whyOf } from './test/expect.ts';
import { createFollower } from './follow.ts';
import type { Read } from './follow.ts';

// `git diff-index -p -U0` output as git writes it: several hunks, a pure deletion and a pure addition, content that
// looks like headers, an added, a deleted, a binary and a mode-only file, and quoted and spaced paths.
const DIFF = [
  'diff --git a/client/a.mjs b/client/a.mjs',
  'index 1111111..2222222 100644',
  '--- a/client/a.mjs',
  '+++ b/client/a.mjs',
  '@@ -3 +3 @@ export const x = 1;',
  '-old',
  '+new',
  '@@ -10,2 +9,0 @@ function y() {',
  '-gone 1',
  '-gone 2',
  '@@ -20,0 +19,3 @@',
  '+diff --git a/x b/x',
  '+@@ -1 +1 @@',
  '+new file mode 100644',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
  '\\ No newline at end of file',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  '--- a dash line',
  '-x',
  '-y',
  'diff --git a/img.png b/img.png',
  'index 5555555..6666666 100644',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/run.sh b/run.sh',
  'old mode 100644',
  'new mode 100755',
  'diff --git "a/caf\\303\\251 \\"menu\\".md" "b/caf\\303\\251 \\"menu\\".md"',
  'index 7777777..8888888 100644',
  '--- "a/caf\\303\\251 \\"menu\\".md"',
  '+++ "b/caf\\303\\251 \\"menu\\".md"',
  '@@ -1 +1,2 @@',
  '-a',
  '+b',
  '+c',
  'diff --git a/with space.txt b/with space.txt',
  'index 9999999..aaaaaaa 100644',
  '--- a/with space.txt\t',
  '+++ b/with space.txt\t',
  '@@ -5,0 +6 @@ ctx',
  '+added',
  '',
].join('\n');

test('git\'s diff: files, kinds and hunks, whatever the content looks like', () => {
  const { files, truncated } = parseDiff(DIFF);
  assert.equal(truncated, false);
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(by), ['client/a.mjs', 'new.txt', 'old.txt', 'img.png', 'café "menu".md', 'with space.txt'], 'a mode-only change is no changed line');
  assert.deepEqual(by['client/a.mjs'], { path: 'client/a.mjs', kind: 'modified', added: 4, removed: 3, hunks: [[3, 1, 3, 1], [10, 2, 9, 0], [20, 0, 19, 3]] });
  assert.deepEqual([by['new.txt']?.kind, by['new.txt']?.hunks, by['new.txt']?.added], ['added', [[0, 0, 1, 2]], 2]);
  assert.deepEqual([by['old.txt']?.kind, by['old.txt']?.hunks, by['old.txt']?.removed], ['deleted', [[1, 3, 0, 0]], 3]);
  assert.deepEqual([by['img.png']?.binary, by['img.png']?.hunks], [true, []]);
  assert.deepEqual(by['café "menu".md']?.hunks, [[1, 1, 1, 2]]);
  assert.deepEqual(by['with space.txt']?.hunks, [[5, 0, 6, 1]]);
});

test('line ranges: the worktree\'s side and the base\'s, a deletion as the gap it leaves', () => {
  const a = nth(parseDiff(DIFF).files);
  assert.deepEqual(rangesOf(a), [[3, 3], [10, 9], [19, 21]]);
  assert.deepEqual(rangesOf(a, 'old'), [[3, 3], [10, 11], [21, 20]]);
});

test('limits: too many files or hunks says so, and keeps the counts', () => {
  const capped = parseDiff(DIFF, { files: 2, hunks: 1 });
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.files.map((f) => f.path), ['client/a.mjs', 'new.txt']);
  assert.equal(capped.files[0]?.more, true);
  assert.equal(capped.files[0]?.hunks.length, 1);
  assert.equal(capped.files[0]?.added, 4, 'the counts still cover every hunk');
});

/** What the fake git knows: origin's branches and HEAD, the diff, untracked, generated and filtered files, which
 *  commands fail or warn, its version, partial-clone config and filter drivers. */
interface FakeGitOptions {
  origins?: string[]; head?: string | null; diff?: string; others?: string[]; generated?: string[]; fail?: Record<string, string>;
  warn?: Record<string, string>; version?: string; partial?: string | null; drivers?: string[]; filtered?: Record<string, string>;
}
/** One command the fake git was asked: its folder, arguments, leading `-c` config and stdin. */
interface GitCall { folder: string; args: string[]; config: string[]; input: string | null }
// A fake git: answers by command, and records every command it was asked.
function fakeGit(dir: string, { origins = ['main'], head = 'refs/remotes/origin/main', diff = DIFF, others = [], generated = [], fail = {}, warn = {}, version = 'git version 2.54.0', partial = null, drivers = [], filtered = {} }: FakeGitOptions = {}): { run: GitRunner; calls: GitCall[] } {
  const calls: GitCall[] = [];
  const run: GitRunner = async (folder, all, opts = {}) => {
    let args = all;
    // Leading `-c name=value` pairs are config for this one command.
    const config: string[] = [];
    while (args[0] === '-c') { config.push(String(args[1])); args = args.slice(2); }
    calls.push({ folder, args, config, input: opts.input ?? null });
    const cmd = args[0] ?? '';
    if (cmd in fail) throw Object.assign(new Error('git failed'), { stderr: fail[cmd] });
    if (cmd in warn) opts.onStderr?.(String(warn[cmd]));
    if (cmd === 'rev-parse' && args[1] === '--show-toplevel') return `${dir}\nabc123\n`;
    if (cmd === 'log' && args.join(' ') === 'log -1 --format=%ct HEAD') return '1794384000\n';
    if (cmd === 'rev-parse' && args[1] === '--verify') {
      const b = /^refs\/remotes\/origin\/(.*)\^\{commit\}$/.exec(args[3] ?? '')?.[1];
      if (b !== undefined && origins.includes(b)) return 'sha\n';
      throw Object.assign(new Error('no such ref'), { stderr: '' });
    }
    if (cmd === 'symbolic-ref') { if (head) return head + '\n'; throw Object.assign(new Error('no ref'), { stderr: '' }); }
    if (cmd === 'merge-base') return 'mb1\n';
    if (cmd === 'version') return version + '\n';
    // `config --get-regexp` exits 1 when nothing matches: a full clone.
    if (cmd === 'config' && args.includes('--get-regexp')) {
      const exit1 = Object.assign(new Error('exit 1'), { code: 1, stderr: '' });
      // The pattern is applied as git applies it, so a driver it misses is missed here too.
      const pattern = args.at(-1) ?? '';
      if (pattern.startsWith('^filter')) {
        const keys = drivers.flatMap((d) => [`filter.${d}.clean`, `filter.${d}.process`]).filter((k) => new RegExp(pattern).test(k));
        if (keys.length) return keys.map((k) => k + '\0').join('');
        throw exit1;
      }
      if (partial) return partial + '\n';
      throw exit1;
    }
    if (cmd === 'config') return 'git@github.com:Owner/repo.git\n';
    if (cmd === 'diff-index') return diff;
    if (cmd === 'ls-files') return others.map((p) => p + '\0').join('');
    if (cmd === 'check-attr') {
      const attrs = args.slice(args.indexOf('--stdin') + 1);
      const value = (p: string, a: string) => (a === 'linguist-generated' ? (generated.includes(p) ? 'set' : 'unspecified') : a === 'filter' ? (p in filtered ? filtered[p] : 'unspecified') : 'unspecified');
      return (opts.input ?? '').split('\0').flatMap((p) => attrs.map((a) => `${p}\0${a}\0${value(p, a)}\0`)).join('');
    }
    throw new Error('unexpected git ' + args.join(' '));
  };
  return { run, calls };
}
const READ_ONLY = new Set(['rev-parse', 'symbolic-ref', 'merge-base', 'diff-index', 'ls-files', 'check-attr', 'config', 'version', 'log']);
/** The first command the fake git was asked with this name, or the test fails. */
const callOf = (git: { calls: GitCall[] }, cmd: string): GitCall => { const c = git.calls.find((x) => x.args[0] === cmd); assert.ok(c, `no git ${cmd}`); return c; };
/** A checked read with nothing changed, for stand-in readers. */
const CLEAN: Extract<ChangesRead, { state: 'checked' }> = {
  state: 'checked', at: 0, folder: '', head: 'h', headAt: null, base: { ref: 'origin/main', branch: 'main', from: 'origin/HEAD', commit: 'mb1' }, remote: null,
  files: [], added: 0, removed: 0, size: { files: 0, added: 0, removed: 0 }, truncated: false,
};

test('one folder: committed, staged, unstaged and untracked changes against the merge base, read only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yc-changes-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'notes.md'), 'a\nb\nc\n');
  writeFileSync(join(dir, 'tail.md'), 'a\nb');
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 0, 2]));
  writeFileSync(join(dir, 'package-lock.json'), '{\n}\n');
  const git = fakeGit(dir, { others: ['notes.md', 'tail.md', 'blob.bin', 'package-lock.json'], generated: ['new.txt'] });
  const r = checked(await readChanges(dir, { run: git.run, now: () => 5000 }));
  assert.equal(r.state, 'checked');
  assert.deepEqual([r.folder, r.head, r.at], [dir, 'abc123', 5000]);
  assert.deepEqual(r.base, { ref: 'origin/main', branch: 'main', from: 'origin/HEAD', commit: 'mb1' });
  assert.deepEqual(r.remote, { host: 'github.com', repo: 'Owner/repo' });
  assert.ok(git.calls.filter((c) => c.args[0] === 'config').every((c) => c.args.includes('--get') || c.args.includes('--get-regexp')), 'config is only read');
  assert.ok(git.calls.some((c) => c.args.join(' ') === 'config --get remote.origin.url'));
  const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.deepEqual([by['notes.md']?.kind, by['notes.md']?.hunks, by['tail.md']?.added], ['untracked', [[0, 0, 1, 3]], 2]);
  assert.equal(by['blob.bin']?.binary, true);
  assert.equal(by['package-lock.json']?.lock, true);
  assert.equal(by['new.txt']?.generated, true);
  // The size leaves out the lockfile and the generated file.
  assert.equal(r.files.length, 10);
  // When the head commit was made, from git's own clock for it (3b PR 4b).
  assert.equal(r.headAt, 1794384000 * 1000);
  assert.deepEqual(r.size, { files: 8, added: 4 + 2 + 1 + 3 + 2, removed: 3 + 3 + 1 });
  assert.equal(r.added, r.size.added + 2 + 2);
  // Only reads, at the merge base, with no external diff, text conversion or rename guessing.
  assert.deepEqual([...new Set(git.calls.map((c) => c.args[0] ?? ''))].filter((c) => !READ_ONLY.has(c)), []);
  const d = callOf(git, 'diff-index').args;
  for (const flag of ['-p', '-U0', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/']) assert.ok(d.includes(flag), flag);
  assert.deepEqual(d.slice(-2), ['mb1', '--']);
  assert.equal(String(callOf(git, 'check-attr').input).split('\0').length, 10);
});

test('the base: the pull request\'s branch when it is here, else origin\'s default; a strange name is never passed', async () => {
  const dir = tmpdir();
  let git = fakeGit(dir, { origins: ['main', 'staging'] });
  assert.deepEqual(checked(await readChanges(dir, { run: git.run, branch: 'staging' })).base, { ref: 'origin/staging', branch: 'staging', from: 'pull request', commit: 'mb1' });
  git = fakeGit(dir);
  assert.equal(checked(await readChanges(dir, { run: git.run, branch: 'not-fetched' })).base.from, 'origin/HEAD');
  git = fakeGit(dir);
  await readChanges(dir, { run: git.run, branch: '--upload-pack=touch /tmp/x' });
  assert.ok(!JSON.stringify(git.calls).includes('upload-pack'));
});

test('not checked, with the reason: no folder, no repo, no commits, no base, no shared commit, no git, too slow', async () => {
  const dir = tmpdir();
  const why = async (opts: ReadChangesOptions, folder = dir) => whyOf(await readChanges(folder, opts));
  assert.equal(await why({ run: fakeGit(dir).run }, join(dir, 'yc-no-such-folder-x')), 'the folder is gone');
  assert.equal(await why({ run: fakeGit(dir, { fail: { 'rev-parse': 'fatal: not a git repository (or any of the parent directories): .git' } }).run }), 'not a git repository (or any of the parent directories): .git');
  assert.equal(await why({ run: fakeGit(dir, { fail: { 'rev-parse': "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree." } }).run }), 'the folder has no commits yet');
  assert.equal(await why({ run: fakeGit(dir, { head: null }).run }), 'no base branch: origin/HEAD is not set');
  assert.equal(await why({ run: fakeGit(dir, { head: null }).run, branch: 'x' }), 'no base branch: origin/x is not here and origin/HEAD is not set');
  assert.equal(await why({ run: fakeGit(dir, { fail: { 'merge-base': '' } }).run }), 'HEAD shares no commit with origin/main');
  assert.equal(gitWhy({ code: 'ENOENT' }), 'git is not on this Mac');
  assert.equal(gitWhy({ killed: true }), 'git took longer than 15 s');
  assert.equal(gitWhy({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'the diff is larger than 32 MB');
});

test('an untracked file over the read cap is unknown, never guessed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yc-changes-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'big.log'), 'x\n'.repeat(100));
  const r = checked(await readChanges(dir, { run: fakeGit(dir, { diff: '', others: ['big.log'] }).run, limits: { ...LIMITS, files: 10, hunks: 10, untracked: 10, untrackedBytes: 50 } }));
  assert.deepEqual(r.files, [{ path: 'big.log', kind: 'untracked', added: null, removed: 0, hunks: [] }]);
  assert.equal(r.size.added, null);
});

test('git itself: inherited GIT_ variables are dropped, optional locks are off, and the config pins a pure read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yc-git-'));
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.GIT_DIR; });
  const fake = join(dir, 'git');
  writeFileSync(fake, '#!/bin/sh\nenv | grep "^GIT_" | sort\necho "args: $*"\ncat\n');
  chmodSync(fake, 0o755);
  process.env.GIT_DIR = '/somewhere/else';
  const out = await execGit(dir, ['diff-index', 'x'], { git: fake, input: 'stdin here' });
  assert.ok(out.includes('GIT_OPTIONAL_LOCKS=0'));
  assert.ok(out.includes('GIT_NO_LAZY_FETCH=1'), 'a partial clone never fetches');
  assert.ok(out.includes('GIT_TERMINAL_PROMPT=0'));
  assert.ok(!out.includes('GIT_DIR='));
  assert.ok(out.includes('args: -c core.fsmonitor=false -c core.quotePath=true diff-index x'));
  assert.ok(out.includes('stdin here'));
  await assert.rejects(execGit(dir, ['status'], { git: join(dir, 'no-git') }), (ex) => gitWhy(ex) === 'git is not on this Mac');
  // Git that exits before reading a long stdin: a failed read, not a crash.
  const quits = join(dir, 'quits');
  writeFileSync(quits, ['#!/bin/sh', 'echo "fatal: bad config" >&2', 'exit 128', ''].join('\n'));
  chmodSync(quits, 0o755);
  await assert.rejects(execGit(dir, ['check-attr', '-z', '--stdin', 'x'], { git: quits, input: 'p\0'.repeat(4 << 20) }), (ex) => gitWhy(ex) === 'bad config');
});

test('the base is named in full to git, so a local "origin/main" never stands in for it', async () => {
  const dir = tmpdir();
  for (const [branch, full] of [['staging', 'refs/remotes/origin/staging'], [null, 'refs/remotes/origin/main']] as const) {
    const git = fakeGit(dir, { origins: ['main', 'staging'] });
    const r = checked(await readChanges(dir, { run: git.run, branch }));
    assert.deepEqual(callOf(git, 'merge-base').args, ['merge-base', 'HEAD', full]);
    assert.equal(r.base.ref, full.slice('refs/remotes/'.length), 'people still read the short name');
  }
});

test('an untracked file this process cannot read is a change of unknown size, never left out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yc-changes-'));
  onTestFinished(() => { chmodSync(join(dir, 'secret.txt'), 0o644); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, 'secret.txt'), 'a\n');
  chmodSync(join(dir, 'secret.txt'), 0o000);
  const r = checked(await readChanges(dir, { run: fakeGit(dir, { diff: '', others: ['secret.txt', 'gone.txt'] }).run }));
  assert.deepEqual(r.files, [{ path: 'secret.txt', kind: 'untracked', added: null, removed: 0, hunks: [] }], 'a file gone since git listed it is not a change');
  assert.equal(r.size.added, null);
});

test('lockfiles by name', () => {
  for (const p of ['package-lock.json', 'web/yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'ios/Podfile.lock', 'uv.lock']) assert.ok(LOCKFILE.test(p), p);
  for (const p of ['lock.mjs', 'docs/package-lock.json.md', 'clock.txt']) assert.ok(!LOCKFILE.test(p), p);
});

test('following threads: one read per folder, a few at a time, again when a thread moves or a minute passes', async () => {
  let t = 1000;
  const reads: { folder: string; branch: string | null; done: (extra?: Partial<typeof CLEAN>) => void }[] = [], heard: string[][] = [];
  const read = (folder: string, { branch }: { branch: string | null }) => new Promise<ChangesRead>((resolve) => reads.push({ folder, branch, done: (extra = {}) => resolve({ ...CLEAN, at: t, folder, ...extra }) }));
  const c = createChanges({ read, now: () => t, concurrency: 2, every: 60000, gap: 10000, maxAge: 180000 });
  c.subscribe((x) => heard.push(x.ids));
  const tick = () => new Promise((r) => setImmediate(r));
  const targets = (stampA = 's1') => [
    { id: 'a', folder: '/w/1', stamp: stampA }, { id: 'b', folder: '/w/1', stamp: 's0' },
    { id: 'c', folder: '/w/2', branch: 'staging' }, { id: 'd', folder: '/w/3' }, { id: 'e', folder: null },
  ];
  c.want(targets());
  assert.deepEqual(reads.map((r) => [r.folder, r.branch]), [['/w/1', null], ['/w/2', 'staging']], 'two at a time; a shared folder is read once');
  assert.deepEqual([whyOf(c.get('a')), whyOf(c.get('e')), whyOf(c.get('zz'))], ['not read yet', 'T3 Code gives this thread no folder', 'not followed']);
  nth(reads, 0).done();
  await tick();
  assert.equal(reads.length, 3, 'the queue moves on');
  assert.equal(c.get('a').state, 'checked');
  assert.equal(c.get('b'), c.get('a'));
  assert.deepEqual(heard, [['a', 'b']]);
  nth(reads, 1).done(); nth(reads, 2).done();
  await tick();
  // Nothing moved: no read. A thread moves: read again, but not more often than the gap.
  t += 5000; c.want(targets());
  assert.equal(reads.length, 3);
  t += 1000; c.want(targets('s2'));
  assert.equal(reads.length, 3, 'within the gap');
  t += 5000; c.want(targets('s2'));
  assert.deepEqual(reads.slice(3).map((r) => r.folder), ['/w/1']);
  nth(reads, 3).done();
  await tick();
  assert.equal(heard.length, 3, 'the same result again is not news');
  // Every minute anyway.
  t += 60000; c.want(targets('s2'));
  assert.deepEqual(reads.slice(4).map((r) => r.folder).sort(), ['/w/1', '/w/2']);
  // A read that hangs leaves the last one, until it is too old to show as current.
  t += 180001;
  assert.equal(c.get('a').state, 'not-checked');
  assert.match(whyOf(c.get('a')), /^last read \d+ s ago$/);
  // Threads no longer followed are dropped.
  c.want([]);
  assert.equal(whyOf(c.get('a')), 'not followed');
  // After stop, a read still on its way tells no one and starts nothing.
  for (const r of reads) r.done();
  await tick();
  c.want(targets('s3'));
  const before = [reads.length, heard.length];
  assert.equal(reads.length, 8, 'two new reads on their way');
  c.stop();
  for (const r of reads) r.done({ files: [{ path: 'late', kind: 'modified', added: 1, removed: 0, hunks: [] }] });
  await tick();
  c.want(targets('s4'));
  assert.deepEqual([reads.length, heard.length], before);
});

test('an untracked directory git cannot open is a change of unknown size, never a clean folder', async () => {
  const dir = tmpdir();
  const warn = { 'ls-files': "warning: could not open directory 'build/cache/': Permission denied\n" };
  const r = checked(await readChanges(dir, { run: fakeGit(dir, { diff: '', warn }).run }));
  assert.equal(r.state, 'checked');
  assert.deepEqual(r.files, [{ path: 'build/cache/', kind: 'untracked', added: null, removed: 0, hunks: [], unreadable: true }]);
  assert.equal(r.size.added, null);
  // And execGit passes a succeeding command's warnings on.
  const g = mkdtempSync(join(tmpdir(), 'yc-git-'));
  const fake = join(g, 'git');
  writeFileSync(fake, ['#!/bin/sh', 'echo "warning: careful" >&2', 'printf ok', ''].join('\n'));
  chmodSync(fake, 0o755);
  let heard = '';
  assert.equal(await execGit(g, ['ls-files'], { git: fake, onStderr: (e) => { heard += e; } }), 'ok');
  assert.equal(heard.trim(), 'warning: careful');
  rmSync(g, { recursive: true, force: true });
});

test('following: a folder dropped and wanted again before its turn is read once', async () => {
  const reads: { folder: string; done: () => void }[] = [];
  const c = createChanges({ read: (folder) => new Promise<ChangesRead>((resolve) => reads.push({ folder, done: () => resolve({ ...CLEAN, at: 1 }) })), now: () => 1, concurrency: 1 });
  const a = { id: 'a', folder: '/w/a' }, b = { id: 'b', folder: '/w/b' };
  c.want([a, b]);
  c.want([a]);
  c.want([a, b]);
  nth(reads, 0).done();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(reads.map((r) => r.folder), ['/w/a', '/w/b']);
  nth(reads, 1).done();
  await new Promise((r) => setImmediate(r));
  assert.equal(reads.length, 2, 'the second queue entry starts nothing');
  c.stop();
});

test('the repo a remote names: https, ssh and scp style; anything else is unknown', () => {
  for (const u of ['https://github.com/o/r.git', 'https://github.com/o/r', 'git@github.com:o/r.git', 'ssh://git@github.com/o/r.git', 'https://x-token@github.com/o/r.git\n']) assert.deepEqual(remoteRepo(u), { host: 'github.com', repo: 'o/r' }, u);
  assert.deepEqual(remoteRepo('https://GHE.example.com:8443/team/app.git'), { host: 'ghe.example.com', repo: 'team/app' });
  for (const u of ['', '/srv/git/r.git', 'file:///srv/r', 'https://github.com/only-owner']) assert.equal(remoteRepo(u), null, u);
});

test('a partial clone is read only by a git that will not fetch for it (Git 2.44 and later); an older git says why', async () => {
  const dir = tmpdir();
  const OLD = 'git version 2.39.5 (Apple Git-154)';
  // An older git in a partial clone: nothing that could fetch runs.
  let git = fakeGit(dir, { version: OLD, partial: 'extensions.partialclone origin' });
  let r = await readChanges(dir, { run: git.run });
  assert.equal(r.state, 'not-checked');
  assert.equal(whyOf(r), 'a partial clone, and git 2.39 may fetch from its remote to read it; Git 2.44 or later does not');
  assert.ok(!git.calls.some((c) => ['diff-index', 'merge-base', 'ls-files'].includes(c.args[0] ?? '')));
  // A promisor remote alone makes a partial clone too.
  git = fakeGit(dir, { version: OLD, partial: 'remote.origin.promisor true' });
  assert.equal((await readChanges(dir, { run: git.run })).state, 'not-checked');
  // An older git in a full clone reads as before.
  git = fakeGit(dir, { version: OLD });
  assert.equal((await readChanges(dir, { run: git.run })).state, 'checked');
  // A git that honours GIT_NO_LAZY_FETCH reads a partial clone without asking whether it is one.
  git = fakeGit(dir, { partial: 'extensions.partialclone origin' });
  assert.equal((await readChanges(dir, { run: git.run })).state, 'checked');
  assert.ok(!git.calls.some((c) => c.args[1] === '--get-regexp'));
  // A git whose version cannot be read is treated as old.
  git = fakeGit(dir, { version: 'something else', partial: 'extensions.partialclone origin' });
  assert.equal(whyOf(await readChanges(dir, { run: git.run })), 'a partial clone, and this git may fetch from its remote to read it; Git 2.44 or later does not');
});

test('following: a read too old to show, read again the same, is news', async () => {
  let t = 0;
  const heard: string[][] = [];
  const c = createChanges({ read: () => Promise.resolve<ChangesRead>({ ...CLEAN, at: t }), now: () => t, every: 60000, maxAge: 180000 });
  c.subscribe((x) => heard.push(x.ids));
  c.want([{ id: 'a', folder: '/w/a' }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(heard.length, 1);
  // The Mac slept: the read is too old, so get() says "not checked".
  t = 400000;
  assert.equal(c.get('a').state, 'not-checked');
  c.want([{ id: 'a', folder: '/w/a' }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(c.get('a').state, 'checked');
  assert.deepEqual(heard, [['a'], ['a']], 'the reader hears that it is current again');
  // A fresh read that finds the same again is not news.
  t = 470000;
  c.want([{ id: 'a', folder: '/w/a' }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(heard.length, 2);
  c.stop();
});

test('following: a read with no time shows as read, and an error with no message logs its name (as before the port)', async () => {
  let t = 0;
  const lines: string[] = [];
  const f = createFollower<null, Read>({ read: () => ({ state: 'checked' }), now: () => t, every: 60000, maxAge: 180000, log: (l) => lines.push(l) });
  f.subscribe(() => { throw new Error(''); });
  f.want([{ id: 'a', key: 'k', args: null }]);
  await new Promise((r) => setImmediate(r));
  t = 400000;
  assert.equal(f.get('a').state, 'checked');
  assert.deepEqual(lines, ['a read listener failed: Error']);
  f.stop();
});

test('no clean filter runs: every configured driver is off for the read, and a changed file one filters has an unknown size', async () => {
  const dir = tmpdir();
  // git-lfs's clean writes the object it hashes into .git/lfs/objects; any configured filter command could do more.
  const git = fakeGit(dir, { drivers: ['lfs', 'my.crypt'], filtered: { 'img.png': 'lfs', 'client/a.mjs': 'not-configured' } });
  const r = checked(await readChanges(dir, { run: git.run }));
  assert.equal(r.state, 'checked');
  const off = ['filter.lfs.clean=', 'filter.lfs.process=', 'filter.lfs.required=false', 'filter.my.crypt.clean=', 'filter.my.crypt.process=', 'filter.my.crypt.required=false'];
  assert.deepEqual(callOf(git, 'diff-index').config, off);
  const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.deepEqual([by['img.png']?.added, by['img.png']?.removed, by['img.png']?.hunks, by['img.png']?.filtered], [null, null, [], true], 'its raw bytes are not what git would store');
  assert.equal(by['client/a.mjs']?.filtered, undefined, 'a filter attribute with no configured driver runs nothing');
  assert.deepEqual([r.added, r.removed], [null, null]);
  // With no driver configured, nothing changes: no -c, no unknown sizes.
  const plain = fakeGit(dir);
  assert.equal(plain.calls.length, 0);
  const p = checked(await readChanges(dir, { run: plain.run }));
  assert.ok(plain.calls.every((c) => c.config.length === 0));
  assert.ok(p.files.every((f) => !f.filtered));
  // A driver name git could not be told to skip: not checked.
  const odd = fakeGit(dir, { drivers: ['a=b'] });
  assert.equal(whyOf(await readChanges(dir, { run: odd.run })), 'a filter driver git cannot be told to skip');
});

test('a filter driver with an empty name is turned off too (git runs `[filter ""]` for `filter=`)', async () => {
  const dir = tmpdir();
  const git = fakeGit(dir, { drivers: [''], filtered: { 'img.png': '' } });
  const r = checked(await readChanges(dir, { run: git.run }));
  assert.equal(r.state, 'checked');
  assert.deepEqual(callOf(git, 'diff-index').config, ['filter..clean=', 'filter..process=', 'filter..required=false']);
  assert.equal(r.files.find((f) => f.path === 'img.png')?.filtered, true);
});

test('the pull request\'s base: any name git takes for a branch is used; any other is "not checked", never origin\'s default', async () => {
  const dir = tmpdir();
  for (const ok of ['release/v1+hotfix', 'feat/a,b', 'v1.2', 'user@x', 'üñí/cødé']) assert.ok(branchOk(ok), ok);
  for (const bad of ['', '-x', '@', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a@{1}', '/a', 'a/', 'a//b', 'a.', '.a', 'a/.b', 'a.lock', 'a/b.lock/c', 'a\x01', 'x'.repeat(256)]) assert.ok(!branchOk(bad), bad);
  let git = fakeGit(dir, { origins: ['main', 'release/v1+hotfix'] });
  assert.deepEqual(checked(await readChanges(dir, { run: git.run, branch: 'release/v1+hotfix' })).base, { ref: 'origin/release/v1+hotfix', branch: 'release/v1+hotfix', from: 'pull request', commit: 'mb1' });
  git = fakeGit(dir);
  const r = await readChanges(dir, { run: git.run, branch: 'a..b' });
  assert.deepEqual([r.state, whyOf(r)], ['not-checked', 'the pull request\'s base branch "a..b" is not a name git takes']);
  assert.deepEqual(git.calls, [], 'git is not asked anything');
  // The follower passes the name on as it is.
  const reads: (string | null)[] = [];
  const c = createChanges({ read: (folder, { branch }) => { reads.push(branch); return new Promise(() => {}); } });
  c.want([{ id: 'a', folder: '/w/a', branch: 'release/v1+hotfix' }]);
  assert.deepEqual(reads, ['release/v1+hotfix']);
  c.stop();
});
