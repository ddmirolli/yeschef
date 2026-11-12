// French Brigade, the Your team view's Sankey. Run: vp test run brigade.test.ts, in client/
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { brigadeItems, brigadeLayout, drawBrigade, treeOf } from './brigade.ts';
import type { FbItem, Tree } from './brigade.ts';
import { brigadeView } from './brigade.fixture.ts';
import { fixtureView } from './open-kitchen.fixture.ts';
import { openKitchen } from './open-kitchen.ts';
import type { TeamView } from './open-kitchen.ts';
import { renderApp } from './board.ts';
import { summarize } from './team-summaries.ts';
import { grab, nth, one } from './test/expect.ts';

// A teammate's summary is JSON from another Mac, so the tests write it as untyped JSON.
type Wire = any;
const NOW = Date.UTC(2026, 10, 10, 14, 3);

const setup = (v: Wire = brigadeView(NOW)) => {
  const tree = treeOf(v);
  assert.ok(tree, 'a tree');
  const ok = openKitchen(v, { now: NOW });
  return { v, tree, ok, items: brigadeItems(ok, tree, { plateOf: () => null }) };
};
const item = (items: readonly FbItem[], id: string): FbItem => one(items, (t) => t.id === id, id);
const page = (view: TeamView, who: string | null = null) => renderApp({ board: { tickets: [], runsChecked: false }, link: () => 'x', status: { ok: true, at: NOW, ms: 1 },
  origin: 'https://t3.example', team: { view, now: NOW, mode: 'brigade' }, who });
const fitted = (view: TeamView, who: string | null) => renderApp({ board: { tickets: [], runsChecked: false }, link: () => 'x', status: { ok: true, at: NOW, ms: 1 },
  origin: 'https://t3.example', team: { view, now: NOW, mode: 'brigade' }, who, fit: { w: 860, h: 700 } });
/** Where a band sits at a node. */
const b0 = (b: { y: Record<string, number>; y0: number }, key: string): number => b.y[key] ?? b.y0;
/** The data-k keys of each band, as hover reads them. */
const bandKeys = (svg: string): string[][] => [...svg.matchAll(/<path class="band[^"]*" data-k="([^"]*)"/g)].map((m) => nth(m, 1).split(' '));

test('the ladder comes from the roster: ancestors nearest first, a flat team under its lead', () => {
  const { tree } = setup();
  assert.deepEqual(tree.up('jon'), ['priya', 'kai', 'me']);
  assert.deepEqual(tree.up('kai'), ['me']);
  assert.deepEqual(tree.up('me'), []);
  assert.equal(tree.login('jon'), 'jon-acme');
  const flat = treeOf(fixtureView(NOW) as Wire);
  assert.ok(flat);
  assert.deepEqual(flat.up('jon'), ['me'], 'no under on anyone: everyone sits directly under the lead');
});

test('a roster whose every lead is unknown is not flat: each line ends there', () => {
  const v: Wire = brigadeView(NOW);
  for (const p of v.people) if (p.under) p.under = 'ghost';
  assert.deepEqual(treeOf(v)?.up('jon'), []);
});

test('a loop or an unknown lead in the roster ends the line, never hangs', () => {
  const v: Wire = brigadeView(NOW);
  for (const p of v.people) if (p.id === 'kai') p.under = 'jon';
  for (const p of v.people) if (p.id === 'maya') p.under = 'nobody';
  const tree = treeOf(v);
  assert.ok(tree);
  assert.deepEqual(tree.up('jon'), ['priya', 'kai']);
  assert.deepEqual(tree.up('maya'), []);
});

test('a login that is not GitHub\'s reads as not checked', () => {
  const v: Wire = brigadeView(NOW);
  for (const p of v.people) if (p.id === 'kai') p.summary.gh = 'not a login';
  assert.equal(treeOf(v)?.login('kai'), null);
});

test('the chart takes only threads below you, in the four stages, in the picked projects', () => {
  const { ok, tree, items } = setup();
  assert.ok(items.length > 0);
  assert.ok(items.every((t) => tree.up(t.author).includes('me')));
  assert.ok(items.every((t) => ['In progress', 'In review', 'Ready to merge', 'Merged'].includes(t.stage)));
  const quillo = brigadeItems(ok, tree, { want: new Set(['Quillo']), plateOf: () => null });
  assert.ok(quillo.length > 0 && quillo.every((t) => t.project === 'Quillo'));
});

test('two tiers below you show by name; deeper tiers fold into the person two levels down', () => {
  const { tree, items } = setup();
  const L = brigadeLayout(items, tree, NOW);
  const label = (k: string) => one(L.groups, (g) => g.key === k, k).label;
  assert.equal(label('p:kai'), 'Kai');
  assert.equal(label('p:priya'), 'Priya');
  assert.equal(label('f:priya'), "Priya's team");
  assert.equal(label('f:sam'), "Sam's team");
  assert.ok(!L.groups.some((g) => g.key === 'p:jon'), 'Jon is three tiers down: inside Priya\'s team');
});

test('ready to merge runs up every signer to the one who merges; the top of the roster merges on a flat team', () => {
  const { tree, items } = setup();
  const L = brigadeLayout(items, tree, NOW);
  const band = (id: string) => one(L.bands, (b) => b.items.some((t) => t.id === id), id);
  assert.deepEqual(band('mcp:jon-2').stops, ['n:priya', 'n:kai'], 'Jon: Priya signs off, Kai (under you) merges');
  assert.deepEqual(band('mcp:sam-2').stops, ['n:maya'], 'Sam: no one signs off below Maya, who merges (directly under the top)');
  const merge = one(L.nodes, (d) => d.key === 'n:kai' && d.merge, 'Kai as merger');
  assert.ok(L.nodes.filter((d) => !d.merge).every((d) => d.x < merge.x), 'sign-off columns sit left of the merge column');

  const flat = setup(fixtureView(NOW));
  const FL = brigadeLayout(flat.items, flat.tree, NOW);
  assert.ok(FL.bands.filter((b) => b.stage === 'Ready to merge' || b.stage === 'Merged').every((b) => b.stops.join() === 'n:me'), 'flat: the lead merges, no sign-offs');
});

test('in review passes a lead only on their read approval, and waits at the first lead whose approval is not read', () => {
  const v: Wire = brigadeView(NOW);
  const { tree, items } = setup(v);
  const L = brigadeLayout(items, tree, NOW);
  const band = (id: string) => one(L.bands, (b) => b.items.some((t) => t.id === id), id);
  const iris = nth(item(items, 'mcp:iris-1').prs);
  assert.ok(iris.reviewers?.some((r) => r.who === 'sam-acme' && r.state === 'approved'));
  assert.deepEqual(band('mcp:iris-1').stops, ['n:sam']);
  assert.equal(band('mcp:iris-1').signed, true, 'Sam approved: past every signer');
  assert.equal(band('mcp:elena-2').signed, false, 'reviewers not read: waits at Sam');

  // The same approval from a login no teammate sends: not Sam's, so the thread waits at Sam.
  for (const p of v.people) if (p.id === 'sam') p.summary.gh = 'someone-else';
  const again = setup(v);
  const L2 = brigadeLayout(again.items, again.tree, NOW);
  assert.equal(one(L2.bands, (b) => b.items.some((t) => t.id === 'mcp:iris-1')).signed, false);
});

test('a lead\'s approval passes a thread only when it is on every open PR of the thread', () => {
  const v: Wire = brigadeView(NOW);
  const iris = v.people.find((p: Wire) => p.id === 'iris').summary.tickets[0];
  iris.prs.push({ ...iris.prs[0], n: 450, url: 'https://github.com/acme/quillo/pull/450', reviewers: null });
  const { tree, items } = setup(v);
  const band = one(brigadeLayout(items, tree, NOW).bands, (b) => b.items.some((t) => t.id === 'mcp:iris-1'));
  assert.equal(band.signed, false, 'the second PR\'s reviews are not read');
  const svg = drawBrigade(items, tree, NOW, { drill: 'f:sam' });
  assert.match(svg, /Approved: Sam · Reviews on #450 not checked/);
});

test('no node or band falls below the chart, from any lead\'s seat and at any height the page gives', () => {
  for (const me of ['me', 'kai', 'maya', 'priya', 'sam']) {
    const v: Wire = brigadeView(NOW);
    const p = one<Wire>(v.people, (x: Wire) => x.id === me);
    v.me = { ...v.me, id: me, name: p.name };
    // Two people under one lead, each with work waiting there and work merged past it (PR-Agent r2 on #56).
    for (const x of v.people) if (x.summary && x.under === me) x.summary.tickets.push(
      { thread: `mcp:${x.id}-r`, title: 'Waits', project: 'Quillo', place: 'In review', atPass: false, working: 1, asks: 0, call: false, updatedAt: new Date(NOW - 60000).toISOString(), prs: [] },
      { thread: `mcp:${x.id}-m`, title: 'Merged', project: 'Quillo', place: 'Merged', atPass: false, working: 0, asks: 0, call: false, updatedAt: new Date(NOW - 60000).toISOString(), prs: [] });
    const { tree, items } = setup(v);
    for (const fitH of [undefined, 300, 700, 1600]) for (const drill of [null, ...new Set(items.map((t) => `p:${t.author}`))]) {
      const L = brigadeLayout(items, tree, NOW, drill, fitH);
      for (const d of L.nodes) if (d.h) assert.ok(d.y + d.h <= L.H + 1e-6, `${me} ${fitH} ${drill}: ${d.key} ends at ${d.y + d.h} past ${L.H}`);
      for (const b of L.bands) for (const y of [b.y0, ...Object.values(b.y)]) assert.ok(y >= 0 && y + b.h <= L.H + 1e-6, `${me} ${fitH} ${drill}: band ${b.id}`);
      // Room to spare: exactly the height the page gave, never taller (PR-Agent r3 on #56).
      if (fitH === 1600) assert.ok(L.H <= 1600 + 1e-6, `${me} ${drill}: ${L.H} high for 1600`);
    }
  }
});

test('a band of several threads shows each one, as You\'s does', () => {
  const { tree, items } = setup();
  const L = brigadeLayout(items, tree, NOW);
  const want = L.bands.reduce((s, b) => s + Math.max(0, b.items.length - 1), 0);
  assert.ok(want > 0);
  assert.equal(drawBrigade(items, tree, NOW).match(/<path class="strand"/g)?.length ?? 0, want);
});

test('twenty threads for every dev still fit the space the page gives, opened or not (Dan\'s scale check, 2026-11-12)', () => {
  const v: Wire = brigadeView(NOW);
  const places = ['In progress', 'In review', 'Ready to merge', 'Merged'];
  for (const p of v.people) if (p.summary) p.summary.tickets = Array.from({ length: 20 }, (_, i) => ({ thread: `mcp:${p.id}-s${i}`, title: `t${i}`, project: 'Quillo',
    place: places[i % 4], atPass: false, working: 0, asks: 0, call: false, updatedAt: new Date(NOW - (i * 397 + 30) * 60000).toISOString(),
    prs: i % 4 ? [{ repo: 'acme/quillo', n: 900 + i, state: i % 4 === 3 ? 'merged' : 'open', url: null, base: 'main', draft: false, mergedAt: null, size: null, checks: null, reviewers: [] }] : [] }));
  const { tree, items } = setup(v);
  assert.ok(items.length >= 14 * 20);
  for (const fitH of [500, 700, 900]) for (const drill of [null, 'f:priya', 'f:sam', 'p:kai', 'p:jon']) {
    const L = brigadeLayout(items, tree, NOW, drill, fitH);
    assert.ok(L.H <= fitH + 1e-6, `${drill} at ${fitH}: ${L.H} high`);
  }
});

test('a PR whose reviewers were not read says so in its tooltip', () => {
  const { tree, items } = setup();
  const svg = drawBrigade(items, tree, NOW, { drill: 'f:sam' });
  const tips = [...svg.matchAll(/data-tip="([^"]*)"/g)].map((m) => nth(m, 1));
  assert.ok(tips.some((t) => t.includes('Banner copy') && t.includes('Reviews not checked')));
  assert.ok(tips.some((t) => t.includes('Approved: Sam')), 'a teammate\'s login reads as their name');
});

test('hover keys: each band carries its group and every node on its path; each name carries its group', () => {
  const { tree, items } = setup();
  const svg = drawBrigade(items, tree, NOW);
  const keys = bandKeys(svg);
  assert.ok(keys.length > 0);
  assert.ok(keys.every((k) => k.some((x) => x.startsWith('fb:')) && k.some((x) => x.startsWith('g:'))));
  assert.ok(keys.some((k) => k.includes('g:f:priya') && k.includes('n:priya') && k.includes('n:kai')));
  assert.match(svg, /<text class="rowname fbg"[^>]*data-k="g:f:priya[^"]*"[^>]*data-who="f:priya"/);
  assert.equal(grab(svg, /<text class="zlbl" x="\d+" y="19">Staging<\/text><text class="zcount"[^>]*>([^<]*)</, 1), 'not checked');
});

test('?who opens a folded team as its people, and a person as their threads one band each; an unknown key shows everyone', () => {
  const v = brigadeView(NOW);
  const { items } = setup(v);
  const team = page(v, 'f:priya');
  assert.match(team, /data-unwho/);
  assert.match(team, /Priya&#39;s team|Priya's team/);
  const tsvg = grab(team, /<svg class="fx okr fbr"[\s\S]*?<\/svg>/);
  for (const id of ['jon', 'ada', 'omar', 'ben']) assert.match(tsvg, new RegExp(`data-who="p:${id}"`), `${id} opens from their team`);
  assert.doesNotMatch(tsvg, /data-who="f:/, 'a team opens into people, not teams');

  const jon = page(v, 'p:jon');
  assert.match(jon, /data-unwho/, 'Jon, reached from Priya\'s team, opens');
  const jsvg = grab(jon, /<svg class="fx okr fbr[^"]*"[\s\S]*?<\/svg>/);
  assert.doesNotMatch(jsvg, /data-who=/, 'a person opened: no further drill');
  assert.equal(bandKeys(jsvg).length, items.filter((t) => t.author === 'jon').length, 'one band per thread');

  for (const k of ['f:nobody', 'p:nobody', 'p:me']) {
    const none = page(v, k);
    assert.doesNotMatch(none, /data-unwho/, k);
    assert.match(none, /data-who="f:priya"/, k);
  }
});

test('opened, the header names who, and a person\'s threads pack into one bundle, a hairline apart (Dan, 2026-11-12)', () => {
  const v = brigadeView(NOW);
  const { tree, items } = setup(v);
  const head = (h: string) => grab(h, /<section class="tboard"[^>]*><header class="you-h">[\s\S]*?<\/header>/);
  assert.doesNotMatch(head(page(v)), /you-who/, 'everyone: no name');
  assert.match(head(page(v, 'f:priya')), /data-unwho[^]*<\/button><span class="you-who" aria-hidden="true">Priya&#39;s team<\/span>/);
  const jon = fitted(v, 'p:jon');
  assert.match(head(jon), /<span class="you-who" aria-hidden="true">Jon<\/span><\/header>/);
  // "Detailed threads with texture rather than the linguini": no gap between two threads, at the left or at any node.
  const mine = items.filter((t) => t.author === 'jon');
  for (const fitH of [undefined, 500, 900]) {
    const L = brigadeLayout(items, tree, NOW, 'p:jon', fitH);
    assert.equal(L.bands.length, mine.length, 'one band per thread');
    assert.equal(new Set(L.bands.map((b) => b.group)).size, 1, 'one bundle');
    const left = [...L.bands].sort((a, z) => a.y0 - z.y0);
    left.forEach((b, i) => { if (i) assert.ok(Math.abs(b.y0 - (left[i - 1]!.y0 + left[i - 1]!.h)) < 1e-6, `${fitH}: thread ${b.id} touches the one above`); });
    for (const d of L.nodes) {
      const at = L.bands.filter((b) => b.stops.includes(d.key)).sort((a, z) => b0(a, d.key) - b0(z, d.key));
      at.forEach((b, i) => { if (i) assert.ok(Math.abs(b0(b, d.key) - (b0(at[i - 1]!, d.key) + at[i - 1]!.h)) < 1e-6, `${fitH}: at ${d.label}`); });
    }
  }
  // The line between two threads is the full chart's 1 px hairline, and no thread carries a title.
  const jsvg = grab(jon, /<svg class="fx okr fbr fb-one"[\s\S]*?<\/svg>/);
  assert.doesNotMatch(jsvg, /<text class="ttl|clipPath/);
  assert.doesNotMatch(grab(fitted(v, null), /<svg class="fx okr fbr"[\s\S]*?<\/svg>/), /fb-one/);
});

test('every signer\'s name sits on a chip, so a crossing band never runs through it (Dan, 5A, 2026-11-12)', () => {
  const { tree, items } = setup();
  const svg = drawBrigade(items, tree, NOW);
  const gs = [...svg.matchAll(/<g class="fbn r-([a-z]+)"[^>]*>([\s\S]*?)<\/g>/g)];
  assert.ok(gs.some((m) => m[1] !== 'above'), 'a signer');
  for (const m of gs) assert.match(nth(m, 2), /^<rect [^>]*\/><text /, `${m[1]}: a chip, then the name`);
});

test('French Brigade says not checked while the team link is down, and nothing in flight when no one below you has work', () => {
  const down: Wire = brigadeView(NOW);
  down.link = 'offline';
  assert.match(page(down), /<b>Not checked<\/b>/);
  const idle: Wire = brigadeView(NOW);
  for (const p of idle.people) if (p.summary) p.summary.tickets = [];
  assert.match(page(idle), /<b>Nothing in flight<\/b>/);
  const lee = one<Wire>(idle.people, (p: Wire) => p.id === 'lee');
  lee.summary = null;
  assert.match(page(idle), /<b>Not checked<\/b> 1 teammate is not reporting/, 'Lee has sent nothing: no threads is not nothing in flight');
});

test('the summary sends this Mac\'s GitHub login, or null when it was not read', () => {
  const board = { tickets: [] };
  assert.equal(summarize(board, [], 65536, { login: () => 'dana-acme', now: NOW }).gh, 'dana-acme');
  assert.equal(summarize(board, [], 65536, { login: () => 'not a login', now: NOW }).gh, null);
  assert.equal(summarize(board, [], 65536, { login: () => { throw new Error('gh down'); }, now: NOW }).gh, null);
  assert.equal(summarize(board, [], 65536, { now: NOW }).gh, null);
});
