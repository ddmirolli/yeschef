import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKitchen } from '../src/demo/kitchen.ts';
import { createHash as browserHash } from '../src/demo/node-crypto.ts';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { IRIS } from '../demo/lib/demo-team.ts';
import { timeToday } from '../demo/lib/you.ts';
import type { DemoRun, DemoThread } from '../src/demo/types.ts';

const kitchen = () => createKitchen({
  now: () => new Date('2026-11-10T15:00:00Z').getTime(),
  where: (directory) => ({ icon: `icons/${directory}.svg` }),
  shot: (name) => `img/${name}-dark.png`, later: null,
});

test('the typed demo renders the real app modules with only made-up projects', () => {
  const demo = kitchen();
  assert.ok(demo.board().tickets.length > 0);
  const page = demo.page();
  assert.match(page, /Fernpay/);
  assert.match(page, /Retry failed payouts/);
  assert.doesNotMatch(page, /\/icon\//);
  assert.match(page, /https:\/\/t3\.codes\//);
});

test('unknown demo tools cannot reach T3 or the network', async () => {
  await assert.rejects(kitchen().t3.call('real-tool'), /not in the demo kitchen/);
});

test('demo rule changes stay in memory and reject invalid values', async () => {
  const demo = kitchen();
  assert.equal((await demo.act('kind=rules&key=reviewer&value=invalid'))[0], 400);
  assert.equal((await demo.act('kind=rules&key=reviewer&value=coderabbit'))[0], 200);
  assert.match(demo.page(), /"reviewer":"coderabbit"/);
});

test('browser screenshot IDs stay identical to the app generator IDs', () => {
  for (const text of ['', '/demo/payouts-before.png', 'Fernpay', 'a'.repeat(130), 'crème']) {
    assert.equal(browserHash('sha1').update(text).digest(), createHash('sha1').update(text).digest('hex'));
  }
});

// Moved from client/you.test with the TypeScript port: the demo kitchen is the site's, so its test runs with the site.
const min = 60000;
const NOW = new Date(2026, 10, 10, 15, 0).getTime();

test('the demo kitchen runs one run per thread at a time, and its answered question stays out of agent time', async () => {
  let clock = NOW;
  const k = createKitchen({ now: () => clock, where: () => ({}), shot: (name) => name, later: () => {} });
  // The demo answers as T3 Code does; these are the fields this test reads.
  const runsOf = async (threadId: string) => ((await k.t3.call('t3_thread_read', { threadId, runLimit: 50 })) as { recentRuns: DemoRun[] }).recentRuns;
  const asked = async (threadId: string) => ((await k.t3.call('t3_pending_request', { action: 'list', threadId })) as { requestIds: string[] }).requestIds;
  const { threads } = (await k.t3.call('t3_thread_list', { settled: false })) as { threads: DemoThread[] };
  const busy: DemoThread[] = [];
  for (const t of threads.filter((x) => x.status === 'running')) if (!(await asked(t.threadId)).length) busy.push(t);
  const cards = threads.find((t) => t.title === 'Driver cards on the dispatch map');
  const first = busy[0];
  assert.ok(cards);
  assert.ok(first);
  k.board();  // the board sees the question while it waits
  clock += 5 * min;
  await k.t3.call('t3_thread_send', { threadId: first.threadId, message: 'Dan, from the Pass: also the totals row' });
  const sent = await runsOf(first.threadId);
  assert.equal(sent.filter((r) => !r.completedAt).length, 1);
  assert.equal(sent[1]?.status, 'interrupted');
  assert.equal(sent[1]?.completedAt, new Date(clock).toISOString());
  await k.t3.call('t3_pending_request', { action: 'respond', threadId: cards.threadId, requestId: 'r1', answers: { q1: 'Both, window first' } });
  const run = k.board().tickets.find((t) => t.thread.threadId === cards.threadId)?.runs?.[0];
  assert.ok(run);
  // The cards run began 80 minutes before the kitchen opened and asked at 18; the answer came 5 minutes after it opened.
  assert.equal(timeToday(run, clock).ms, 62 * min);
});

test('the team demo draws the made-up team in Your team, and the mode cards switch it', () => {
  let changed = 0;
  const demo = createKitchen({ now: () => new Date('2026-11-10T15:00:00Z').getTime(), where: (directory) => ({ icon: `icons/${directory}.svg` }),
    shot: (name) => `img/${name}-dark.png`, later: null, team: 'open', onChange: () => { changed++; } });
  const open = demo.page();
  assert.match(open, /id="yc-team"/);
  assert.match(open, /"mode":"open"/);
  assert.match(open, /Main broken/);
  assert.equal(demo.mode('brigade'), 'brigade');
  assert.equal(changed, 1);
  assert.match(demo.page(), /"mode":"brigade"/);
  assert.equal(demo.mode('brigade'), 'brigade');
  assert.equal(changed, 1, 'the same mode does not redraw');
  // The solo demo has no team and no mode to switch.
  assert.equal(kitchen().mode('brigade'), null);
  assert.doesNotMatch(kitchen().page(), /id="yc-team"/);
});

test('a team call stays open across the demo ticks: its id keeps while the clock moves', () => {
  // The page redraws every 3 s (shim.ts) and keeps the open call only while its id is still on the page. A call's id
  // carries its start time, so the made-up team is made once; ages still grow with the clock.
  let clock = new Date('2026-11-10T15:00:00Z').getTime();
  const demo = createKitchen({ now: () => clock, where: (directory) => ({ icon: `icons/${directory}.svg` }),
    shot: (name) => `img/${name}-dark.png`, later: null, team: 'open' });
  const ids = (html: string) => [...html.matchAll(/class="plate team-plate" id="([^"]+)"/g)].map((m) => m[1]);
  const first = ids(demo.page());
  assert.equal(first.length, 8, "six Open kitchen calls, Ready for your look and Blocked");
  clock += 3000;
  assert.deepEqual(ids(demo.page()), first);
  clock += 2 * 60000;
  const later = demo.page();
  assert.deepEqual(ids(later), first);
  assert.match(later, /Main broken/);
});

test('the team demo\'s diff panel has the app pipe\'s answers for its Too big PR: the file list, then each file\'s code', () => {
  // Written by scripts/generate-demo.ts from client/demo-diff.ts through client/diffs.ts; shim.ts answers /diff from them.
  const dir = new URL('../public/demo/diff/', import.meta.url);
  const team = readFileSync(new URL('../demo/team.html', import.meta.url), 'utf8');
  assert.match(team, /data-diff="\/diff\?repo=fernpay%2Ffernpay&amp;n=440&amp;v=\d+\.1079\.161"/);
  const list = JSON.parse(readFileSync(new URL('fernpay-fernpay-440.json', dir), 'utf8')) as { ok: boolean; rest: boolean; files: { path: string; add: number; del: number }[] };
  assert.equal(list.ok, true);
  assert.equal(list.rest, false);
  assert.deepEqual(list.files.map((f) => [f.path, f.add, f.del]), [...IRIS.map(([p, a, d]) => [p, a, d]), ['pnpm-lock.yaml', 2104, 0]]);
  for (const [i, f] of list.files.entries()) {
    const code = JSON.parse(readFileSync(new URL(`fernpay-fernpay-440/${i}.json`, dir), 'utf8')) as { ok: boolean; code: string };
    assert.equal(code.ok, true, f.path);
    assert.match(code.code, f.path === 'pnpm-lock.yaml' ? /GitHub withheld this file's code/ : /^<pre data-diff/, f.path);
  }
  assert.equal(readdirSync(new URL('fernpay-fernpay-440/', dir)).length, list.files.length);
});
