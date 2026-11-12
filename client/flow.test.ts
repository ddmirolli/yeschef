// You's Sankey (Dan, 2026-11-11, flow mock v3.3; client/flow.ts). Run: vp test run flow.test.ts, in client/.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ageOf, layout, drawFlow, youFlow, FLOW_KEY, CLOCHE, DAY } from './flow.ts';
import type { FlowItem, FlowStage } from './flow.ts';
import { grab } from './test/expect.ts';
import { servedSource } from './test/served.ts';

const NOW = Date.UTC(2026, 10, 12, 12);
const I = (id: string, project: string, stage: FlowStage, ageDays = 0, extra: Partial<FlowItem> = {}): FlowItem =>
  ({ id, title: id, project, stage, since: NOW - ageDays * DAY - 1000, subs: 0, waits: false, pr: null, ...extra });
const LINE: FlowItem[] = [
  I('b1', 'Fernpay', 'Backlog'), I('p1', 'Fernpay', 'Planned', 2), I('c1', 'Fernpay', 'In progress', 0, { subs: 3 }),
  I('r1', 'Fernpay', 'In review', 4), I('r2', 'Fernpay', 'In review', 4), I('m1', 'Fernpay', 'Merged', 0, { base: 'main' }),
  I('y1', 'Yes Chef', 'Ready to merge', 0, { waits: true, pr: 12 }), I('m2', 'Yes Chef', 'Merged', 1, { base: 'main' }),
];

test('gray is time since the last change in three steps; no time is "not checked"', () => {
  assert.equal(ageOf(NOW - 1000, NOW), 0);
  assert.equal(ageOf(NOW - DAY, NOW), 1);
  assert.equal(ageOf(NOW - 3 * DAY + 1, NOW), 1);
  assert.equal(ageOf(NOW - 3 * DAY, NOW), 2);
  assert.equal(ageOf(Number.NaN, NOW), null);
});

test('every project: threads of one project, stage and age share a band; one that waits on you has its own', () => {
  const L = layout(LINE, NOW);
  assert.deepEqual(L.groups.map((g) => g.name), ['Fernpay', 'Yes Chef']);
  const r = L.bands.filter((b) => b.stage === 'In review');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0]!.items.map((t) => t.id), ['r1', 'r2']);
  const w = L.bands.filter((b) => b.waits);
  assert.deepEqual(w.map((b) => b.items.map((t) => t.id)), [['y1']]);
  // Band ids are unique, and width is threads.
  assert.equal(new Set(L.bands.map((b) => b.id)).size, L.bands.length);
  const u = L.bands[0]!.h / L.bands[0]!.items.length;
  for (const b of L.bands) assert.equal(b.h, b.items.length * u);
});

test('what goes into a node comes out of it: heights add up at every project and stop', () => {
  for (const drill of [null, 'Fernpay', 'Yes Chef']) {
    const L = layout(LINE, NOW, drill);
    for (const g of L.groups) assert.equal(Math.round(g.h * 1000), Math.round(L.bands.filter((b) => b.group === g.name).reduce((s, b) => s + b.h, 0) * 1000));
    for (const s of ['review', 'you', 'main'] as const) {
      const n = L.nodes[s], at = L.bands.filter((b) => b.path.includes(s));
      if (!at.length) { assert.equal(n, undefined); continue; }
      assert.ok(n);
      assert.equal(Math.round(n.h * 1000), Math.round(at.reduce((a, b) => a + b.h, 0) * 1000));
      // No two bands overlap at a node, and all of them sit inside it.
      const spans = at.map((b) => [b.yIn[s]!, b.yIn[s]! + b.h] as const).sort((a, b) => a[0] - b[0]);
      spans.forEach(([y0, y1], i) => {
        assert.ok(y0 >= n.y - 1e-6 && y1 <= n.y + n.h + 1e-6);
        if (i) assert.ok(y0 >= spans[i - 1]![1] - 1e-6);
      });
    }
  }
});

test('stages read left to right: a band\'s path only moves right, and the stubs end further right the further along', () => {
  const L = layout(LINE, NOW);
  const order = ['review', 'you', 'main'];
  for (const b of L.bands) assert.deepEqual(b.path, order.slice(0, b.path.length));
  const svg = drawFlow(L, NOW);
  const zones = [...svg.matchAll(/<text class="zlbl" x="(\d+)" y="19">([^<]+)/g)].map((m) => [Number(m[1]), m[2]] as const);
  assert.deepEqual(zones.map((z) => z[1]), ['Before review', 'In review', 'Ready to merge', 'Merged', 'Release']);
  zones.forEach((z, i) => { if (i) assert.ok(z[0] > zones[i - 1]![0]); });
  // Backlog, Planned and In progress stop short of review, in that order.
  const end = (id: string) => {
    const d = grab(svg, new RegExp(`data-k="[^"]*t:${id}[^"]*"[^>]*d="([^"]+)"`), 1);
    return Math.max(...[...d.matchAll(/L([\d.]+),/g)].map((m) => Number(m[1])));
  };
  assert.ok(end('b1') < end('p1') && end('p1') < end('c1'));
  assert.match(svg, /<text class="zcount" x="\d+" y="34">not checked<\/text>/);
});

test('no red, orange or yellow, and no mark at rest: a thread that waits on you keeps its gray; its tooltip says so (Dan, 2026-11-12)', () => {
  const svg = drawFlow(layout(LINE, NOW), NOW);
  const cls = [...svg.matchAll(/<path class="band ([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(cls.length);
  for (const c of cls) assert.match(c, /^(a0|a1|a2|anc)( wait)?$/);
  assert.equal(cls.filter((c) => c.endsWith(' wait')).length, 1);
  assert.doesNotMatch(svg, /fill="#|style="[^"]*(?:fill|stroke)/);
  // The Pass lists what waits on you, so the chart draws nothing extra for it.
  assert.doesNotMatch(svg, /class="atp"|class="marks"/);
  // The tooltip's icon is the cloche its card carries.
  assert.ok(readFileSync(new URL('./board.ts', import.meta.url), 'utf8').includes(`cloche: '${CLOCHE}'`));
  // The chart's CSS has no red, orange or yellow at all, and nothing styles a waiting band apart.
  const css = grab(servedSource(), /\/\* You, expanded \(Dan, 2026-11-11[\s\S]*?\.fx-empty\{[^}]*\}/);
  assert.doesNotMatch(css, /--(?:red|orange|yellow|amber)\b/);
  assert.doesNotMatch(css, /\.wait\b|\.atp\b/);
  // The alarm says so in words beside the icon.
  assert.match(svg, /&lt;div class=&quot;alarm&quot;&gt;&lt;svg[^]*?&lt;\/svg&gt;Waiting on you/);
  assert.doesNotMatch(FLOW_KEY, /Waiting on you/);
});

test('a thread with no time is drawn dashed and says "not checked"', () => {
  const svg = drawFlow(layout([I('x', 'P', 'In review', 0, { since: Number.NaN })], NOW), NOW);
  assert.match(svg, /<path class="band anc"/);
  // Its whole ribbon answers hover and click, not only the dashes (PR-Agent r3 on #49).
  assert.match(servedSource(), /\.fx \.band\.anc\{fill:none;[^}]*pointer-events:all\}/);
  assert.match(svg, /Last change not checked ago|Last change not checked/);
});

test('opening a project: one band per thread, each opening its ticket, with a hairline per subagent', () => {
  const L = layout(LINE, NOW, 'Fernpay');
  assert.equal(L.bands.length, 6);
  assert.ok(L.bands.every((b) => b.items.length === 1 && b.lane !== null));
  // Lanes never overlap.
  const lanes = L.bands.map((b) => [b.lane!, b.lane! + b.h] as const).sort((a, b) => a[0] - b[0]);
  lanes.forEach(([y0], i) => { if (i) assert.ok(y0 >= lanes[i - 1]![1]); });
  const svg = drawFlow(L, NOW);
  assert.deepEqual([...svg.matchAll(/<path class="band [^"]+"[^>]*data-plate="([^"]+)"/g)].map((m) => m[1]).sort(), ['b1', 'c1', 'm1', 'p1', 'r1', 'r2']);
  assert.doesNotMatch(svg, /data-drill=/);
  assert.equal([...svg.matchAll(/<path class="fanl /g)].length, 3);
  // Subagent hairlines stop at 8.
  const many = drawFlow(layout([I('z', 'P', 'In progress', 0, { subs: 20 })], NOW, 'P'), NOW);
  assert.equal([...many.matchAll(/<path class="fanl /g)].length, 8);
});

test('every project: a band or a project opens the project; the page gets one view per project', () => {
  const html = youFlow(LINE, NOW);
  assert.match(html, /^<div class="fx-view" data-view=""><svg class="fx"/);
  assert.deepEqual([...html.matchAll(/<div class="fx-view" data-view="([^"]*)"( hidden)?>/g)].map((m) => [m[1], !!m[2]]), [['', false], ['Fernpay', true], ['Yes Chef', true]]);
  const top = grab(html, /^<div class="fx-view" data-view="">[\s\S]*?<\/svg><\/div>/);
  assert.doesNotMatch(top, /data-plate=/);
  assert.match(top, /<path class="band [^"]+"[^>]*data-drill="Yes Chef"/);
  assert.match(top, /<rect class="node"[^>]*data-drill="Fernpay"/);
  assert.match(top, /<text class="gname"[^>]*data-drill="Fernpay"[^>]*>Fernpay<\/text>/);
});

test('hover keys split on spaces: a project name with spaces is one key, and each thread is a t: key', () => {
  const svg = drawFlow(layout(LINE, NOW), NOW);
  const band = grab(svg, /<path class="band a\d wait"[^>]*>/);
  const k = grab(band, /data-k="([^"]+)"/, 1).split(' ');
  assert.ok(k.includes('g:Yes%20Chef'));
  assert.ok(k.includes('t:y1'));
  assert.ok(k.includes('n:review') && k.includes('n:you') && !k.includes('n:main'));
  assert.deepEqual(grab(band, /data-f="([^"]+)"/, 1).split(' ').slice(1), ['t:y1']);
});

test('names and titles are escaped everywhere', () => {
  const bad = '<img src=x onerror=alert(1)>"&\'';
  const html = youFlow([I('a"b', bad, 'Merged', 0, { title: bad, base: bad })], NOW);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /data-plate="a"b"/);
  assert.match(html, /data-view="&lt;img src=x onerror=alert\(1\)&gt;&quot;&amp;&#39;"/);
});

test('the merged node names the branch only when every merged thread went into the same known one', () => {
  const named = drawFlow(layout(LINE, NOW), NOW);
  assert.match(named, /<text class="gname"[^>]*>main<\/text>/);
  const mixed = drawFlow(layout([I('a', 'P', 'Merged', 0, { base: 'main' }), I('b', 'P', 'Merged', 0, { base: 'staging' })], NOW), NOW);
  assert.doesNotMatch(mixed, />main<\/text>|>staging<\/text>/);
  const unknown = drawFlow(layout([I('a', 'P', 'Merged')], NOW), NOW);
  assert.doesNotMatch(unknown, /<text class="gname"[^>]*>(?!Review|You|P)[^<]+<\/text>/);
});

test('the key names the three gray steps and how to read the chart', () => {
  assert.deepEqual([...FLOW_KEY.matchAll(/<i class="sw a(\d)"><\/i>([^<]+)/g)].map((m) => m[2]), ['under 1 day', '1 to 3 days', 'over 3 days']);
  assert.match(FLOW_KEY, /Gray is time since the last change:/);
});

test('every thread keeps a positive width, even with more projects than the chart has room for (PR-Agent r1 on #49)', () => {
  const many = Array.from({ length: 75 }, (_, i) => I(`t${i}`, `P${String(i).padStart(2, '0')}`, 'In review'));
  const L = layout(many, NOW);
  assert.ok(L.bands.every((b) => b.h >= 3));
  assert.ok(L.groups.every((g) => g.h > 0));
  assert.ok(L.nodes.review && L.nodes.review.h > 0);
  // The chart grows to hold them, so nothing leaves the drawing.
  assert.ok(L.groups.every((g) => g.y >= 0 && g.y + g.h <= L.H));
  assert.doesNotMatch(drawFlow(L, NOW), /height="-|,-\d/);
});

test('a keyboard reaches every project by its name and, opened, every thread (PR-Agent r1 on #49)', () => {
  const top = drawFlow(layout(LINE, NOW), NOW);
  assert.deepEqual([...top.matchAll(/<text class="gname"[^>]*tabindex="0" role="button" aria-label="([^"]+)"/g)].map((m) => m[1]), ['Open Fernpay: 6 threads', 'Open Yes Chef: 2 threads']);
  assert.doesNotMatch(grab(top, /<g class="bands">[\s\S]*?<\/g>/), /tabindex/);
  const yc = drawFlow(layout(LINE, NOW, 'Yes Chef'), NOW);
  assert.match(yc, /<path class="band a0 wait"[^>]*data-plate="y1" tabindex="0" role="button" aria-label="y1, Ready to merge, waiting on you"/);
  assert.match(yc, /<path class="band a1"[^>]*data-plate="m2" tabindex="0" role="button" aria-label="m2, Merged"/);
});

test('each view draws its own dots and fills the height the page gives it', () => {
  const html = youFlow(LINE, NOW);
  const ids = [...html.matchAll(/<pattern id="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(ids.length > 1);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^fx-dots-[a-z0-9]+$/);
  // Zones, dots and lines run the full height; the river and its names carry what the page needs to stretch them.
  const svg = drawFlow(layout(LINE, NOW), NOW);
  assert.match(svg, /<rect class="zone z0" x="0" y="0" width="262" height="100%"\/>/);
  assert.match(svg, /<line class="zline"[^>]*y2="100%"\/>/);
  assert.match(svg, /<g class="fx-body" data-top="58" data-span="[\d.]+"><g class="bands">/);
  assert.match(svg, /<\/g><g class="fx-names"><text class="gname"[^>]*data-y="[\d.]+"/);
});
