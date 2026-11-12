// You's Sankey (Dan, 2026-11-11, flow mock v3.3; client/flow.ts). Run: vp test run flow.test.ts, in client/.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ageOf, layout, drawFlow, youFlow, fitFrom, FLOW_KEY, CLOCHE, DAY, W } from './flow.ts';
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
    // A node runs from its first band's top to its last band's foot: the bands, and the space between them that closes
    // left to right.
    for (const g of L.groups) {
      const mine = L.bands.filter((b) => b.group === g.name);
      assert.ok(g.h + 1e-6 >= mine.reduce((s, b) => s + b.h, 0));
      assert.ok(Math.abs(Math.min(...mine.map((b) => b.y0)) - g.y) < 1e-6 && Math.abs(Math.max(...mine.map((b) => b.y0 + b.h)) - (g.y + g.h)) < 1e-6);
    }
    for (const s of ['review', 'you', 'main'] as const) {
      const n = L.nodes[s], at = L.bands.filter((b) => b.path.includes(s));
      if (!at.length) { assert.equal(n, undefined); continue; }
      assert.ok(n);
      assert.ok(n.h + 1e-6 >= at.reduce((a, b) => a + b.h, 0));
      // No two bands overlap at a node, and all of them sit inside it.
      const spans = at.map((b) => [b.yIn[s]!, b.yIn[s]! + b.h] as const).sort((a, b) => a[0] - b[0]);
      assert.ok(Math.abs(spans[0]![0] - n.y) < 1e-6 && Math.abs(Math.max(...spans.map((r) => r[1])) - (n.y + n.h)) < 1e-6);
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

test('every project: a band or a project picks the project; one project shows its threads, named over its node', () => {
  const html = youFlow(LINE, NOW);
  assert.equal([...html.matchAll(/<div class="fx-view">/g)].length, 1);
  assert.doesNotMatch(html, /data-view=| hidden/);
  const top = grab(html, /^<div class="fx-view">[\s\S]*?<\/svg><\/div>/);
  assert.doesNotMatch(top, /data-plate=/);
  assert.match(top, /<path class="band [^"]+"[^>]*data-drill="Yes Chef"/);
  assert.match(top, /<rect class="node"[^>]*data-drill="Fernpay"/);
  assert.match(top, /<text class="gname"[^>]*data-drill="Fernpay"[^>]*>Fernpay<\/text>/);
  // One project (picked in the header, or clicked here) is its threads, and its name sits over its node.
  const one = youFlow(LINE.filter((t) => t.project === 'Fernpay'), NOW);
  assert.match(one, /data-plate=/);
  assert.doesNotMatch(one, /data-drill=/);
  assert.match(one, /<text class="gname strong"[^>]*data-dy="-7" text-anchor="middle">Fernpay<\/text>/);
  // No second line of labels over the columns: each node is named on its own.
  assert.doesNotMatch(html + one, /tierh|Checks and review<|You merge</);
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
  assert.match(html, /aria-label="&lt;img src=x onerror=alert\(1\)&gt;&quot;&amp;&#39;: its threads/);
});

test('the merged node names the branch only when every merged thread went into the same known one', () => {
  const named = drawFlow(layout(LINE, NOW), NOW);
  assert.match(named, /<text class="gname"[^>]*>main<\/text>/);
  const mixed = drawFlow(layout([I('a', 'P', 'Merged', 0, { base: 'main' }), I('b', 'P', 'Merged', 0, { base: 'staging' })], NOW), NOW);
  assert.doesNotMatch(mixed, />main<\/text>|>staging<\/text>/);
  const unknown = drawFlow(layout([I('a', 'P', 'Merged')], NOW), NOW);
  assert.doesNotMatch(unknown, /<text class="gname"[^>]*>(?!Review|You|P)[^<]+<\/text>/);
});

test('the key is the three gray steps and nothing else on screen (Dan, 2026-11-12)', () => {
  assert.deepEqual([...FLOW_KEY.matchAll(/<i class="sw a(\d)"><\/i>([^<]+)/g)].map((m) => m[2]), ['under 1 day', '1 to 3 days', 'over 3 days']);
  // What the grays measure is a tooltip and a screen reader's words, not a line of text.
  assert.match(FLOW_KEY, /^<div class="fx-key" title="Time since the last change"><span class="vh">Time since the last change:<\/span>/);
  assert.doesNotMatch(FLOW_KEY, /Width|Click|Hairlines|Gray is/);
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

test('the chart fills the height the page gives it', () => {
  // Zones, dots and lines run the full height; the river and its names carry what the page needs to stretch them.
  const svg = drawFlow(layout(LINE, NOW), NOW);
  assert.match(svg, /<rect class="zone z0" x="0" y="0" width="262" height="100%"\/>/);
  assert.match(svg, /<line class="zline"[^>]*y2="100%"\/>/);
  assert.match(svg, /<g class="fx-body" data-top="58" data-span="[\d.]+"><g class="bands">/);
  assert.match(svg, /<\/g><g class="fx-names"><text class="gname"[^>]*data-y="[\d.]+"/);
});

const left0 = (L: ReturnType<typeof layout>): (readonly [number, number])[] =>
  (L.drill === null ? L.groups.map((g) => [g.y, g.y + g.h] as const) : L.bands.map((b) => [b.lane!, b.lane! + b.h] as const));
test('given the room the page has, the river spreads to fill it with matching margins, and closes up left to right', () => {
  // Dan, 2026-11-12: the threads on the left should use the height, branching out, never edge to edge.
  for (const fitH of [400, 760, 1400]) {
    for (const drill of [null, 'Fernpay'] as const) {
      const L = layout(LINE, NOW, drill, fitH);
      assert.ok(Math.abs(L.H - fitH) < 0.5, `H ${L.H} for ${fitH}`);
      const left = drill === null ? L.groups.map((g) => [g.y, g.y + g.h] as const) : L.bands.map((b) => [b.lane!, b.lane! + b.h] as const);
      const top = Math.min(...left.map((r) => r[0])), bottom = Math.max(...left.map((r) => r[1]));
      // A margin above and below, the same both ways (within the stage names' band at the top), never zero.
      assert.ok(top >= 58 && bottom <= L.H - 18, `${top}..${bottom} in ${L.H}`);
      if (top > 58) assert.ok(Math.abs(top - (L.H - bottom)) < 1, `margins ${top} and ${L.H - bottom}`);
      assert.ok(L.H - bottom >= 20);
      // Threads grow, but to a cap; the rest is space between projects (or, opened, threads, to a cap: their lanes fan into one node).
      const u = L.bands[0]!.h / L.bands[0]!.items.length;
      assert.ok(u <= (drill === null ? 30 : 24) && u >= (drill === null ? 3 : 11));
      // Separation closes left to right (Dan, 2026-11-12): the widest space between neighbours (opened: threads; else
      // projects) shrinks at each stop, and the branch holds them touching.
      // Stops that hold one band have no space to measure, so they drop out.
      const widest = (ys: (readonly [number, number])[]) => { const r = [...ys].sort((a, b) => a[0] - b[0]); return r.length < 2 ? null : Math.max(0, ...r.slice(1).map((v, i) => v[0] - r[i]![1])); };
      const at = (s: 'review' | 'you' | 'main') => widest(L.bands.filter((b) => b.path.includes(s)).map((b) => [b.yIn[s]!, b.yIn[s]! + b.h] as const));
      const main = at('main');
      const steps = [widest(left0(L)), ...(drill === null ? [] : [widest(L.bands.map((b) => [b.y0, b.y0 + b.h] as const))]), at('review'), at('you')]
        .filter((v): v is number => v !== null);
      assert.ok(steps.length >= 2);
      for (let i = 1; i < steps.length; i++) assert.ok(steps[i]! < steps[i - 1]! && steps[i]! > 0, `${drill} ${fitH}: ${steps.join(' > ')}`);
      if (main !== null) assert.equal(main, 0);
    }
  }
  // More room, a wider spread at the left: it never sits at one size in a tall column.
  const spread = (fitH: number) => { const g = layout(LINE, NOW, null, fitH).groups; return g[g.length - 1]!.y + g[g.length - 1]!.h - g[0]!.y; };
  assert.ok(spread(400) < spread(760) && spread(760) < spread(1400), `${spread(400)} ${spread(760)} ${spread(1400)}`);
  // Without a size, the chart keeps its own (tests above and the first paint).
  assert.equal(layout(LINE, NOW).span, 200);
});

test('the page says its chart size as fx=WxH; anything else draws the chart at its own size', () => {
  assert.deepEqual(fitFrom(new URLSearchParams('fx=842x760')), { w: 842, h: 760 });
  for (const bad of ['', 'fx=', 'fx=842', 'fx=12x760', 'fx=842x99999', 'fx=842x760x1', 'fx=-842x760', 'fx=842.5x760']) assert.equal(fitFrom(new URLSearchParams(bad)), null, bad);
  const html = youFlow(LINE, NOW, { w: 842, h: 760 });
  assert.match(html, /^<div class="fx-view"><svg class="fx" data-fit="842x760" viewBox="0 0 860 ([\d.]+)"/);
  assert.ok(Math.abs(Number(/viewBox="0 0 860 ([\d.]+)"/.exec(html)![1]) - (760 * W) / 842) < 0.1);
  assert.doesNotMatch(youFlow(LINE, NOW), /data-fit/);
  // The key rides in the chart's corner, after the chart.
  assert.ok(html.endsWith(FLOW_KEY));
});
