// The You view (Dan, 2026-11-10, views mock v4). Run: node --test client/you.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readRuns, timeToday, agentTime, runningSeries, duration, trackWaits, withoutWaits, mayRunToday } from './you.mjs';
import { buildBoard, renderApp } from './board.mjs';
import { createKitchen } from '../site/src/demo/kitchen.ts';

// Local times, so "today" holds in any time zone.
const NOW = new Date(2026, 10, 10, 15, 0).getTime();
const at = (h, m = 0) => new Date(2026, 10, 10, h, m).toISOString();
const min = 60000;
const run = (startedAt, completedAt, status = completedAt ? 'completed' : 'running') => ({ runId: startedAt, status, startedAt, completedAt });

test('a read lists runs newest first; a running one has no end, a stopped one without an end time is open', () => {
  const r = readRuns({ thread: { runCount: 5 }, recentRuns: [run(at(14), null), run(at(12), at(13)), run(at(11), null, 'interrupted')] });
  assert.deepEqual(r.runs.map((x) => x.end), [null, Date.parse(at(13)), Date.parse(at(11))]);
  assert.deepEqual(r.runs.map((x) => !!x.open), [false, false, true]);
  assert.equal(r.more, true);
  assert.equal(readRuns({ thread: { runCount: 2 }, recentRuns: [run(at(12), at(13)), run(at(9), at(10))] }).more, false);
  assert.deepEqual(readRuns(null), { runs: [], more: false });
});

test('time today counts from midnight, a running run up to now', () => {
  const yday = new Date(2026, 10, 9, 23, 0).toISOString();
  const e = readRuns({ thread: { runCount: 2 }, recentRuns: [run(at(14, 30), null), run(yday, at(1))] });
  assert.equal(timeToday(e, NOW).ms, 90 * min);
  assert.equal(timeToday(e, NOW).cut, false);
});

test('when T3 sent only its newest runs and all of them are today, the total is a floor ("cut")', () => {
  const e = readRuns({ thread: { runCount: 9 }, recentRuns: [run(at(13), at(14))] });
  assert.equal(timeToday(e, NOW).cut, true);
});

test('agent time adds each agent in whole minutes by project, and leaves Coordinators out', () => {
  const e = (h, m) => readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(h, m), at(h + 1, m))] });
  const t = agentTime([
    { project: 'A', place: 'In progress', runs: [e(9, 0), e(10, 0)] },
    { project: 'B', place: 'Merged', runs: [e(8, 0)] },
    { project: 'C', place: 'Coordinators', runs: [e(7, 0)] },
    { project: 'D', place: 'Backlog', runs: null },
  ], NOW);
  assert.equal(t.ms, 180 * min);
  assert.equal(t.agents, 3);
  assert.deepEqual([...t.byProject], [['A', 120 * min], ['B', 60 * min]]);
});

test('the running line counts back from now in 15-minute steps to the first run today', () => {
  const tickets = [{ place: 'In progress', runs: [readRuns({ thread: { runCount: 2 }, recentRuns: [run(at(14, 20), null), run(at(14), at(14, 10))] })] }];
  const s = runningSeries(tickets, NOW);
  // 14:00, 14:15, 14:30, 14:45 and now (15:00).
  assert.equal(s.span, 60 * min);
  assert.deepEqual(s.points, [1, 0, 1, 1, 1]);
  assert.deepEqual(runningSeries([{ place: 'In progress', runs: [] }], NOW), { span: 0, points: [] });
});

// PR-Agent on #74: nothing T3 did not send counts as known.
test('a run today with no end time makes the time a floor, still counts its agent, and leaves the line unknown', () => {
  const e = readRuns({ thread: { runCount: 2 }, recentRuns: [run(at(13), null, 'interrupted'), run(at(10), at(11))] });
  assert.deepEqual(timeToday(e, NOW), { ms: 60 * min, cut: true, open: true });
  const t = agentTime([{ project: 'A', place: 'In review', runs: [e] }], NOW);
  assert.equal(t.cut, true);
  assert.equal(t.agents, 1);
  assert.deepEqual(runningSeries([{ place: 'In review', runs: [e] }], NOW), { span: 0, points: [] });
  // One with no end time that a later run, started before today, followed: it ended before today.
  const old = readRuns({ thread: { runCount: 3 }, recentRuns: [run(at(14), at(14, 30)), run(new Date(2026, 10, 9, 22).toISOString(), at(0, 0)), run(new Date(2026, 10, 9, 20).toISOString(), null, 'interrupted')] });
  assert.equal(timeToday(old, NOW).open, false);
});

test('the running line starts no earlier than the oldest run T3 sent for a thread with more runs', () => {
  const full = readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(13), at(13, 30))] });
  const cut = readRuns({ thread: { runCount: 80 }, recentRuns: [run(at(14, 30), null), run(at(14, 20), at(14, 25))] });
  const s = runningSeries([{ place: 'In progress', runs: [full] }, { place: 'In progress', runs: [cut] }], NOW);
  // From 14:20 (the cut thread's oldest run), not 13:00: 14:30, 14:45 and now.
  assert.equal(s.span, 30 * min);
  assert.deepEqual(s.points, [1, 1, 1]);
});

test('an agent that ran under 30 seconds still counts, and short runs add up before they round', () => {
  const short = readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(14), new Date(2026, 10, 10, 14, 0, 20).toISOString())] });
  const t = agentTime([{ project: 'A', place: 'In review', runs: [short] }], NOW);
  assert.equal(t.agents, 1);
  assert.equal(t.ms, 20000);
  assert.equal(duration(t.ms), 'under 1 min');
  // Four agents of 20 seconds: 80 seconds, which shows as 1 min (PR-Agent r2 on #74).
  const four = agentTime([{ project: 'A', place: 'In review', runs: [short, short, short, short] }], NOW);
  assert.equal(four.agents, 4);
  assert.equal(duration(four.ms), '1 min');
  assert.equal(duration(four.byProject.get('A')), '1 min');
});

test('a thread waiting on a question stopped running when it asked: its open run ends at its last update', () => {
  const asking = T('asking', { status: 'running', updatedAt: at(14, 30) });
  const entry = readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(14), null)] });
  const b = buildBoard({ projects: [{ id: 'p', title: 'Fernpay' }], threads: [asking], questions: new Map([['asking', [{ id: 'q' }]]]), runs: new Map([['asking', entry]]), today: new Date(NOW) });
  const k = b.tickets[0];
  assert.equal(k.working, 0);
  assert.deepEqual(k.runs[0].runs, [{ start: Date.parse(at(14)), end: Date.parse(at(14, 30)) }]);
  assert.equal(agentTime([k], NOW).ms, 30 * min);
  assert.equal(runningSeries([k], NOW).points.at(-1), 0);
  // Without a last update, the end is not known.
  const blind = buildBoard({ projects: [], threads: [{ ...asking, updatedAt: null }], questions: new Map([['asking', [{ id: 'q' }]]]), runs: new Map([['asking', entry]]), today: new Date(NOW) });
  assert.equal(blind.tickets[0].runs[0].runs[0].open, true);
});

test('a wait stays out of agent time after the answer, while the same run carries on (PR-Agent r3 on #74)', () => {
  const log = new Map(), q = new Map([['asking', [{ id: 'q' }]]]);
  const asked = T('asking', { status: 'running', updatedAt: at(14, 30) }), answered = { ...asked, updatedAt: at(14, 50) };
  trackWaits(log, [asked], q, Date.parse(at(14, 40)));
  trackWaits(log, [answered], new Map(), Date.parse(at(14, 50)));
  const entry = readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(14), null)] });
  const k = buildBoard({ projects: [{ id: 'p', title: 'Fernpay' }], threads: [answered], questions: new Map(), runs: new Map([['asking', entry]]), waits: log, today: new Date(NOW) }).tickets[0];
  assert.deepEqual(k.runs[0].runs, [{ start: Date.parse(at(14, 50)), end: null }, { start: Date.parse(at(14)), end: Date.parse(at(14, 30)) }]);
  assert.equal(agentTime([k], NOW).ms, 40 * min);
  assert.deepEqual(runningSeries([k], NOW).points, [1, 1, 0, 0, 1]);
  // Once the run ends, the wait still stays out.
  const done = withoutWaits(readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(14), at(14, 55))] }), log.get('asking'));
  assert.equal(timeToday(done, NOW).ms, 35 * min);
});

test('a wait seen without a start time leaves its run unknown after the answer; waits end with the day and the thread', () => {
  const log = new Map();
  trackWaits(log, [T('x', { status: 'waiting', updatedAt: null })], new Map(), Date.parse(at(14, 40)));
  trackWaits(log, [T('x', { status: 'running', updatedAt: at(14, 50) })], new Map(), Date.parse(at(14, 50)));
  const e = withoutWaits(readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(14), null), run(at(12), at(13))] }), log.get('x'));
  assert.equal(e.runs[0].open, true);
  assert.deepEqual(e.runs[1], { start: Date.parse(at(12)), end: Date.parse(at(13)) });
  assert.equal(timeToday(e, NOW).cut, true);
  assert.deepEqual(runningSeries([{ place: 'In review', runs: [e] }], NOW).points, []);
  trackWaits(log, [T('x', { status: 'running' })], new Map(), new Date(2026, 10, 11, 9).getTime());
  assert.equal(log.has('x'), false);
  trackWaits(log, [T('y', { status: 'waiting' })], new Map(), NOW);
  assert.equal(log.has('y'), true);
  trackWaits(log, [], new Map(), NOW);
  assert.equal(log.size, 0);
});

test('a run with no start time has no known length: agent time and the running line say so (PR-Agent r4 on #74)', () => {
  const nostart = (completedAt, status = completedAt ? 'completed' : 'running') => ({ runId: 'n', status, startedAt: null, completedAt });
  const k = { project: 'A', place: 'In review', runs: [readRuns({ thread: { runCount: 1 }, recentRuns: [nostart(at(13))] })] };
  const t = agentTime([k], NOW);
  assert.deepEqual([t.ms, t.agents, t.cut], [0, 1, true]);
  assert.deepEqual(runningSeries([k], NOW).points, []);
  // Still running, with no start: the same.
  assert.equal(timeToday(readRuns({ thread: { runCount: 1 }, recentRuns: [nostart(null)] }), NOW).open, true);
  // One that ended yesterday leaves today alone, and the run after it still counts.
  const old = readRuns({ thread: { runCount: 2 }, recentRuns: [run(at(14), at(14, 30)), nostart(new Date(2026, 10, 9, 22).toISOString())] });
  assert.deepEqual(timeToday(old, NOW), { ms: 30 * min, cut: false, open: false });
  assert.equal(old.more, false);
});

test('run times are read for threads updated today, running, or with no update time from T3 (PR-Agent r5 on #74)', () => {
  const t0 = new Date(2026, 10, 10).getTime(), yday = new Date(2026, 10, 9, 22).toISOString();
  assert.equal(mayRunToday(T('a', { updatedAt: at(9) }), t0), true);
  assert.equal(mayRunToday(T('b', { updatedAt: yday, status: 'running' }), t0), true);
  assert.equal(mayRunToday(T('c', { updatedAt: null }), t0), true);
  assert.equal(mayRunToday(T('d', { updatedAt: 'garbled' }), t0), true);
  assert.equal(mayRunToday(T('e', { updatedAt: yday }), t0), false);
  assert.equal(mayRunToday(T('f', { latestRunId: null, updatedAt: null }), t0), false);
});

test('the demo kitchen runs one run per thread at a time, and its answered question stays out of agent time', async () => {
  let clock = NOW;
  const k = createKitchen({ now: () => clock, where: () => ({}), shot: (name) => name, later: () => {} });
  const runsOf = async (threadId) => (await k.t3.call('t3_thread_read', { threadId, runLimit: 50 })).recentRuns;
  const { threads } = await k.t3.call('t3_thread_list', { settled: false });
  const busy = [];
  for (const t of threads.filter((x) => x.status === 'running')) if (!(await k.t3.call('t3_pending_request', { action: 'list', threadId: t.threadId })).requestIds.length) busy.push(t);
  const cards = threads.find((t) => t.title === 'Driver cards on the dispatch map');
  k.board();  // the board sees the question while it waits
  clock += 5 * min;
  await k.t3.call('t3_thread_send', { threadId: busy[0].threadId, message: 'Dan, from the Pass: also the totals row' });
  const sent = await runsOf(busy[0].threadId);
  assert.equal(sent.filter((r) => !r.completedAt).length, 1);
  assert.equal(sent[1].status, 'interrupted');
  assert.equal(sent[1].completedAt, new Date(clock).toISOString());
  await k.t3.call('t3_pending_request', { action: 'respond', threadId: cards.threadId, requestId: 'r1', answers: { q1: 'Both, window first' } });
  const ticket = k.board().tickets.find((t) => t.thread.threadId === cards.threadId);
  // The cards run began 80 minutes before the kitchen opened and asked at 18; the answer came 5 minutes after it opened.
  assert.equal(timeToday(ticket.runs[0], clock).ms, 62 * min);
});

test('durations read as minutes, then hours', () => {
  assert.equal(duration(40 * min), '40 min');
  assert.equal(duration(240 * min), '4 h');
  assert.equal(duration(330 * min), '5.5 h');
});

// ----- The page -----
const T = (id, extra = {}) => ({ threadId: id, title: id, projectId: 'p', status: 'completed', latestRunId: 'r', updatedAt: at(14), pullRequests: [], ...extra });
const pr = (n, state) => ({ repository: 'o/r', number: n, state });
const THREADS = [
  T('backlog', { status: 'idle', latestRunId: null }), T('planned'), T('cooking', { status: 'running' }),
  T('review', { pullRequests: [pr(1, 'open')] }), T('merged', { pullRequests: [pr(2, 'merged')] }),
  T('held', { snoozed: true }), T('done', { settled: true, settledAt: at(13), pullRequests: [pr(3, 'merged')] }),
];
const RUNS = new Map([['cooking', readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(14), null)] })],
  ['review', readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(10), at(12))] })]]);
const board = (runs = RUNS) => buildBoard({ projects: [{ id: 'p', title: 'Fernpay' }], threads: THREADS, questions: new Map(), runs, today: new Date(NOW) });
const page = (o = {}) => renderApp({ board: board(o.runs), link: (t) => `https://t3.example/${t.threadId}`, status: { ok: true, at: NOW, ms: 1 }, origin: 'https://t3.example', ...o });

test('stage dots are a gray ramp up to In progress, never orange', () => {
  const html = page();
  for (const c of ['backlog', 'planned', 'prog', 'open', 'blue', 'merged']) assert.match(html, new RegExp(`gd c-${c}"`));
  assert.doesNotMatch(html, /c-amber[^"]*"><\/i>In progress|data-folder="In progress"><i class="gd c-amber/);
});

test('the rail opens with the person and one bar piece per thread on the line, Backlog to Merged, left to right', () => {
  const html = page();
  const row = html.match(/<div class="idrow">[\s\S]*?<\/span><\/div>/)[0];
  assert.match(row, /<span class="vh">You<\/span>/);
  assert.deepEqual([...row.matchAll(/<i class="c-(\w+)"><\/i>/g)].map((m) => m[1]), ['backlog', 'planned', 'prog', 'open', 'merged']);
  assert.doesNotMatch(html, /Your threads<\/h3>|class="nav-h"/);
});

const youOf = (html) => html.match(/<section class="you"[\s\S]*?<\/div><\/div><\/div><\/section>/)[0];

test('You, expanded is the six stage columns alone (Dan, 2026-11-10)', () => {
  const you = youOf(page());
  assert.match(you, /^<section class="you" aria-label="Your threads by stage"><div class="you-b"><div class="rail-wrap"><div class="rail"><section class="tray/);
  assert.deepEqual([...you.matchAll(/<section class="tray[^"]*" data-stage="([^"]+)"/g)].map((m) => m[1]), ['Backlog', 'Planned', 'In progress', 'In review', 'Ready to merge', 'Merged']);
  // Each thread on the line once, in its column.
  for (const [id, stage] of [['backlog', 'Backlog'], ['planned', 'Planned'], ['cooking', 'In progress'], ['review', 'In review'], ['merged', 'Merged']]) {
    assert.match(you, new RegExp(`data-stage="${stage}"[^]*?<div class="tray-b">(?:(?!</section>)[^])*data-thread="${id}"`));
  }
  // Dan cut the header line, the four cards, the "At The Pass" key and the panels under the board.
  for (const gone of [/class="you-h"/, /class="you-sub"/, /class="inst"/, /Agents running/, /Merged today/, /Checks on open PRs/, /Your agents wait on you/,
    /At The Pass/, /Merged, last 7 days/, /Agent time today/, /class="held"/, /class="pnl/]) assert.doesNotMatch(you, gone);
  // Verified and on hold stay one click away in the stage list.
  assert.match(page(), /<button type="button" class="nf" data-folder="Verified">[\s\S]*?<span class="n">1<\/span><\/button><button type="button" class="nf" data-folder="On hold">/);
});

test('without a good poll the columns say "–" and hold no threads', () => {
  const you = youOf(page({ status: { ok: false, error: 'down', at: NOW, ms: 0 } }));
  assert.equal([...you.matchAll(/<span class="n">–<\/span>/g)].length, 6);
  assert.doesNotMatch(you, /data-thread=/);
});

test('the columns run the window\'s full height and each scrolls inside; all six stay in the window (Dan, 2026-11-10)', () => {
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const wide = src.match(/@media \(min-width:761px\)\{\n {2}\.v-kitchen \.you,\.v-kitchen \.you-b,\.v-kitchen \.you \.rail-wrap\{[^\n]*\n[\s\S]*?\n\}/)[0];
  assert.match(wide, /\.v-kitchen \.you-b,\.v-kitchen \.you \.rail-wrap\{flex:1;height:auto\}/);
  assert.match(wide, /\.v-kitchen \.you \.tray\{max-height:none\}/);
  // The wide rules never let a column grow past the window or scroll the middle as a whole.
  assert.doesNotMatch(wide, /\.tray-b\{[^}]*overflow:visible|you-b\{[^}]*overflow-y:auto/);
  assert.match(src, /\.v-kitchen \.rail \.at-ic\{display:none\}/);
  // A phone's stages still grow with their threads.
  assert.match(src, /@media \(max-width:760px\)\{[^}]*\}[\s\S]*?\.you \.tray-b\{flex:none;overflow:visible\}\n\}/);
  // fitRail tries the 4-line floor, then the 5-line one, then .tight, then .tighter, and starts over on each call.
  const fn = src.match(/function fitRail\(\)\{[\s\S]*?\n {2}\}/)[0];
  const run = (fits) => {
    const cls = new Set(['tight', 'tighter']);
    const rail = { clientWidth: 800, get scrollWidth() { return fits(cls) ? 800 : 900; }, classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)) } };
    vm.runInContext(fn + ' fitRail();', vm.createContext({ $$: () => [rail], fades() {} }));
    return [...cls].sort();
  };
  assert.deepEqual(run(() => true), ['four']);
  assert.deepEqual(run((c) => !c.has('four')), []);
  assert.deepEqual(run((c) => c.has('tight')), ['tight']);
  assert.deepEqual(run(() => false), ['tight', 'tighter']);
  // No floor splits a title word: each stage keeps its longest word (--word, up to 200 px), in every mode (PR-Agent on
  // #14: .tight fit with a long word split, so .tighter never ran).
  const floors = src.match(/\.v-kitchen \.rail(?:\.four|\.tight)?>\.tray:not\(\.empty\)\{min-width:max\([^}]*\}/g);
  assert.equal(floors.length, 4);
  floors.forEach((f) => assert.match(f, /,min\(var\(--word,0px\),200px\)\)/, f));
  assert.match(src, /\.v-kitchen \.rail\.tight>\.tray:not\(\.empty\)\{min-width:max\(88px,var\(--name,0px\),min\(var\(--word,0px\),200px\)\)\}/);
  assert.match(src, /\.v-kitchen \.rail\.tight\.tighter>\.tray\.empty,\.v-kitchen \.rail\.tight\.tighter>\.tray:not\(\.empty\)\{min-width:max\(88px,min\(var\(--word,0px\),200px\)\)\}/);
  assert.match(src, /tr\.style\.setProperty\('--word', Math\.ceil\(word\) \+ 'px'\)/);
  assert.doesNotMatch(src, /hyphens:auto/);
});

test('a stale page hides the rail bar with the counts (PR-Agent on #74)', () => {
  const css = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8').match(/^\.is-stale \.head-b>\.folder,[^\n]*\{visibility:hidden\}/m)[0];
  assert.match(css, /\.is-stale \.segbar[,{]/);
  // The view menu's "N need you" and the project menu's counts hide too (PR-Agent r6 on #74).
  const counts = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8').match(/^\.is-stale \.stats b,[^\n]*\{visibility:hidden\}/m)[0];
  assert.match(counts, /\.is-stale \.pmenu-l \.n[,{]/);
});

test('a page read for the old projects is not replayed when the menu closes after a pick (PR-Agent r1 on the view menu)', () => {
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  // The page a refresh keeps while a menu is open carries the address it was read for.
  assert.match(src, /if \(\$\('details\.pmenu\[open\]'\)\) \{ pendingHtml = html; pendingFor = location\.search; return; \}/);
  const fn = src.match(/function replayPending\(\)\{[\s\S]*?\n {2}\}/)[0];
  const synced = [];
  const ctx = vm.createContext({ pendingHtml: null, pendingFor: null, location: { search: '' }, sync: (h) => synced.push(h) });
  vm.runInContext(fn, ctx);
  // Read for All projects, then Fernpay picked while the menu stayed open: dropped, and the next refresh draws it.
  Object.assign(ctx, { pendingHtml: 'all', pendingFor: '', location: { search: '?p=Fernpay' } });
  vm.runInContext('replayPending()', ctx);
  assert.deepEqual([synced, ctx.pendingHtml], [[], null]);
  // Read for the address on screen: replayed.
  Object.assign(ctx, { pendingHtml: 'fernpay', pendingFor: '?p=Fernpay' });
  vm.runInContext('replayPending()', ctx);
  assert.deepEqual(synced, ['fernpay']);
  // Nothing kept: nothing drawn.
  Object.assign(ctx, { pendingHtml: null });
  vm.runInContext('replayPending()', ctx);
  assert.deepEqual(synced, ['fernpay']);
});

test('picks that cover the whole board drop out of the address, and Back redraws the boxes at once (PR-Agent r2 on #10)', () => {
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const fn = (name) => src.match(new RegExp(`function ${name}\\(\\)\\{[\\s\\S]*?\\n {2}\\}`))[0];
  const calls = [];
  const ctx = vm.createContext({ URLSearchParams, location: { pathname: '/', search: '' }, all: 'true',
    $: () => ({ getAttribute: () => ctx.all }), history: { state: null, replaceState: (s, t, u) => calls.push(u) } });
  vm.runInContext(`${fn('pickedNow')} ${fn('normalizePicked')}`, ctx);
  // The address reads as pickedFrom reads it, a project called __proto__ included.
  ctx.location.search = '?p=A&p=&p=A&p=__proto__&p=B';
  assert.deepEqual([...vm.runInContext('pickedNow()', ctx)], ['A', '__proto__', 'B']);
  ctx.location.search = '';
  assert.equal(vm.runInContext('pickedNow()', ctx), null);
  // All projects ticked with picks in the address: the picks go, and anything else in the address stays.
  ctx.location.search = '?p=A&x=1';
  vm.runInContext('normalizePicked()', ctx);
  assert.deepEqual(calls, ['/?x=1']);
  // Some picked, or no picks: the address stays as it is.
  ctx.all = 'mixed';
  vm.runInContext('normalizePicked()', ctx);
  ctx.all = 'true'; ctx.location.search = '';
  vm.runInContext('normalizePicked()', ctx);
  assert.deepEqual(calls, ['/?x=1']);

  // Back and Forward: the handler draws the address's picks when the menu has a box for each, else closes the menu.
  const onPop = src.match(/window\.addEventListener\('popstate', (function\(\)\{[\s\S]*?\n {2}\})\);/)[1];
  const drawn = [], menu = { open: true };
  const pop = vm.createContext({ picks: null, drawn, menu, state: { sel: 'k1' }, woke: 0,
    pickedNow: () => pop.picks, $$: () => ['A', 'B'].map((p) => ({ dataset: { p } })), $: () => menu,
    drawPicked: (n) => drawn.push(n), wake: () => { pop.woke++; } });
  vm.runInContext(`var onPop = ${onPop};`, pop);
  pop.picks = ['A', 'B'];
  vm.runInContext('onPop()', pop);
  pop.picks = null;
  vm.runInContext('onPop()', pop);
  assert.deepEqual([drawn, menu.open, pop.state.sel, pop.woke], [[['A', 'B'], null], true, null, 2]);
  pop.picks = ['A', 'Gone'];
  vm.runInContext('onPop()', pop);
  assert.deepEqual([drawn.length, menu.open, pop.woke], [2, false, 3]);
});

test('switching to Your team forgets the ticket the Pass kept, even with none open (PR-Agent r6 on #74)', () => {
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8').match(/function setScope\(next\)\{[\s\S]*?\n {2}\}/)[0];
  const ctx = vm.createContext({ scope: 'you', state: { sel: null, passSel: 'k1' }, placed: 0 });
  vm.runInContext(`function teamNow(){ return { name: 'Platform' }; } function store(){} function applyScope(){} function place(){ placed++; } ${src}`, ctx);
  // The reader redraws even with nothing selected: a project pick in the same open menu drops the selection before
  // the reader redraws, so its ticket would stay on screen in Team (view menu, Dan, 2026-11-10).
  vm.runInContext(`setScope('team')`, ctx);
  assert.deepEqual([ctx.scope, ctx.state.passSel, ctx.placed], ['team', null, 1]);
  // With a ticket open, it closes too.
  vm.runInContext(`scope = 'you'; state.sel = 'k2'; state.passSel = 'k2'; setScope('team')`, ctx);
  assert.deepEqual([ctx.state.sel, ctx.state.passSel, ctx.placed], [null, null, 2]);
  // Team again is no switch: nothing redraws.
  vm.runInContext(`setScope('team')`, ctx);
  assert.equal(ctx.placed, 2);
});

const menuOf = (html) => html.match(/<details class="pmenu vmenu">[\s\S]*?<\/details>/)[0];
const summaryOf = (html) => menuOf(html).match(/<summary>[\s\S]*?<\/summary>/)[0];

test('no reports: the person and You, the project check boxes, and no toggle (Dan, 2026-11-10)', () => {
  const html = page();
  const summary = summaryOf(html);
  assert.match(summary, /^<summary><svg class="ic who"[^>]*><circle cx="12" cy="8\.25"[\s\S]*?<span class="vl">You<\/span><span class="vdot" aria-hidden="true">·<\/span><span class="vp">All projects<\/span>/);
  const menu = menuOf(html);
  assert.match(menu, /<button type="button" class="pk all" role="checkbox" aria-checked="true">/);
  assert.match(menu, /<button type="button" class="pk" role="checkbox" data-p="Fernpay" aria-checked="true">/);
  assert.doesNotMatch(html, /data-scope|class="seg"|id="yc-team"|Your team|vi-team/);
});

test('with reports: the person and You or the toque and Team, never the team or mode name, and the toggle last', () => {
  for (const mode of ['brigade', 'open', null]) {
    const html = page({ team: { name: 'Platform', below: 6, mode } });
    const summary = summaryOf(html);
    // The toque means Team in both modes; the chip never names the team or its mode.
    assert.match(summary, /class="ic who vi-you"[^>]*><circle cx="12" cy="8\.25"/);
    assert.match(summary, /class="ic who vi-team"[^>]*><path d="M7\.6 16\.1/);
    assert.match(summary, /<span class="vl"><span class="vl-you">You<\/span><span class="vl-team">Team<\/span><\/span>/);
    assert.doesNotMatch(summary, /Platform|French Brigade|Open kitchen|Your team/);
    // One line at the bottom of the menu: person and You, toque and Team.
    const menu = menuOf(html);
    assert.match(menu, /<hr><div class="seg" role="radiogroup" aria-label="View"><button type="button" role="radio" aria-checked="false" data-scope="you"><svg class="ic"[^>]*><circle cx="12" cy="8\.25"[\s\S]*?<span>You<\/span><\/button><button type="button" role="radio" aria-checked="false" data-scope="team"><svg class="ic"[^>]*><path d="M7\.6 16\.1[\s\S]*?<span>Team<\/span><\/button><\/div><\/nav><\/details>$/);
  }
  const html = page({ team: { name: 'Platform', below: 6, mode: 'brigade' } });
  assert.match(html, /<script type="application\/json" id="yc-team">\{"name":"Platform","below":6,"mode":"brigade"\}<\/script>/);
  // The top bar (phones) has the same chip and menu; The Pass has its Your team state, shown only in that scope.
  assert.match(html, /<header class="bar">[\s\S]*?<details class="pmenu vmenu">[\s\S]*?<\/header>/);
  assert.match(html, /<div class="head-b"><div class="clear team-pass">[\s\S]*?Your team's calls need the team connection/);
  assert.doesNotMatch(page(), /team-pass/);
});

test('picked projects: the chip fans their marks, All projects shows a dash, and their names are the tooltip', () => {
  const two = buildBoard({ projects: [{ id: 'p', title: 'Fernpay' }, { id: 'q', title: 'Loopline' }, { id: 'r', title: 'Quillo' }],
    threads: [...THREADS, T('loop', { projectId: 'q' }), T('quill', { projectId: 'r' })], questions: new Map(), runs: RUNS, today: new Date(NOW) });
  const html = renderApp({ board: two, picked: ['Quillo', 'Fernpay'], link: (t) => `https://t3.example/${t.threadId}`, status: { ok: true, at: NOW, ms: 1 }, origin: 'https://t3.example' });
  const summary = summaryOf(html);
  // In the menu's order, each a card, with no tooltip of its own: the fan's names them all.
  assert.match(summary, /<span class="fan" style="--n:2" title="Fernpay, Quillo"><span class="card" style="--i:0"><i class="pm" style="--h:\d+" aria-hidden="true">F<\/i><\/span><span class="card" style="--i:1"><i class="pm" style="--h:\d+" aria-hidden="true">Q<\/i><\/span><span class="vh">Fernpay, Quillo<\/span><\/span>/);
  assert.doesNotMatch(summary, /All projects/);
  const menu = menuOf(html);
  assert.match(menu, /class="pk all" role="checkbox" aria-checked="mixed"/);
  assert.deepEqual([...menu.matchAll(/data-p="(\w+)" aria-checked="(\w+)"/g)].map((m) => m.slice(1)), [['Fernpay', 'true'], ['Loopline', 'false'], ['Quillo', 'true']]);
  // The board holds only the picked projects' tickets.
  assert.match(html, /data-thread="quill"/);
  assert.doesNotMatch(html, /data-thread="loop"/);
});
