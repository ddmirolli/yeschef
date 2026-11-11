import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { combine, commitResult, commitChecks, readPrRuns, readBaseRed, RUNS_MAX, RERUN_MS, type Get } from './pr-runs.ts';

const h = (n: number) => n.toString(16).padStart(40, '0');
const iso = (min: number) => new Date(Date.UTC(2026, 10, 11, 8, min)).toISOString();
const AT = Date.UTC(2026, 10, 11, 12);

type Fake = { pr?: Record<string, unknown>; commits?: { sha: string; min: number; parent?: string }[];
  runs?: Record<string, { name: string; status: string; conclusion: string | null }[]>; statuses?: Record<string, { context: string; state: string }[]>;
  events?: Record<string, unknown>[] };
/** A GitHub with one repo, acme/app, that answers only the paths the reader may ask, and counts them. */
function fake(f: Fake): Get & { paths: string[] } {
  const paths: string[] = [];
  const commit = (c: { sha: string; min: number; parent?: string }) => ({ sha: c.sha, parents: c.parent ? [{ sha: c.parent }] : [],
    commit: { message: `commit ${c.min}\n\nbody`, committer: { date: iso(c.min) } } });
  const get = async (path: string, opts: { host: string }) => {
    assert.equal(opts.host, 'github.com');
    paths.push(path);
    let m;
    if (path === 'repos/acme/app/pulls/7') return f.pr;
    if ((m = /^repos\/acme\/app\/pulls\/7\/commits\?per_page=100&page=(\d+)$/.exec(path))) return (f.commits ?? []).slice((+m[1]! - 1) * 100, +m[1]! * 100).map(commit);
    if ((m = /^repos\/acme\/app\/commits\/([0-9a-f]{40})\/check-runs\?per_page=100$/.exec(path))) { const r = f.runs?.[m[1]!] ?? []; return { total_count: r.length, check_runs: r }; }
    if ((m = /^repos\/acme\/app\/commits\/([0-9a-f]{40})\/status\?per_page=100$/.exec(path))) { const s = f.statuses?.[m[1]!] ?? []; return { total_count: s.length, statuses: s }; }
    if ((m = /^repos\/acme\/app\/issues\/7\/events\?per_page=100&page=(\d+)$/.exec(path))) return (f.events ?? []).slice((+m[1]! - 1) * 100, +m[1]! * 100);
    if (/^repos\/acme\/app\/commits\?sha=[^&]+&per_page=50$/.test(path)) return [...(f.commits ?? [])].reverse().map(commit);
    throw new Error(`HTTP 404 ${path}`);
  };
  return Object.assign(get, { paths });
}
const ok = (name = 'ci') => ({ name, status: 'completed', conclusion: 'success' });
const bad = (name = 'ci') => ({ name, status: 'completed', conclusion: 'failure' });
const going = (name = 'ci') => ({ name, status: 'in_progress', conclusion: null });

test('many checks as one word: failing beats pending beats passing; none is none', () => {
  assert.equal(combine([]), 'none');
  assert.equal(combine(['none', 'passing']), 'passing');
  assert.equal(combine(['passing', 'pending']), 'pending');
  assert.equal(combine(['pending', 'failing', 'passing']), 'failing');
  assert.equal(combine(['neutral', 'neutral']), 'neutral');
  assert.equal(combine(['neutral', 'passing']), 'passing');
});

test('a commit is read once its checks settle; pending is read again; a second page is not checked', async () => {
  const c = h(1), memo = new Map();
  const get = fake({ runs: { [c]: [ok(), going('lint')] }, statuses: { [c]: [{ context: 'deploy', state: 'success' }] } });
  let t = AT;
  const now = () => t;
  assert.equal(await commitResult(get, 'github.com', 'acme/app', c, { memo, now }), 'pending');
  assert.equal(await commitResult(get, 'github.com', 'acme/app', c, { memo, now }), 'pending');
  assert.equal(get.paths.length, 4, 'pending is not kept');
  const done = fake({ runs: { [c]: [ok(), bad('lint')] } });
  assert.equal(await commitResult(done, 'github.com', 'acme/app', c, { memo, now }), 'failing');
  assert.equal(await commitResult(done, 'github.com', 'acme/app', c, { memo, now }), 'failing');
  assert.equal(done.paths.length, 2, 'settled is kept');
  // Checks run again: after 30 minutes a finished commit is read again (PR-Agent r1 on #28).
  const rerun = fake({ runs: { [c]: [ok(), ok('lint')] } });
  t += RERUN_MS - 1;
  assert.equal(await commitResult(rerun, 'github.com', 'acme/app', c, { memo, now }), 'failing');
  t += 1;
  assert.equal(await commitResult(rerun, 'github.com', 'acme/app', c, { memo, now }), 'passing');
  // The head is always read, never kept.
  assert.equal(await commitResult(done, 'github.com', 'acme/app', c, { memo, now, head: true }), 'failing');
  assert.equal(await commitResult(done, 'github.com', 'acme/app', c, { memo, now, head: true }), 'failing');
  assert.equal(done.paths.length, 6);
  // Only the named checks count: a red lint that is not required leaves the commit green.
  assert.equal(await commitResult(done, 'github.com', 'acme/app', c, { memo, names: ['ci'] }), 'passing');
  // A named check that has not reported is pending, never green (PR-Agent r1 on #28).
  assert.equal(await commitResult(done, 'github.com', 'acme/app', c, { memo, names: ['ci', 'e2e'] }), 'pending');
  // A head with no checks yet is asked again: its CI may not have started. Behind the head, none is final.
  const fresh = fake({});
  assert.equal(await commitResult(fresh, 'github.com', 'acme/app', h(3), { memo, head: true }), 'none');
  assert.equal(await commitResult(fresh, 'github.com', 'acme/app', h(3), { memo, head: true }), 'none');
  assert.equal(fresh.paths.length, 4, 'none at the head is not kept');
  t += 10 * RERUN_MS;
  assert.equal(await commitResult(fresh, 'github.com', 'acme/app', h(4), { memo, now }), 'none');
  assert.equal(await commitResult(fresh, 'github.com', 'acme/app', h(4), { memo, now }), 'none');
  assert.equal(fresh.paths.length, 6, 'none behind the head is kept a while');
  // ...and read again after 30 minutes: its checks may have started late (PR-Agent r2 on #28).
  const late = fake({ runs: { [h(4)]: [bad()] } });
  assert.equal(await commitResult(late, 'github.com', 'acme/app', h(4), { memo, now: () => t + RERUN_MS }), 'failing');
  // One red check among running ones: failing, not done, not kept (PR-Agent r2 on #28).
  const mixed = fake({ runs: { [h(5)]: [bad(), going('lint')] } });
  assert.deepEqual(await commitChecks(mixed, 'github.com', 'acme/app', h(5), { memo, now }), { result: 'failing', done: false });
  await commitChecks(mixed, 'github.com', 'acme/app', h(5), { memo, now });
  assert.equal(mixed.paths.length, 4);
  const paged: Get = async (path) => (path.includes('check-runs') ? { total_count: 101, check_runs: [ok()] } : { total_count: 0, statuses: [] });
  assert.equal(await commitResult(paged, 'github.com', 'acme/app', h(2), { memo: new Map() }), null);
});

test("a PR's runs: finished commits only, oldest first, at most 10, and the red ones in a row", async () => {
  const commits = Array.from({ length: 14 }, (_, i) => ({ sha: h(i + 1), min: i }));
  const runs: Fake['runs'] = {};
  commits.forEach((c, i) => { runs[c.sha] = i < 8 ? [ok()] : [bad()]; });
  runs[h(10)] = []; // an inner commit of a push: no checks, not a run
  runs[h(13)] = [bad(), going('lint')]; // one red check, another still running: not a run yet (PR-Agent r2 on #28)
  runs[h(14)] = [going()]; // the head, still running
  const get = fake({ pr: { state: 'open', draft: false, merged: false, created_at: iso(0), commits: 14, head: { sha: h(14) } }, commits, runs,
    events: [{ event: 'ready_for_review', created_at: iso(3) }, { event: 'converted_to_draft', created_at: iso(4) }, { event: 'ready_for_review', created_at: iso(5) }] });
  const r = await readPrRuns({ repo: 'acme/app', number: 7 }, { get, now: () => AT, memo: new Map(), merges: new Map() });
  assert.equal(r.state, 'checked');
  if (r.state !== 'checked') return;
  assert.equal(r.readyAt, Date.parse(iso(5)), 'the last time it was marked ready');
  assert.equal(r.mergeSha, null);
  assert.equal(r.checks?.result, 'pending', 'the head is still running');
  assert.equal(r.checks?.runs.length, RUNS_MAX);
  assert.deepEqual(r.checks?.runs.map((x) => x.sha), [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12].slice(-RUNS_MAX).map(h));
  assert.equal(r.checks?.redRuns, 3, 'commits 9, 11, 12: the inner commit, the unfinished one and the pending head break nothing');
  assert.deepEqual(r.checks?.runs.at(-1), { at: Date.parse(iso(11)), sha: h(12), title: 'commit 11', result: 'failing' });
});

test('a PR opened ready is ready since it opened; a draft has no ready time; a merged PR names its merge commit', async () => {
  const one = [{ sha: h(1), min: 0 }];
  const base = { commits: 1, head: { sha: h(1) }, created_at: iso(0) };
  const opened = await readPrRuns({ repo: 'acme/app', number: 7 }, { get: fake({ pr: { ...base, state: 'open', draft: false }, commits: one, runs: { [h(1)]: [ok()] } }), now: () => AT, memo: new Map(), merges: new Map() });
  assert.equal(opened.state === 'checked' && opened.readyAt, Date.parse(iso(0)));
  assert.equal(opened.state === 'checked' && opened.checks?.redRuns, 0);
  const draft = await readPrRuns({ repo: 'acme/app', number: 7 }, { get: fake({ pr: { ...base, state: 'open', draft: true }, commits: one }), now: () => AT, memo: new Map(), merges: new Map() });
  assert.equal(draft.state === 'checked' && draft.readyAt, null);
  const mergedGet = fake({ pr: { ...base, state: 'closed', draft: false, merged: true, merge_commit_sha: h(99) } });
  const merged = await readPrRuns({ repo: 'acme/app', number: 7 }, { get: mergedGet, now: () => AT, memo: new Map(), merges: new Map() });
  assert.deepEqual(merged.state === 'checked' && [merged.mergeSha, merged.readyAt, merged.checks], [h(99), null, null]);
  assert.deepEqual(mergedGet.paths, ['repos/acme/app/pulls/7'], 'a merged PR costs one read');
  // The merge commit never changes: the next read asks GitHub nothing.
  const merges = new Map<string, string>();
  await readPrRuns({ repo: 'acme/app', number: 7 }, { get: mergedGet, now: () => AT, memo: new Map(), merges });
  const again = await readPrRuns({ repo: 'acme/app', number: 7 }, { get: mergedGet, now: () => AT + 1, memo: new Map(), merges });
  assert.deepEqual(again.state === 'checked' && [again.mergeSha, again.at], [h(99), AT + 1]);
  assert.equal(mergedGet.paths.length, 2);
  // Events past the pages read: the ready time is not checked, never the opening time.
  const many = Array.from({ length: 300 }, () => ({ event: 'labeled', created_at: iso(1) }));
  const long = await readPrRuns({ repo: 'acme/app', number: 7 }, { get: fake({ pr: { ...base, state: 'open', draft: false }, commits: one, events: many, runs: { [h(1)]: [ok()] } }), now: () => AT, memo: new Map(), merges: new Map() });
  assert.equal(long.state === 'checked' && long.readyAt, null);
  // A push between the reads: the commit list ends elsewhere, so the runs are not checked.
  const moved = await readPrRuns({ repo: 'acme/app', number: 7 }, { get: fake({ pr: { ...base, state: 'open', draft: false, head: { sha: h(2) } }, commits: one }), now: () => AT, memo: new Map(), merges: new Map() });
  assert.equal(moved.state === 'checked' && moved.checks, null);
  const gone = await readPrRuns({ repo: 'acme/app', number: 8 }, { get: fake({}), now: () => AT, why: () => 'no such PR' });
  assert.deepEqual(gone, { state: 'not-checked', why: 'no such PR', at: AT });
});

test('the runs reach back across a page of PR commits', async () => {
  const commits = Array.from({ length: 105 }, (_, i) => ({ sha: h(i + 1), min: i }));
  const runs = Object.fromEntries(commits.map((c) => [c.sha, [bad()]]));
  const get = fake({ pr: { state: 'open', draft: false, created_at: iso(0), commits: 105, head: { sha: h(105) } }, commits, runs });
  const r = await readPrRuns({ repo: 'acme/app', number: 7 }, { get, now: () => AT, memo: new Map(), merges: new Map() });
  assert.deepEqual(r.state === 'checked' && r.checks?.runs.map((x) => x.sha), Array.from({ length: 10 }, (_, i) => h(96 + i)));
  assert.equal(r.state === 'checked' && r.checks?.redRuns, 10);
  assert.ok(get.paths.includes('repos/acme/app/pulls/7/commits?per_page=100&page=1') && get.paths.includes('repos/acme/app/pulls/7/commits?per_page=100&page=2'));
});

test("a base's red began at its first red commit, along first parents, past pending ones", async () => {
  // main: 1 green, 2 red (the break), 3 pending, 4 red (the head). A side commit 9 (a merged branch's own commit) is
  // green but off the first-parent line, so it never ends the red.
  const commits = [{ sha: h(1), min: 0 }, { sha: h(2), min: 1, parent: h(1) }, { sha: h(9), min: 2, parent: h(1) },
    { sha: h(3), min: 3, parent: h(2) }, { sha: h(4), min: 4, parent: h(3) }];
  const runs = { [h(1)]: [ok()], [h(2)]: [bad()], [h(9)]: [ok()], [h(3)]: [going()], [h(4)]: [bad(), bad('lint')] };
  const red = await readBaseRed({ repo: 'acme/app', branch: 'main', head: h(4) }, { get: fake({ commits, runs }), memo: new Map() });
  assert.deepEqual(red, { redSha: h(2), redSince: Date.parse(iso(1)) });
  // Only the required check: lint's red on 4 is not the break, ci's red on 2 is.
  const req = await readBaseRed({ repo: 'acme/app', branch: 'main', head: h(4), names: ['ci'] }, { get: fake({ commits, runs }), memo: new Map() });
  assert.equal(req.redSha, h(2));
  // A green head is not red; a red that runs past the commits read is not checked.
  assert.deepEqual(await readBaseRed({ repo: 'acme/app', branch: 'main', head: h(1) }, { get: fake({ commits, runs }), memo: new Map() }), { redSha: null, redSince: null });
  const allRed = Object.fromEntries(commits.map((c) => [c.sha, [bad()]]));
  assert.deepEqual(await readBaseRed({ repo: 'acme/app', branch: 'main', head: h(4) }, { get: fake({ commits, runs: allRed }), memo: new Map() }), { redSha: null, redSince: null });
  // A branch name with a slash or parentheses reaches GitHub as one query value of safe characters (PR-Agent r2 on #28).
  const slash = fake({ commits, runs });
  await readBaseRed({ repo: 'acme/app', branch: 'release/(hotfix)!', head: h(4) }, { get: slash, memo: new Map() });
  assert.ok(slash.paths.includes('repos/acme/app/commits?sha=release%2F%28hotfix%29%21&per_page=50'), slash.paths[0]);
  // ghGet's own rule for a path (client/github.mjs SAFE_PATH).
  assert.match('repos/acme/app/commits?sha=release%2F%28hotfix%29%21&per_page=50', /^repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._%-]+)*(\?[A-Za-z0-9._=&%-]+)?$/);
});

test('a long push never hides the runs before it: the commits are read back until 10 runs (PR-Agent r1 on #28)', async () => {
  // 3 red runs, then a push of 40 commits whose CI ran only on its tip (red): 4 in a row.
  const commits = Array.from({ length: 45 }, (_, i) => ({ sha: h(i + 1), min: i }));
  const runs: Fake['runs'] = { [h(1)]: [ok()], [h(2)]: [bad()], [h(3)]: [bad()], [h(4)]: [bad()], [h(45)]: [bad()] };
  const get = fake({ pr: { state: 'open', draft: false, created_at: iso(0), commits: 45, head: { sha: h(45) } }, commits, runs });
  const r = await readPrRuns({ repo: 'acme/app', number: 7 }, { get, now: () => AT, memo: new Map(), merges: new Map() });
  assert.deepEqual(r.state === 'checked' && r.checks?.runs.map((x) => x.sha), [1, 2, 3, 4, 45].map(h));
  assert.equal(r.state === 'checked' && r.checks?.redRuns, 4);
  // Over two pages: the earlier page is read only when the last one holds fewer than 10 runs.
  const many = Array.from({ length: 150 }, (_, i) => ({ sha: h(i + 1), min: i }));
  const red = Object.fromEntries(many.map((c) => [c.sha, [bad()]]));
  const g2 = fake({ pr: { state: 'open', draft: false, created_at: iso(0), commits: 150, head: { sha: h(150) } }, commits: many, runs: red });
  await readPrRuns({ repo: 'acme/app', number: 7 }, { get: g2, now: () => AT, memo: new Map(), merges: new Map() });
  assert.ok(!g2.paths.includes('repos/acme/app/pulls/7/commits?per_page=100&page=1'), 'page 2 held 50 runs: page 1 is not read');
  const sparse = Object.fromEntries(many.filter((_, i) => i < 20 || i === 149).map((c) => [c.sha, [bad()]]));
  const g3 = fake({ pr: { state: 'open', draft: false, created_at: iso(0), commits: 150, head: { sha: h(150) } }, commits: many, runs: sparse });
  const r3 = await readPrRuns({ repo: 'acme/app', number: 7 }, { get: g3, now: () => AT, memo: new Map(), merges: new Map() });
  assert.equal(r3.state === 'checked' && r3.checks?.runs.length, 10);
  assert.equal(r3.state === 'checked' && r3.checks?.redRuns, 10);
});

test("a base commit missing a required check is passed over, never taken for green (PR-Agent r1 on #28)", async () => {
  // 1 green on both, 2 red, 3 reported only test (lint not yet): not a green boundary; 4 red.
  const commits = [{ sha: h(1), min: 0 }, { sha: h(2), min: 1, parent: h(1) }, { sha: h(3), min: 2, parent: h(2) }, { sha: h(4), min: 3, parent: h(3) }];
  const runs = { [h(1)]: [ok('test'), ok('lint')], [h(2)]: [bad('test'), ok('lint')], [h(3)]: [ok('test')], [h(4)]: [bad('test'), ok('lint')] };
  const red = await readBaseRed({ repo: 'acme/app', branch: 'main', head: h(4), names: ['test', 'lint'] }, { get: fake({ commits, runs }), memo: new Map() });
  assert.equal(red.redSha, h(2));
});
