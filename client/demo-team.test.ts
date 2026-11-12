// The site demo's made-up team (client/demo-team.ts): the real shapes, the intended calls and nothing else, and both
// modes drawn by the real app.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { demoTeam } from './demo-team.ts';
import { openKitchen } from './open-kitchen.ts';
import { brigadeItems, treeOf } from './brigade.ts';
import { renderApp } from './board.ts';
import type { summarize } from './team-summaries.ts';
import type { View } from './team.ts';

const NOW = Date.UTC(2026, 10, 12, 15, 0);

test('the demo team has the shapes a Mac really sends and the board really reads (the typecheck holds this)', () => {
  // These assignments are the check: when summarize() or Team.view() changes shape, client typecheck fails here.
  const view: View = demoTeam(NOW);
  for (const p of demoTeam(NOW).people) {
    const sent: (ReturnType<typeof summarize> & { at: number }) | null = p.summary;
    if (p.id !== 'me') assert.ok(sent && sent.tickets.length > 0, p.id);
  }
  assert.equal(view.people.length, 15);
});

test('the demo team raises the seven calls it is written for, and its calm threads raise none', () => {
  const ok = openKitchen(demoTeam(NOW), { now: NOW });
  assert.equal(ok.status, 'live');
  const all = [...ok.pass, ...ok.held].map((c) => `${c.kind}:${c.thread}`).sort();
  assert.deepEqual(all, ['big:mcp:iris-1', 'failing:mcp:ben-1', 'failing:mcp:nina-1', 'main:mcp:ravi-1', 'overlap:mcp:jon-1', 'stuck:mcp:omar-1', 'waiting:mcp:lee-1']);
  assert.deepEqual(ok.people.filter((p) => p.reporting === false).map((p) => p.id), ['lee']);
});

test('the demo team never ages: the same calls at any time of day', () => {
  for (const at of [NOW, NOW + 7 * 3600000, Date.UTC(2027, 0, 1, 3, 30)]) {
    const ok = openKitchen(demoTeam(at), { now: at });
    assert.equal(ok.pass.length + ok.held.length, 7, String(at));
  }
});

test('French Brigade reads the demo team as a ladder three tiers deep, with every thread on its chart', () => {
  const v = demoTeam(NOW), tree = treeOf(v);
  assert.ok(tree);
  const items = brigadeItems(openKitchen(v, { now: NOW }), tree, { plateOf: () => null });
  const authors = new Set(items.map((t) => t.author));
  for (const id of ['kai', 'maya', 'priya', 'jon', 'iris', 'ravi']) assert.ok(authors.has(id), id);
  assert.ok(items.length >= 60, String(items.length));
});

test('the app draws the demo team in both modes, collapsed and expanded', () => {
  const page = (mode: 'open' | 'brigade') => renderApp({ board: { tickets: [], runsChecked: false }, link: () => 'x', status: { ok: true, at: NOW, ms: 1 },
    origin: 'https://t3.example', team: { view: demoTeam(NOW), now: NOW, mode } });
  const open = page('open'), brigade = page('brigade');
  for (const word of ['Main broken', 'Overlap', 'Failing', 'Too big', 'Stuck', 'Waiting']) assert.match(open, new RegExp(word), word);
  assert.match(open, /class="[^"]*ok-p/);
  assert.match(brigade, /<section class="tboard"[^]*<div class="fx-wrap">/);
  assert.doesNotMatch(brigade, /ok-p/);
  assert.match(brigade, /"mode":"brigade"/);
});
