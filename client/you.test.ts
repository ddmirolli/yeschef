// The You view (Dan, 2026-11-10, views mock v4). Run: vp test run you.test.ts, in client/ (the demo kitchen's run times
// are tested with the site, in site/tests/demo.test.ts).
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readRuns, timeToday, agentTime, runningSeries, duration, trackWaits, withoutWaits, mayRunToday } from './you.ts';
import type { RunsEntry, WaitEntry } from './you.ts';
import { buildBoard, renderApp } from './board.ts';
import type { RenderInput } from './board.ts';
import type { PullRequestLink, QuestionItem, ThreadRow } from './contracts.ts';
import { grab, nth } from './test/expect.ts';
import { pageScript, servedSource } from './test/served.ts';

// Local times, so "today" holds in any time zone.
const NOW = new Date(2026, 10, 10, 15, 0).getTime();
const at = (h: number, m = 0) => new Date(2026, 10, 10, h, m).toISOString();
const min = 60000;
/** A question a thread waits on. */
const Q = (id: string): QuestionItem => ({ id, requestId: 'r', question: id });
/** A thread with no update time: T3 always sends one, but the board must not count a missing one as known. */
const NO_TIME = null as unknown as string;
const run = (startedAt: string, completedAt: string | null, status = completedAt ? 'completed' : 'running') => ({ runId: startedAt, status, startedAt, completedAt });

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
  const e = (h: number, m: number) => readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(h, m), at(h + 1, m))] });
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
  assert.equal(duration(four.byProject.get('A') ?? 0), '1 min');
});

test('a thread waiting on a question stopped running when it asked: its open run ends at its last update', () => {
  const asking = T('asking', { status: 'running', updatedAt: at(14, 30) });
  const entry = readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(14), null)] });
  const b = buildBoard({ projects: [{ id: 'p', title: 'Fernpay' }], threads: [asking], questions: new Map([['asking', [Q('q')]]]), runs: new Map([['asking', entry]]), today: new Date(NOW) });
  const k = nth(b.tickets);
  assert.equal(k.working, 0);
  assert.deepEqual(nth(k.runs).runs, [{ start: Date.parse(at(14)), end: Date.parse(at(14, 30)) }]);
  assert.equal(agentTime([k], NOW).ms, 30 * min);
  assert.equal(runningSeries([k], NOW).points.at(-1), 0);
  // Without a last update, the end is not known.
  const blind = buildBoard({ projects: [], threads: [{ ...asking, updatedAt: NO_TIME }], questions: new Map([['asking', [Q('q')]]]), runs: new Map([['asking', entry]]), today: new Date(NOW) });
  assert.equal(nth(nth(nth(blind.tickets).runs).runs).open, true);
});

test('a wait stays out of agent time after the answer, while the same run carries on (PR-Agent r3 on #74)', () => {
  const log = new Map<string, WaitEntry>(), q = new Map([['asking', [Q('q')]]]);
  const asked = T('asking', { status: 'running', updatedAt: at(14, 30) }), answered = { ...asked, updatedAt: at(14, 50) };
  trackWaits(log, [asked], q, Date.parse(at(14, 40)));
  trackWaits(log, [answered], new Map(), Date.parse(at(14, 50)));
  const entry = readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(14), null)] });
  const k = nth(buildBoard({ projects: [{ id: 'p', title: 'Fernpay' }], threads: [answered], questions: new Map(), runs: new Map([['asking', entry]]), waits: log, today: new Date(NOW) }).tickets);
  assert.deepEqual(nth(k.runs).runs, [{ start: Date.parse(at(14, 50)), end: null }, { start: Date.parse(at(14)), end: Date.parse(at(14, 30)) }]);
  assert.equal(agentTime([k], NOW).ms, 40 * min);
  assert.deepEqual(runningSeries([k], NOW).points, [1, 1, 0, 0, 1]);
  // Once the run ends, the wait still stays out.
  const done = withoutWaits(readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(14), at(14, 55))] }), log.get('asking'));
  assert.ok(done);
  assert.equal(timeToday(done, NOW).ms, 35 * min);
});

test('a wait seen without a start time leaves its run unknown after the answer; waits end with the day and the thread', () => {
  const log = new Map<string, WaitEntry>();
  trackWaits(log, [T('x', { status: 'waiting', updatedAt: NO_TIME })], new Map(), Date.parse(at(14, 40)));
  trackWaits(log, [T('x', { status: 'running', updatedAt: at(14, 50) })], new Map(), Date.parse(at(14, 50)));
  const e = withoutWaits(readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(14), null), run(at(12), at(13))] }), log.get('x'));
  assert.ok(e);
  assert.equal(nth(e.runs).open, true);
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
  const nostart = (completedAt: string | null, status = completedAt ? 'completed' : 'running') => ({ runId: 'n', status, startedAt: null, completedAt });
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
  assert.equal(mayRunToday(T('c', { updatedAt: NO_TIME }), t0), true);
  assert.equal(mayRunToday(T('d', { updatedAt: 'garbled' }), t0), true);
  assert.equal(mayRunToday(T('e', { updatedAt: yday }), t0), false);
  assert.equal(mayRunToday(T('f', { latestRunId: null, updatedAt: NO_TIME }), t0), false);
});

test('durations read as minutes, then hours', () => {
  assert.equal(duration(40 * min), '40 min');
  assert.equal(duration(240 * min), '4 h');
  assert.equal(duration(330 * min), '5.5 h');
});

// ----- The page -----
const T = (id: string, extra: Partial<ThreadRow> = {}): ThreadRow => ({ threadId: id, title: id, projectId: 'p', status: 'completed', latestRunId: 'r', updatedAt: at(14), pullRequests: [], ...extra });
const pr = (n: number, state: string): PullRequestLink => ({ repository: 'o/r', number: n, state });
const THREADS = [
  T('backlog', { status: 'idle', latestRunId: null }), T('planned'), T('cooking', { status: 'running' }),
  T('review', { pullRequests: [pr(1, 'open')] }), T('merged', { pullRequests: [pr(2, 'merged')] }),
  T('held', { snoozed: true }), T('done', { settled: true, settledAt: at(13), pullRequests: [pr(3, 'merged')] }),
];
const RUNS = new Map([['cooking', readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(14), null)] })],
  ['review', readRuns({ thread: { runCount: 1 }, recentRuns: [run(at(10), at(12))] })]]);
const board = (runs: ReadonlyMap<string, RunsEntry> = RUNS) => buildBoard({ projects: [{ id: 'p', title: 'Fernpay' }], threads: THREADS, questions: new Map(), runs, today: new Date(NOW) });
const page = (o: Partial<RenderInput> & { runs?: ReadonlyMap<string, RunsEntry> } = {}) => renderApp({ board: board(o.runs), link: (t) => `https://t3.example/${t.threadId}`, status: { ok: true, at: NOW, ms: 1 }, origin: 'https://t3.example', ...o });

test('stage dots are a gray ramp up to In progress, never orange', () => {
  const html = page();
  for (const c of ['backlog', 'planned', 'prog', 'open', 'blue', 'merged']) assert.match(html, new RegExp(`gd c-${c}"`));
  assert.doesNotMatch(html, /c-amber[^"]*"><\/i>In progress|data-folder="In progress"><i class="gd c-amber/);
});

test('the rail opens with the person and one bar piece per thread on the line, Backlog to Merged, left to right', () => {
  const html = page();
  const row = grab(html, /<div class="idrow">[\s\S]*?<\/span><\/div>/);
  assert.match(row, /<span class="vh">You<\/span>/);
  assert.deepEqual([...row.matchAll(/<i class="c-(\w+)"><\/i>/g)].map((m) => m[1]), ['backlog', 'planned', 'prog', 'open', 'merged']);
  assert.doesNotMatch(html, /Your threads<\/h3>|class="nav-h"/);
});

const youOf = (html: string) => grab(html, /<section class="you"[\s\S]*?<\/div><\/div><\/div><\/section>/);

test('You, expanded is the header picker over the solo Sankey (Dan, 2026-11-10 and 2026-11-11, flow mock v3.3)', () => {
  const html = page(), you = youOf(html);
  // The header is the project picker (Dan, 2026-11-11): the person, All projects, the chevron; then the three grays at
  // its right, so the chart runs to the foot of the column (Dan, 2026-11-12). "All projects" is said once.
  assert.match(you, /^<section class="you" aria-label="Your threads by stage"><header class="you-h"><details class="pmenu vmenu vhead"><summary><span class="vi" title="You"><svg class="ic who"[^>]*><circle cx="12" cy="8\.25"[\s\S]*?<span class="vh">You<\/span><\/span><span class="vp">All projects<\/span><svg class="ic"[\s\S]*?<\/details><div class="fx-key"[\s\S]*?<\/div><\/header><div class="you-b"><div class="fx-wrap"><div class="fx-view"><svg class="fx"/);
  assert.equal(you.split('>All projects<').length - 1, 2); // the summary and the menu's own All projects box
  assert.doesNotMatch(you, /class="tray|class="rail|fx-crumb|data-undrill/);
  // One project picked is its threads: each one band, and it opens the same plate its card does.
  const opened = grab(youOf(page({ picked: ['Fernpay'] })), /<div class="fx-view">[\s\S]*?<\/svg><\/div>/);
  const plates = [...opened.matchAll(/<path class="band [^"]+"[^>]*data-plate="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(plates.length, 5);
  for (const id of plates) assert.match(html, new RegExp(`<article class="plate" id="${id}"`));
  // Held and verified threads stay off the line, as they did off the columns.
  assert.match(opened, /aria-label="Fernpay: its threads, left to right from start to merge"/);
  assert.match(you, /<header class="you-h">[\s\S]*?<div class="fx-key" title="Time since the last change">/);
  // Dan cut the header line, the four cards, the "At The Pass" key and the panels under the board.
  for (const gone of [/class="you-sub"/, /class="inst"/, /Agents running/, /Merged today/, /Checks on open PRs/, /Your agents wait on you/,
    /At The Pass/, /Merged, last 7 days/, /Agent time today/, /class="held"/, /class="pnl/]) assert.doesNotMatch(you, gone);
  // Verified and on hold stay one click away in the stage list.
  assert.match(html, /<button type="button" class="nf" data-folder="Verified">[\s\S]*?<span class="n">1<\/span><\/button><button type="button" class="nf" data-folder="On hold">/);
});

test('without a good poll the chart says "Not checked" and draws no threads', () => {
  const you = youOf(page({ status: { ok: false, error: 'down', at: NOW, ms: 0 } }));
  assert.match(you, /<div class="fx-empty"><p><b>Not checked<\/b><\/p>/);
  assert.doesNotMatch(you, /<svg class="fx"|data-plate=|Gray is time/);
});

test('the chart fills the view and scrolls inside it when the window is narrow or the line is long', () => {
  const src = servedSource();
  const wide = grab(src, /@media \(min-width:761px\)\{\n {2}\.v-kitchen \.you\{[^\n]*\n[\s\S]*?\n\}/);
  assert.match(wide, /\.v-kitchen \.you\{display:flex;flex-direction:column;min-height:0\}/);
  assert.match(wide, /\.v-kitchen \.you-b\{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain\}/);
  assert.match(src, /\.fx-wrap\{position:relative;min-width:720px\}/);
  // The columns' fitting is gone with them.
  assert.doesNotMatch(src, /function fitRail|\.rail-wrap|\.tray-b/);
  // A stale page hides the chart, as it hid the columns' counts.
  assert.match(src, /\.is-stale[^{]*\.fx-wrap[,{]/);
});

test('the river stretches to the foot of the column, never below its own height, and its names move with their nodes', () => {
  // Dan, 2026-11-12: the chart stopped halfway down the page beside a full-height Pass.
  const src = pageScript();
  const fns = grab(src, /var flowRO = [\s\S]*?\n {2}\/\/ Hover links the chart/).replace(/\/\/ Hover links the chart$/, '');
  const attrs = (o: Record<string, string>) => ({ a: o, setAttribute(k: string, v: string) { this.a[k] = v; }, removeAttribute(k: string) { delete this.a[k]; } });
  const name = { dataset: { y: '100' } as Record<string, string>, ...attrs({ y: '100' }) };
  const stop = { dataset: { y: '150', dy: '-7' } as Record<string, string>, ...attrs({ y: '143' }) };
  const body = { dataset: { top: '58', span: '200' }, ...attrs({}) };
  // Natural height 58 + 200 + 18 = 276 at 860 wide; the column is 700 high and 860 wide, with a 50 px key under the chart.
  const make = (colH: number) => {
    let vh = 276;
    const svg = {
      viewBox: { baseVal: { width: 860 } }, ...attrs({}),
      getBoundingClientRect: () => ({ width: 860, height: vh }),
      querySelector: () => body, querySelectorAll: () => [name, stop],
      closest: () => ({ getBoundingClientRect: () => ({ height: vh + 50 }) }),
    };
    svg.setAttribute = function (k: string, v: string) { this.a[k] = v; if (k === 'viewBox') vh = Number(v.split(' ')[3]); };
    const col = { clientHeight: colH };
    const one: Record<string, unknown> = { '.you .you-b': col, '.you .fx-view:not([hidden]) svg.fx': svg };
    const ctx = vm.createContext({ window: {}, $: (s: string) => one[s] ?? null, getComputedStyle: () => ({ paddingTop: '0', paddingBottom: '12px' }) });
    vm.runInContext(fns, ctx);
    vm.runInContext('watchFlow()', ctx);
    return svg;
  };
  const tall = make(700);
  // 700 - 50 key - 12 padding - 1 = 637 high: the body stretches from 200 to 637 - 76 = 561.
  assert.equal(tall.a.viewBox, '0 0 860 637.0');
  assert.match(body.a.transform!, /^translate\(0 58\) scale\(1 2\.805\d*\) translate\(0 -58\)$/);
  assert.equal(name.a.y, (58 + 42 * 2.805).toFixed(1));
  assert.equal(stop.a.y, (58 + 92 * 2.805 - 7).toFixed(1));
  // A short column never squeezes the river: it keeps its own height and the column scrolls.
  const short = make(200);
  assert.equal(short.a.viewBox, '0 0 860 276.0');
  assert.equal(body.a.transform, undefined);
  assert.equal(stop.a.y, '143.0');
  // The page measures again when the column changes size and after each refresh.
  assert.match(src, /var flowRO = window\.ResizeObserver \? new ResizeObserver\(function\(\)\{ fitFlow\(\); \}\)/);
  assert.match(grab(src, /function applyFlow[\s\S]*?\n {2}\}/), /watchFlow\(\);/);
  // Strokes keep their width when the river stretches.
  assert.match(servedSource(), /\.fx \.fx-body \*\{vector-effect:non-scaling-stroke\}/);
});

test('hover lights the chart and The Pass both ways; a project click picks that project', () => {
  const src = pageScript();
  const fns = grab(src, /function applyFlow[\s\S]*?\n {2}function flowTip/).replace(/function flowTip$/, '');
  type El = { dataset: Record<string, string>; hidden: boolean; textContent: string; cls: Set<string>; classList: { toggle(c: string, on: boolean): void; contains(c: string): boolean } };
  const el = (dataset: Record<string, string> = {}): El => {
    const cls = new Set<string>();
    return { dataset, hidden: false, textContent: '', cls, classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) } };
  };
  const board = el();
  const band = el({ k: 'fl:0 g:Fernpay t:p-1 t:p-2 n:review' }), other = el({ k: 'fl:1 g:Fernpay t:p-3' }), card = el({ plate: 'p-2' }), card3 = el({ plate: 'p-9' });
  const one: Record<string, El> = { '.board': board };
  const many: Record<string, El[]> = { '.you .fx-view:not([hidden]) [data-k]': [band, other], '.head-b .folder[data-folder="pass"] .call-tile[data-plate]': [card, card3] };
  const ctx = vm.createContext({ window: {}, $: (s: string) => one[s] ?? null, $$: (s: string) => many[s] ?? [] });
  vm.runInContext(fns, ctx);
  const run = (code: string) => vm.runInContext(code, ctx);
  // A band lights itself and its threads' cards; the band beside it steps back.
  run(`flowFocus(['fl:0', 't:p-1', 't:p-2'])`);
  assert.ok(board.cls.has('fx-focus') && band.cls.has('lit') && !other.cls.has('lit'));
  assert.ok(card.cls.has('lit') && !card3.cls.has('lit'));
  // A card lights its thread's band.
  run(`flowFocus(['t:p-3'])`);
  assert.ok(other.cls.has('lit') && !band.cls.has('lit') && !card.cls.has('lit'));
  // A project lights every band of it.
  run(`flowFocus(['g:Fernpay'])`);
  assert.ok(band.cls.has('lit') && other.cls.has('lit') && card.cls.has('lit'));
  // A refresh keeps what the pointer lit (it calls applyFlow(false) after drawing the fresh chart and Pass).
  band.cls.delete('lit'); card.cls.delete('lit');
  run(`applyFlow(false)`);
  assert.ok(board.cls.has('fx-focus') && band.cls.has('lit') && card.cls.has('lit'));
  // A band's own key is its place, which a refresh can hand another band: only thread, project and stop keys come back.
  run(`flowFocus(['fl:1'])`);
  assert.ok(other.cls.has('lit'));
  run(`applyFlow(false)`);
  assert.ok(!board.cls.has('fx-focus') && !other.cls.has('lit'));
  run(`flowFocus(['fl:0', 't:p-1', 't:p-2'])`);
  run(`applyFlow(false)`);
  assert.ok(band.cls.has('lit') && !other.cls.has('lit'));
  run(`flowFocus(null)`);
  assert.ok(!board.cls.has('fx-focus') && !band.cls.has('lit') && !card.cls.has('lit'));
  // A click on a project picks it alone, as the header picker does, and the picker goes back.
  assert.match(src, /closest\s*(?:<Element>)?\s*\('\.you \[data-drill\]'\)[\s\S]{0,200}pickOnly\(dr\.getAttribute\('data-drill'\)/);
  assert.match(grab(src, /function pickOnly[\s\S]*?\n {2}\}/), /drawPicked\(\[name\]\);[\s\S]*?history\.pushState\(null, '', location\.pathname \+ q\); state\.sel = null; wake\(\);/);
  assert.doesNotMatch(src, /applyDrill|data-undrill|fx-crumb/);
  assert.match(src, /normalizePicked\(\); applyFlow\(false\); fades\(\);/);
  // Enter or Space on a focused project name or thread band clicks it, before the board's own keys see it.
  assert.match(src, /closest\('\.you \.fx-view \[tabindex\]\[role=button\]'\)[\s\S]{0,200}dispatchEvent\(new MouseEvent\('click'[\s\S]{0,80}\}, true\);/);
});

test('a stale page hides the rail bar with the counts (PR-Agent on #74)', () => {
  const css = grab(servedSource(), /^\.is-stale \.head-b>\.folder,[^\n]*\{visibility:hidden\}/m);
  assert.match(css, /\.is-stale \.segbar[,{]/);
  // The view menu's "N need you" and the project menu's counts hide too (PR-Agent r6 on #74).
  const counts = grab(servedSource(), /^\.is-stale \.stats b,[^\n]*\{visibility:hidden\}/m);
  assert.match(counts, /\.is-stale \.pmenu-l \.n[,{]/);
});

test('a page read for the old projects is not replayed when the menu closes after a pick (PR-Agent r1 on the view menu)', () => {
  const src = pageScript();
  // The page a refresh keeps while a menu is open carries the address it was read for.
  assert.match(src, /if \(\$\('details\.pmenu\[open\]'\)\) \{ pendingHtml = html; pendingFor = location\.search; return; \}/);
  const fn = grab(src, /function replayPending\(\)\{[\s\S]*?\n {2}\}/);
  const synced: unknown[] = [];
  const ctx = vm.createContext({ pendingHtml: null, pendingFor: null, location: { search: '' }, sync: (h: unknown) => synced.push(h) });
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
  const src = pageScript();
  // A typed signature keeps spaces where its types were (test/served.ts).
  const fn = (name: string) => grab(src, new RegExp(`function ${name}\\(\\)\\s*\\{[\\s\\S]*?\\n {2}\\}`));
  const calls: string[] = [];
  const ctx = vm.createContext({ URLSearchParams, location: { pathname: '/', search: '' }, all: 'true',
    $: () => ({ getAttribute: () => ctx.all }), history: { state: null, replaceState: (_s: unknown, _t: unknown, u: string) => calls.push(u) } });
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
  const onPop = grab(src, /window\.addEventListener\('popstate', (function\(\)\{[\s\S]*?\n {2}\})\);/, 1);
  const drawn: unknown[] = [], menu = { open: true };
  const pop = vm.createContext({ picks: null, drawn, menu, state: { sel: 'k1' }, woke: 0,
    pickedNow: () => pop.picks, $$: () => ['A', 'B'].map((p) => ({ dataset: { p } })), $: () => menu,
    drawPicked: (n: unknown) => drawn.push(n), wake: () => { pop.woke++; } });
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
  const src = grab(pageScript(), /function setScope\(next\s*\)\s*\{[\s\S]*?\n {2}\}/);
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

const menuOf = (html: string) => grab(html, /<details class="pmenu vmenu">[\s\S]*?<\/details>/);
const summaryOf = (html: string) => grab(menuOf(html), /<summary>[\s\S]*?<\/summary>/);

test('no reports: the person, the project check boxes, and no toggle (Dan, 2026-11-10)', () => {
  const html = page();
  const summary = summaryOf(html);
  // No "You" in sight (Dan, 2026-11-11): the person's tooltip and a hidden label say it.
  assert.match(summary, /^<summary><span class="vi" title="You"><svg class="ic who"[^>]*><circle cx="12" cy="8\.25"[\s\S]*?<\/svg><span class="vh">You<\/span><\/span><span class="vp">All projects<\/span>/);
  assert.doesNotMatch(summary, /class="vl|vdot|<span>You<\/span>/);
  const menu = menuOf(html);
  assert.match(menu, /<button type="button" class="pk all" role="checkbox" aria-checked="true">/);
  assert.match(menu, /<button type="button" class="pk" role="checkbox" data-p="Fernpay" aria-checked="true">/);
  assert.doesNotMatch(html, /data-scope|class="seg"|id="yc-team"|Your team|vi-team/);
});

test('with reports: the person or the toque, never a word, the team or the mode name, and the toggle last', () => {
  for (const mode of ['brigade', 'open', null]) {
    const html = page({ team: { name: 'Platform', below: 6, mode } });
    const summary = summaryOf(html);
    // The toque means Team in both modes; the chip never names the team or its mode.
    // Icons only (Dan, 2026-11-11): each carries its word as a tooltip and a hidden label.
    assert.match(summary, /<span class="vi vi-you" title="You"><svg class="ic who"[^>]*><circle cx="12" cy="8\.25"[\s\S]*?<\/svg><span class="vh">You<\/span><\/span>/);
    assert.match(summary, /<span class="vi vi-team" title="Team"><svg class="ic who"[^>]*><path d="M7\.6 16\.1[\s\S]*?<\/svg><span class="vh">Team<\/span><\/span>/);
    assert.doesNotMatch(summary, /Platform|French Brigade|Open kitchen|Your team|class="vl|vdot/);
    // One line at the bottom of the menu: the person and the toque, named for a screen reader and the tooltip.
    const menu = menuOf(html);
    assert.match(menu, /<hr><div class="seg" role="radiogroup" aria-label="View"><button type="button" role="radio" aria-checked="false" data-scope="you" aria-label="You" title="You"><svg class="ic"[^>]*><circle cx="12" cy="8\.25"[\s\S]*?<\/svg><\/button><button type="button" role="radio" aria-checked="false" data-scope="team" aria-label="Team" title="Team"><svg class="ic"[^>]*><path d="M7\.6 16\.1[\s\S]*?<\/svg><\/button><\/div><\/nav><\/details>$/);
    assert.doesNotMatch(menu, /<span>(You|Team)<\/span>/);
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
