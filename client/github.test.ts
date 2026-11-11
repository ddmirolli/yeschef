// GitHub reads with GitHub's own response shapes as fixtures. No network, and no gh beyond a stand-in script.
import { test, onTestFinished } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ghGet, ghWhy, runState, overall, readBaseChecks, readPrSize, createBaseChecks, createPrSizes, prKey, segment, readPrFacts, readBaseFacts } from './github.ts';
import type { BaseChecksRead, PrSizeRead } from './github.ts';
import type { PrRuns } from './pr-runs.ts';
import { checked, whyOf } from './test/expect.ts';

/** A stand-in for gh: each path GitHub would answer, with its body, a function of the path, or an Error to throw. */
type Route = [RegExp, unknown];
const routes = (map: Route[]) => {
  const calls: { path: string; host: string | undefined }[] = [];
  const get = async (path: string, opts: { host?: string } = {}): Promise<unknown> => {
    calls.push({ path, host: opts.host });
    for (const [re, body] of map) if (re.test(path)) { if (body instanceof Error) throw body; return typeof body === 'function' ? body(path) : body; }
    throw Object.assign(new Error('gh failed'), { stderr: 'gh: Not Found (HTTP 404)' });
  };
  return { get, calls };
};
/** What the stand-in gh echoes back. */
const echo = async (...a: Parameters<typeof ghGet>) => (await ghGet(...a)) as { args: string; prompt: string };
const BRANCH = { name: 'main', commit: { sha: 'abc', commit: { message: 'Merge #41: thread groups\n\nbody', committer: { date: '2026-11-10T12:00:00Z' } } },
  protected: true, protection: { enabled: true, required_status_checks: { enforcement_level: 'non_admins', contexts: ['test'], checks: [{ context: 'test' }] } } };

test('a check\'s state, and many as one', () => {
  assert.equal(runState({ status: 'in_progress', conclusion: null }), 'pending');
  assert.equal(runState({ status: 'completed', conclusion: 'success' }), 'passing');
  assert.equal(runState({ status: 'completed', conclusion: 'skipped' }), 'neutral');
  for (const c of ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']) assert.equal(runState({ status: 'completed', conclusion: c }), 'failing', c);
  assert.equal(overall([]), 'none');
  assert.equal(overall(['passing', 'neutral']), 'passing');
  assert.equal(overall(['passing', 'pending']), 'pending');
  assert.equal(overall(['pending', 'failing']), 'failing');
});

test('base checks: the newest commit\'s check runs and statuses, with the required ones marked', async () => {
  const gh = routes([
    [/^repos\/o\/r\/branches\/main$/, BRANCH],
    [/check-runs/, { total_count: 2, check_runs: [
      { name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/runs/1', completed_at: '2026-11-10T12:05:00Z' },
      { name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/runs/2' },
    ] }],
    [/\/status\?/, { state: 'pending', total_count: 1, statuses: [{ context: 'deploy/preview', state: 'pending', target_url: 'https://x' }] }],
    [/rules\/branches/, [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }, { type: 'deletion' }]],
  ]);
  const r = checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: gh.get, now: () => 7, memo: new Map() }));
  assert.equal(r.state, 'checked');
  assert.deepEqual([r.sha, r.title, r.committedAt, r.at], ['abc', 'Merge #41: thread groups', '2026-11-10T12:00:00Z', 7]);
  const by = Object.fromEntries(r.checks.map((c) => [c.name, c]));
  assert.deepEqual([by.test.state, by.test.required], ['failing', true]);
  assert.deepEqual([by.lint.state, by.lint.required], ['passing', false]);
  assert.deepEqual([by['deploy/preview'].state, by['deploy/preview'].required], ['pending', false]);
  assert.equal(by.build, undefined, 'a required check that never ran on the branch is not a check on it');
  assert.deepEqual(r.requiredNotRun, ['build']);
  assert.equal(r.result, 'failing');
  assert.equal(r.requiredResult, 'failing');
  assert.equal(r.truncated, false);
  // Reads only, at the commit the branch points to.
  assert.ok(gh.calls.every((c) => c.path.startsWith('repos/o/r/')));
  assert.ok(gh.calls.some((c) => c.path === 'repos/o/r/commits/abc/check-runs?per_page=100'));
});

test('base checks: required checks that only run on pull requests judge nothing on the branch', async () => {
  const gh = routes([
    [/^repos\/o\/r\/branches\/main$/, { ...BRANCH, protection: { required_status_checks: { contexts: ['ci'], checks: [] } } }],
    [/check-runs/, { total_count: 1, check_runs: [{ name: 'deploy', status: 'completed', conclusion: 'success' }] }],
    [/\/status\?/, { total_count: 0, statuses: [] }],
    [/rules\/branches/, []],
  ]);
  const r = checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: gh.get, memo: new Map() }));
  assert.deepEqual([r.result, r.requiredResult, r.requiredNotRun], ['passing', 'none', ['ci']]);
});

test('base checks: required unknown stays unknown; a branch with a slash is encoded', async () => {
  const gh = routes([
    [/^repos\/o\/r\/branches\/release%2F1$/, { ...BRANCH, protection: undefined }],
    [/check-runs/, (path: string) => ({ total_count: 150, check_runs: /&page=/.test(path) ? [] : [{ name: 'test', status: 'completed', conclusion: 'success' }] })],
    [/\/status\?/, { state: 'success', total_count: 0, statuses: [] }],
    [/rules\/branches/, Object.assign(new Error('x'), { stderr: 'gh: Forbidden (HTTP 403)' })],
  ]);
  const r = checked(await readBaseChecks({ repo: 'o/r', branch: 'release/1' }, { get: gh.get, memo: new Map() }));
  assert.equal(r.state, 'checked');
  assert.equal(r.requiredResult, null);
  assert.equal(r.requiredNotRun, null);
  assert.equal(r.checks[0]?.required, null);
  assert.equal(r.result, null, 'GitHub counts 150 runs but gave one: nothing is judged from it');
  assert.equal(r.truncated, true, 'more runs than the pages gave');
});

test('not checked, with the reason: no gh, signed out, rate limit, no such repo, too slow', async () => {
  const why = async (err: unknown) => whyOf(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: async () => { throw err; } }));
  assert.equal(await why(Object.assign(new Error(), { code: 'ENOENT' })), 'the GitHub CLI (gh) is not on this Mac');
  assert.equal(await why(Object.assign(new Error(), { stderr: 'To get started with GitHub CLI, please run:  gh auth login' })), 'the GitHub CLI is not signed in');
  assert.equal(await why(Object.assign(new Error(), { stderr: 'gh: API rate limit exceeded for user (HTTP 403)' })), 'GitHub\'s rate limit for this account is spent');
  assert.equal(await why(Object.assign(new Error(), { stderr: 'gh: Not Found (HTTP 404)' })), 'GitHub has no such repo, branch or PR that this account can see');
  assert.equal(await why(Object.assign(new Error(), { killed: true })), 'GitHub took longer than 20 s');
  assert.equal(ghWhy(new Error('odd')), 'odd');
});

test('PR size: GitHub\'s totals, and the same without lockfiles', async () => {
  const files = [
    ...Array.from({ length: 100 }, (_, i) => ({ filename: `src/f${i}.ts`, additions: 2, deletions: 1 })),
    { filename: 'package-lock.json', additions: 900, deletions: 300 },
    { filename: 'web/pnpm-lock.yaml', additions: 50, deletions: 0 },
  ];
  const gh = routes([
    [/pulls\/7$/, { number: 7, state: 'open', merged: false, draft: false, additions: 1150, deletions: 400, changed_files: 102, head: { sha: 'h1' }, base: { ref: 'staging' }, html_url: 'https://github.com/o/r/pull/7' }],
    [/pulls\/7\/files\?per_page=100&page=1$/, files.slice(0, 100)],
    [/pulls\/7\/files\?per_page=100&page=2$/, files.slice(100)],
  ]);
  const r = checked(await readPrSize({ repo: 'o/r', number: 7 }, { get: gh.get, memo: new Map() }));
  assert.deepEqual([r.state, r.prState, r.base, r.head, r.additions, r.deletions, r.changedFiles], ['checked', 'open', 'staging', 'h1', 1150, 400, 102]);
  assert.deepEqual(r.size, { files: 100, added: 200, removed: 100 });
  assert.deepEqual(r.lockfiles, ['package-lock.json', 'web/pnpm-lock.yaml']);
  assert.equal(gh.calls.length, 4, 'the PR, two pages, and the PR again to see nothing moved');
});

test('PR size: more files than the pages read keeps the totals and says the rest is unknown', async () => {
  const gh = routes([[/pulls\/8$/, { number: 8, state: 'closed', merged: true, additions: 5000, deletions: 10, changed_files: 1500 }]]);
  const r = checked(await readPrSize({ repo: 'o/r', number: 8 }, { get: gh.get, memo: new Map() }));
  assert.deepEqual([r.prState, r.changedFiles, r.size, r.lockfiles], ['merged', 1500, null, null]);
  assert.equal(gh.calls.length, 1);
});

test('an unchanged branch or PR costs one call; a move, a pending check or 10 minutes reads the rest again', async () => {
  let sha = 'abc', state = 'completed', t = 0;
  const gh = routes([
    [/^repos\/o\/r\/branches\/main$/, () => ({ ...BRANCH, commit: { ...BRANCH.commit, sha } })],
    [/check-runs/, () => ({ total_count: 1, check_runs: [{ name: 'test', status: state, conclusion: state === 'completed' ? 'success' : null }] })],
    [/\/status\?/, { total_count: 0, statuses: [] }],
    [/rules\/branches/, []],
  ]);
  const memo = new Map();
  const base = async () => { const before = gh.calls.length; const r = checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: gh.get, memo, now: () => t })); return [r.result, gh.calls.length - before]; };
  assert.deepEqual(await base(), ['passing', 4]);
  t += 60000; assert.deepEqual(await base(), ['passing', 1], 'nothing moved');
  sha = 'def'; state = 'in_progress';
  assert.deepEqual(await base(), ['pending', 4], 'the branch moved');
  state = 'completed';
  assert.deepEqual(await base(), ['passing', 4], 'a pending check is read again');
  t += 10 * 60000; assert.deepEqual(await base(), ['passing', 4], 'ten minutes on, everything again');

  let head = 'h1';
  const pr = routes([
    [/pulls\/7$/, () => ({ state: 'open', additions: 3, deletions: 1, changed_files: 2, head: { sha: head }, base: { ref: 'main' } })],
    [/pulls\/7\/files/, [{ filename: 'a.js', additions: 2, deletions: 1 }, { filename: 'yarn.lock', additions: 1, deletions: 0 }]],
  ]);
  const sizes = new Map();
  const size = async () => { const before = pr.calls.length; const r = checked(await readPrSize({ repo: 'o/r', number: 7 }, { get: pr.get, memo: sizes })); return [r.size?.added, r.lockfiles, pr.calls.length - before]; };
  assert.deepEqual(await size(), [2, ['yarn.lock'], 3]);
  assert.deepEqual(await size(), [2, ['yarn.lock'], 1], 'same head: the file list is reused');
  head = 'h2';
  assert.deepEqual(await size(), [2, ['yarn.lock'], 3], 'a new head: read again');
});

test('PR size: a push while the files are read leaves the size unknown, never a partial one', async () => {
  let reads = 0;
  const gh = routes([
    [/pulls\/9$/, () => ({ state: 'open', additions: 3, deletions: 0, changed_files: 1, head: { sha: ++reads === 1 ? 'h1' : 'h2' }, base: { ref: 'main' } })],
    [/pulls\/9\/files/, [{ filename: 'a.js', additions: 3, deletions: 0 }]],
  ]);
  const memo = new Map();
  const r = checked(await readPrSize({ repo: 'o/r', number: 9 }, { get: gh.get, memo }));
  assert.deepEqual([r.state, r.additions, r.size, r.lockfiles, memo.size], ['checked', 3, null, null, 0]);
});

test('base checks: protection read but rulesets not is not known; an unprotected branch with rules read is', async () => {
  const run = async (branch: unknown, rules: unknown) => checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { memo: new Map(), get: routes([
    [/^repos\/o\/r\/branches\/main$/, branch],
    [/check-runs/, { total_count: 1, check_runs: [{ name: 'rule-only', status: 'completed', conclusion: 'failure' }] }],
    [/\/status\?/, { total_count: 0, statuses: [] }],
    [/rules\/branches/, rules],
  ]).get }));
  const partial = await run(BRANCH, Object.assign(new Error('x'), { stderr: 'gh: Forbidden (HTTP 403)' }));
  assert.deepEqual([partial.requiredResult, partial.requiredNotRun, partial.checks[0]?.required], [null, null, null]);
  const open = await run({ ...BRANCH, protected: false, protection: undefined }, [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'rule-only' }] } }]);
  assert.deepEqual([open.requiredResult, open.checks[0]?.required], ['failing', true]);
});

test('a branch name is one path segment, whatever it holds', async () => {
  const gh = routes([[/branches\/release%2F%28next%29%21$/, { ...BRANCH, protection: undefined }], [/check-runs/, { total_count: 0, check_runs: [] }], [/\/status\?/, { total_count: 0, statuses: [] }], [/rules\/branches/, []]]);
  const r = checked(await readBaseChecks({ repo: 'o/r', branch: "release/(next)!" }, { get: gh.get, memo: new Map() }));
  assert.equal(r.state, 'checked');
  assert.equal(segment("it's(*)"), 'it%27s%28%2A%29');
  assert.match(`repos/o/r/branches/${segment('release/(next)!')}`, /^repos\/o\/r\/branches\/[A-Za-z0-9%]+$/, 'only characters the path guard lets through');
});

test('a reused read keeps the time its checks were read; a commit with no checks yet is never reused', async () => {
  let runs: { name: string; status: string; conclusion: string }[] = [], t = 0;
  const gh = routes([
    [/^repos\/o\/r\/branches\/main$/, BRANCH],
    [/check-runs/, () => ({ total_count: runs.length, check_runs: runs })],
    [/\/status\?/, { total_count: 0, statuses: [] }],
    [/rules\/branches/, []],
  ]);
  const memo = new Map();
  const base = async () => { const before = gh.calls.length; const r = checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: gh.get, memo, now: () => t })); return [r.result, r.at, gh.calls.length - before]; };
  assert.deepEqual(await base(), ['none', 0, 4]);
  t = 60000; runs = [{ name: 'test', status: 'completed', conclusion: 'failure' }];
  assert.deepEqual(await base(), ['failing', 60000, 4], 'CI had not started: read again, and the failure shows');
  t = 120000;
  assert.deepEqual(await base(), ['failing', 60000, 1], 'reused, with the time its checks were read');
  t = 60000 + 4 * 60000;
  assert.deepEqual(await base(), ['failing', t, 4], 'four minutes on, read again, inside the 6-minute limit');
});

test('a required check pinned to an app counts only that app\'s run', async () => {
  const pinned = { ...BRANCH, protection: { required_status_checks: { contexts: ['test', 'lint'], checks: [{ context: 'test', app_id: 15368 }, { context: 'lint', app_id: null }] } } };
  const gh = routes([
    [/^repos\/o\/r\/branches\/main$/, pinned],
    [/check-runs/, { total_count: 3, check_runs: [
      { name: 'test', app: { id: 999 }, status: 'completed', conclusion: 'failure' },
      { name: 'test', app: { id: 15368 }, status: 'completed', conclusion: 'success' },
      { name: 'build', app: { id: 7 }, status: 'completed', conclusion: 'success' },
    ] }],
    [/\/status\?/, { total_count: 2, statuses: [{ context: 'lint', state: 'success' }, { context: 'deploy', state: 'failure' }] }],
    [/rules\/branches/, [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build', integration_id: 8 }, { context: 'deploy', integration_id: 9 }] } }]],
  ]);
  const r = checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: gh.get, memo: new Map() }));
  // A commit status does not say which app sent it, so a status named like a pinned requirement may or may not be it
  // (PR-Agent r2 on #4): its place is unknown, and so is what the required checks add up to.
  assert.deepEqual(r.checks.map((c) => [c.name, c.app, c.required]), [['test', 999, false], ['test', 15368, true], ['build', 7, false], ['lint', null, true], ['deploy', null, null]]);
  assert.equal(r.requiredResult, null);
  assert.equal(r.requiredNotRun, null);
  assert.equal(r.result, 'failing');
  // Without that status, the pins decide: another app's failing "test" is not the required one, and "build" and
  // "deploy" were not reported by the apps they are pinned to.
  const known = routes([
    [/^repos\/o\/r\/branches\/main$/, pinned],
    [/check-runs/, { total_count: 3, check_runs: [
      { name: 'test', app: { id: 999 }, status: 'completed', conclusion: 'failure' },
      { name: 'test', app: { id: 15368 }, status: 'completed', conclusion: 'success' },
      { name: 'build', app: { id: 7 }, status: 'completed', conclusion: 'success' },
    ] }],
    [/\/status\?/, { total_count: 1, statuses: [{ context: 'lint', state: 'success' }] }],
    [/rules\/branches/, [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build', integration_id: 8 }, { context: 'deploy', integration_id: 9 }] } }]],
  ]);
  const k = checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: known.get, memo: new Map() }));
  assert.deepEqual(k.checks.map((c) => [c.name, c.required]), [['test', false], ['test', true], ['build', false], ['lint', true]]);
  assert.equal(k.requiredResult, 'passing');
  assert.deepEqual(k.requiredNotRun, ['build', 'deploy']);
});

test('PR size: a base that moved under the same head reads the files again', async () => {
  let baseSha = 'b1';
  const gh = routes([
    [/pulls\/7$/, () => ({ state: 'open', additions: 1, deletions: 0, changed_files: 1, head: { sha: 'h1' }, base: { ref: 'main', sha: baseSha } })],
    [/pulls\/7\/files/, [{ filename: 'a.js', additions: 1, deletions: 0 }]],
  ]);
  const memo = new Map();
  const calls = async () => { const before = gh.calls.length; await readPrSize({ repo: 'o/r', number: 7 }, { get: gh.get, memo }); return gh.calls.length - before; };
  assert.deepEqual([await calls(), await calls()], [3, 1]);
  baseSha = 'b2';
  assert.equal(await calls(), 3);
});

test('gh itself: a GET, with GitHub\'s headers, and nothing that is not a repo path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yc-gh-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'gh');
  // Echo the arguments back as JSON, as `gh api` echoes a body.
  writeFileSync(fake, '#!/bin/sh\nprintf \'{"args":"%s","prompt":"%s"}\' "$*" "$GH_PROMPT_DISABLED"\n');
  chmodSync(fake, 0o755);
  const out = await echo('repos/o/r/branches/main', { gh: fake });
  assert.equal(out.args, 'api --method GET -H Accept: application/vnd.github+json -H X-GitHub-Api-Version: 2022-11-28 --hostname github.com repos/o/r/branches/main');
  assert.equal(out.prompt, '1');
  assert.match((await echo('repos/o/r/pulls/1', { gh: fake, host: 'ghe.example.com' })).args, /--hostname ghe\.example\.com repos\/o\/r\/pulls\/1$/);
  for (const bad of ['user', 'repos/o/r/branches/main --method POST', '-X', 'repos/o/../x', 'repos/o/r/branches/%2e%2E', 'repos/o/r/%zz', 'graphql']) await assert.rejects(ghGet(bad, { gh: fake }), /not a GitHub read/, bad);
  await assert.rejects(ghGet('repos/o/r', { gh: fake, host: 'x --flag' }), /not a GitHub host/);
  await assert.rejects(ghGet('repos/o/r', { gh: join(dir, 'none') }), (ex) => ghWhy(ex) === 'the GitHub CLI (gh) is not on this Mac');
});

test('following: one read per branch for every thread on it; one per PR', () => {
  const reads: unknown[] = [];
  const checks = createBaseChecks({ read: (a) => { reads.push(a); return new Promise(() => {}); } });
  checks.want([
    { id: 't1', repo: 'o/r', branch: 'main' }, { id: 't2', host: 'GitHub.com', repo: 'o/r', branch: 'main' },
    { id: 't3', repo: 'o/r', branch: 'staging' }, { id: 't4', why: 'the folder is gone' }, { id: 't5', repo: 'bad repo', branch: 'main' },
  ]);
  assert.deepEqual(reads, [{ host: 'github.com', repo: 'o/r', branch: 'main' }, { host: 'github.com', repo: 'o/r', branch: 'staging' }]);
  assert.equal(whyOf(checks.get('t4')), 'the folder is gone');
  assert.equal(whyOf(checks.get('t5')), 'no GitHub repo and base branch for this thread');
  const sizeReads: unknown[] = [];
  const sizes = createPrSizes({ read: (a) => { sizeReads.push(a); return new Promise(() => {}); } });
  sizes.want([{ repo: 'o/r', number: 7 }, { repo: 'o/r', number: 7 }, { repo: 'o/r', number: 'x' }]);
  assert.deepEqual(sizeReads, [{ host: 'github.com', repo: 'o/r', number: 7, merged: false }]);
  assert.equal(whyOf(sizes.get(prKey({ repo: 'o/r', number: 7 }))), 'not read yet');
  // A PR that merged is a new source under the same id: the read after the merge is its own (3b PR 4b).
  sizes.want([{ repo: 'o/r', number: 7, merged: true }]);
  assert.deepEqual(sizeReads.at(-1), { host: 'github.com', repo: 'o/r', number: 7, merged: true });
});

test('the facts beside a PR and a base: runs with an open PR, only the merge with a merged one, the red when required checks fail (3b PR 4b)', async () => {
  const calls: [string, number][] = [];
  const get = async () => ({});
  const size = async (a: { number: number }): Promise<PrSizeRead> => {
    calls.push(['size', a.number]);
    return { state: 'checked', at: 1, host: 'github.com', repo: 'o/r', number: a.number, url: null, prState: 'open', draft: false, head: null, base: 'main',
      additions: 1, deletions: 0, changedFiles: 1, size: { files: 1, added: 1, removed: 0 }, lockfiles: [] };
  };
  const runs = async (a: { number: number; merged?: boolean }): Promise<PrRuns> => {
    calls.push(['runs', a.number]);
    return { state: 'checked', at: 1, host: 'github.com', repo: 'o/r', number: a.number, head: null, draft: false, readyAt: null, mergeSha: a.merged ? 'm'.repeat(40) : null, checks: null };
  };
  const open = await readPrFacts({ repo: 'o/r', number: 7, merged: false }, { size, runs, get });
  assert.ok(open.state === 'checked' && 'size' in open && open.runs?.state === 'checked');
  assert.deepEqual('size' in open && open.size, { files: 1, added: 1, removed: 0 });
  const merged = await readPrFacts({ repo: 'o/r', number: 8, merged: true }, { size, runs, get });
  assert.equal(merged.state === 'checked' && 'mergeSha' in merged && merged.mergeSha, 'm'.repeat(40));
  assert.deepEqual(calls, [['size', 7], ['runs', 7], ['runs', 8]], 'a merged PR is not sized');
  // GitHub refused the size: the runs are not read either.
  const refused = await readPrFacts({ repo: 'o/r', number: 9 }, { size: async () => ({ state: 'not-checked', why: 'x', at: 1 }), runs, get });
  assert.equal('runs' in refused, false);

  const base: BaseChecksRead = { state: 'checked', at: 1, host: 'github.com', repo: 'o/r', branch: 'main', sha: 'c'.repeat(40), title: 't', committedAt: null,
    checks: [{ name: 'test', app: null, state: 'failing', url: null, at: null, required: true }, { name: 'lint', app: null, state: 'passing', url: null, at: null, required: false },
      { name: 'test', app: null, state: 'failing', url: null, at: null, required: true }],
    result: 'failing', requiredResult: 'failing', requiredNotRun: [], truncated: false };
  const asked: unknown[] = [];
  const red = async (a: unknown) => { asked.push(a); return { redSha: 'b'.repeat(40), redSince: 5 }; };
  const b = await readBaseFacts({ repo: 'o/r', branch: 'main' }, { read: async () => base, red, get });
  assert.deepEqual(b.red, { redSha: 'b'.repeat(40), redSince: 5 });
  assert.deepEqual(asked, [{ host: 'github.com', repo: 'o/r', branch: 'main', head: 'c'.repeat(40), names: ['test'] }], 'only the required checks, once each');
  const others: BaseChecksRead[] = [{ ...base, requiredResult: 'passing' }, { ...base, requiredResult: null }, { state: 'not-checked', why: 'x', at: 1 }];
  for (const other of others) {
    const g = await readBaseFacts({ repo: 'o/r', branch: 'main' }, { read: async () => other, red, get });
    assert.equal(g.red, undefined);
  }
  assert.equal(asked.length, 1, 'a base that is not red costs no walk');
  const broke = await readBaseFacts({ repo: 'o/r', branch: 'main' }, { read: async () => base, red: async () => { throw new Error('HTTP 502'); }, get });
  assert.equal(broke.red, undefined, 'a failed walk leaves the checks as they were');
  assert.equal(broke.state === 'checked' && broke.requiredResult, 'failing');
});

test('following: a reused read is not read again before its turn, so an unchanged base costs what the rate math says', async () => {
  // A beat every 5 s for 10 minutes on one unchanged, settled base. The follower reads every 2 minutes; a reused read
  // returns the older time its checks were read, which must not make the follower read again at every beat.
  let t = 0;
  const gh = routes([
    [/^repos\/o\/r\/branches\/main$/, BRANCH],
    [/check-runs/, { total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }],
    [/\/status\?/, { total_count: 0, statuses: [] }],
    [/rules\/branches/, []],
  ]);
  const memo = new Map();
  const checks = createBaseChecks({ now: () => t, read: (a) => readBaseChecks(a, { get: gh.get, memo, now: () => t }) });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const when = [];
  for (t = 0; t <= 600000; t += 5000) {
    const before = gh.calls.length;
    checks.want([{ id: 't1', repo: 'o/r', branch: 'main' }]);
    await settle();
    if (gh.calls.length > before) when.push([t / 1000, gh.calls.length - before]);
    if (t === 125000) assert.equal(checks.get('t1').at, 0, 'a reused read still says when its checks were read');
  }
  assert.deepEqual(when, [[0, 4], [120, 1], [240, 4], [360, 1], [480, 4], [600, 1]]);
});

test('gh never gets a GitHub Enterprise token, so a host named in T3 Code\'s data or a remote cannot receive one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yc-gh-'));
  const saved = { GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN, GITHUB_ENTERPRISE_TOKEN: process.env.GITHUB_ENTERPRISE_TOKEN };
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  process.env.GH_ENTERPRISE_TOKEN = 'stand-in-1';
  process.env.GITHUB_ENTERPRISE_TOKEN = 'stand-in-2';
  const fake = join(dir, 'gh');
  writeFileSync(fake, '#!/bin/sh\nprintf \'{"a":"%s","b":"%s"}\' "${GH_ENTERPRISE_TOKEN-unset}" "${GITHUB_ENTERPRISE_TOKEN-unset}"\n');
  chmodSync(fake, 0o755);
  assert.deepEqual(await ghGet('repos/o/r/pulls/1', { gh: fake, host: 'git.example.com' }), { a: 'unset', b: 'unset' });
});

test('base checks: every page of check runs and statuses is read; a list still cut short judges nothing', async () => {
  const run = (i: number, conclusion = 'success') => ({ name: `job ${i}`, status: 'completed', conclusion });
  const pageOf = (path: string) => Number((/[?&]page=(\d+)/.exec(path) || [])[1] || 1);
  // 150 check runs: the required "build" fails on page 2.
  const runs = [...Array.from({ length: 149 }, (_, i) => run(i)), { name: 'build', status: 'completed', conclusion: 'failure' }];
  const gh = routes([
    [/^repos\/o\/r\/branches\/main$/, { ...BRANCH, protection: undefined, protected: false }],
    [/check-runs/, (path: string) => ({ total_count: runs.length, check_runs: runs.slice((pageOf(path) - 1) * 100, pageOf(path) * 100) })],
    [/\/status\?/, { total_count: 0, statuses: [] }],
    [/rules\/branches/, [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }]],
  ]);
  const r = checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: gh.get, now: () => 1, memo: new Map() }));
  assert.equal(r.checks.length, 150);
  assert.deepEqual([r.result, r.requiredResult, r.requiredNotRun, r.truncated], ['failing', 'failing', [], false]);
  assert.ok(gh.calls.some((c) => c.path === 'repos/o/r/commits/abc/check-runs?per_page=100&page=2'));
  // More than the pages read: what was read is listed, and nothing is judged from it.
  const many = routes([
    [/^repos\/o\/r\/branches\/main$/, { ...BRANCH, protection: undefined, protected: false }],
    [/check-runs/, () => ({ total_count: 5000, check_runs: Array.from({ length: 100 }, (_, i) => run(i)) })],
    [/\/status\?/, { total_count: 0, statuses: [] }],
    [/rules\/branches/, [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }]],
  ]);
  const memo = new Map();
  const cut = checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: many.get, now: () => 1, memo }));
  assert.equal(cut.state, 'checked');
  assert.deepEqual([cut.result, cut.requiredResult, cut.requiredNotRun, cut.truncated], [null, null, null, true]);
  assert.equal(memo.size, 0, 'a list cut short is never reused');
});

test('base checks: every page of the branch\'s rules is read; more than the pages read leaves the required ones unknown', async () => {
  const pageOf = (path: string) => Number((/[?&]page=(\d+)/.exec(path) || [])[1] || 1);
  // 130 rules: the required check is on page 2.
  const rules = [...Array.from({ length: 129 }, () => ({ type: 'deletion' })), { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }];
  const per = (path: string) => Number((/per_page=(\d+)/.exec(path) || [])[1] || 30);
  const branch = { ...BRANCH, protection: undefined, protected: false };
  const gh = routes([
    [/^repos\/o\/r\/branches\/main$/, branch],
    [/check-runs/, { total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }],
    [/\/status\?/, { total_count: 0, statuses: [] }],
    [/rules\/branches/, (path: string) => rules.slice((pageOf(path) - 1) * per(path), pageOf(path) * per(path))],
  ]);
  const r = checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: gh.get, memo: new Map() }));
  assert.deepEqual([r.requiredResult, r.requiredNotRun], ['none', ['build']]);
  assert.ok(gh.calls.some((c) => c.path === 'repos/o/r/rules/branches/main?per_page=100&page=2'));
  // A rule list longer than the pages read: the required checks are not known.
  const endless = routes([
    [/^repos\/o\/r\/branches\/main$/, branch],
    [/check-runs/, { total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }],
    [/\/status\?/, { total_count: 0, statuses: [] }],
    [/rules\/branches/, (path: string) => Array.from({ length: per(path) }, () => ({ type: 'deletion' }))],
  ]);
  const memo = new Map();
  const cut = checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: endless.get, memo }));
  assert.deepEqual([cut.checks[0]?.required, cut.requiredResult, cut.requiredNotRun, cut.result], [null, null, null, 'passing']);
  assert.equal(memo.size, 0, 'rules not fully read are never reused');
});

test('base checks: a list that moved between pages judges nothing (a new check shifts the pages)', async () => {
  const run = (i: number, conclusion = 'success') => ({ id: i, name: `job ${i}`, status: 'completed', conclusion });
  // 200 runs when page 1 is read; then CI adds one at the front, so page 2 repeats page 1's last run, and the
  // failing required "build" slides onto page 3.
  const before = [...Array.from({ length: 199 }, (_, i) => run(i + 1)), { id: 999, name: 'build', status: 'completed', conclusion: 'failure' }];
  const after = [run(1000), ...before];
  const pageOf = (path: string) => Number((/&page=(\d+)/.exec(path) || [])[1] || 1);
  const gh = routes([
    [/^repos\/o\/r\/branches\/main$/, { ...BRANCH, protection: undefined, protected: false }],
    [/check-runs/, (path: string) => { const list = pageOf(path) === 1 ? before : after; return { total_count: list.length, check_runs: list.slice((pageOf(path) - 1) * 100, pageOf(path) * 100) }; }],
    [/\/status\?/, { total_count: 0, statuses: [] }],
    [/rules\/branches/, [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }]],
  ]);
  const memo = new Map();
  const r = checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: gh.get, now: () => 1, memo }));
  assert.deepEqual([r.truncated, r.result, r.requiredResult, r.requiredNotRun], [true, null, null, null]);
  assert.equal(new Set(r.checks.map((c) => c.name)).size, r.checks.length, 'a run seen on two pages is listed once');
  assert.equal(memo.size, 0);
  // Statuses repeat by context when one moves between pages.
  const st = (c: string, state = 'success') => ({ id: Math.random(), context: c, state });
  const page1 = Array.from({ length: 100 }, (_, i) => st(`s${i}`));
  const page2 = [st('s99', 'failure'), ...Array.from({ length: 49 }, (_, i) => st(`t${i}`))];
  const moved = routes([
    [/^repos\/o\/r\/branches\/main$/, { ...BRANCH, protection: undefined, protected: false }],
    [/check-runs/, { total_count: 0, check_runs: [] }],
    [/\/status\?/, (path: string) => ({ total_count: 150, statuses: pageOf(path) === 1 ? page1 : page2 })],
    [/rules\/branches/, []],
  ]);
  const m = checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: moved.get, now: () => 1, memo: new Map() }));
  assert.deepEqual([m.truncated, m.result], [true, null]);
});

test('base checks: a commit status\'s context is matched without case, as GitHub matches it', async () => {
  // GitHub's REST docs, "Create a commit status": the context "field is case-insensitive" (PR-Agent r4 on #4).
  const gh = routes([
    [/^repos\/o\/r\/branches\/main$/, { ...BRANCH, protection: { required_status_checks: { contexts: ['ci/build'], checks: [] } } }],
    [/check-runs/, { total_count: 0, check_runs: [] }],
    [/\/status\?/, { total_count: 2, statuses: [{ context: 'CI/Build', state: 'failure' }, { context: 'Deploy/Preview', state: 'success' }] }],
    [/rules\/branches/, [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'deploy/preview' }] } }]],
  ]);
  const r = checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: gh.get, memo: new Map() }));
  assert.deepEqual(r.checks.map((c) => [c.name, c.required]), [['CI/Build', true], ['Deploy/Preview', true]]);
  assert.deepEqual([r.requiredResult, r.requiredNotRun], ['failing', []]);
  // The combined status has one entry per context, case aside: one seen on two pages in two cases moved.
  const pageOf = (path: string) => Number((/&page=(\d+)/.exec(path) || [])[1] || 1);
  const page1 = Array.from({ length: 100 }, (_, i) => ({ context: `s${i}`, state: 'success' }));
  const page2 = [{ context: 'S99', state: 'failure' }, ...Array.from({ length: 49 }, (_, i) => ({ context: `t${i}`, state: 'success' }))];
  const moved = routes([
    [/^repos\/o\/r\/branches\/main$/, { ...BRANCH, protection: undefined, protected: false }],
    [/check-runs/, { total_count: 0, check_runs: [] }],
    [/\/status\?/, (path: string) => ({ total_count: 150, statuses: pageOf(path) === 1 ? page1 : page2 })],
    [/rules\/branches/, []],
  ]);
  const m = checked(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: moved.get, now: () => 1, memo: new Map() }));
  assert.deepEqual([m.truncated, m.result], [true, null]);
});

// ----- Every reply is read through a Schema (Effect PR, step 5): a reply GitHub would never send is not checked, never a guess -----
test('base checks: a check-runs page that is not GitHub\'s judges nothing, so the statuses alone never pass the branch', async () => {
  const gh = routes([
    [/^repos\/o\/r\/branches\/main$/, BRANCH],
    [/check-runs/, {}],
    [/\/status\?/, { total_count: 1, statuses: [{ context: 'test', state: 'success' }] }],
    [/rules\/branches/, []],
  ]);
  const why = whyOf(await readBaseChecks({ repo: 'o/r', branch: 'main' }, { get: gh.get, now: () => 7, memo: new Map() }));
  assert.equal(why, 'GitHub sent check runs the Pass cannot read');
});

test('PR size: a file list that is not GitHub\'s leaves the size unknown, never a sum of strings', async () => {
  const gh = routes([
    [/pulls\/7$/, { number: 7, state: 'open', merged: false, draft: false, additions: 7, deletions: 1, changed_files: 2, head: { sha: 'h1' }, base: { ref: 'main', sha: 'b1' } }],
    [/pulls\/7\/files\?per_page=100&page=1$/, [{ filename: 'a.ts', additions: '5', deletions: 1 }, { filename: 'b.ts', additions: 2, deletions: 0 }]],
  ]);
  const r = checked(await readPrSize({ repo: 'o/r', number: 7 }, { get: gh.get, memo: new Map() }));
  assert.deepEqual([r.additions, r.deletions, r.changedFiles], [7, 1, 2], 'GitHub\'s own totals stand');
  assert.equal(r.size, null);
  assert.equal(r.lockfiles, null);
});
