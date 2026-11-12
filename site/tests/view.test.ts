import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialView } from '../src/scripts/initial-view.ts';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');

test('a new visit opens on team and an explicit solo link still works', () => {
  for (const search of ['', '?view=nonsense', '?view=team']) assert.equal(initialView(search), 'team');
  assert.equal(initialView('?view=solo'), 'solo');
});

test('the built page sets the view in its head before the body paints', () => {
  const head = html.split('</head>')[0];
  assert.match(head, /<script>[\s\S]*setAttribute\("data-view"/);
  assert.doesNotMatch(head, /localStorage/);
});

test('the download CTA keeps its label and has no requirements line', () => {
  assert.doesNotMatch(html, /dl-meta|Needs T3 Code on the same Mac/);
  assert.match(html, /<span>Download for Mac<\/span><\/a>\s*<a class="hero-source"/);
});

test('the modes section is one frame with a toggle, a picture of each mode that opens larger, and no unbuilt promise (Dan, 1C, 2026-11-12)', () => {
  const modes = html.slice(html.indexOf('<section id="modes"'), html.indexOf('<section id="problem"'));
  assert.doesNotMatch(modes, /Choose what waits for your Go|Plating|sous chef|mode-card/);
  assert.match(modes, /<div class="modes" data-swap="team" data-mode="open">/);
  assert.match(modes, /data-mode-pick="open" aria-pressed="true"[^]*data-mode-pick="brigade" aria-pressed="false"/);
  assert.match(modes, /<div class="mode-pane" data-pane="brigade" inert>/);
  assert.equal(modes.match(/<button type="button" class="mode-shot" data-zoom/g)?.length, 2);
  for (const m of ['open', 'brigade']) assert.match(modes, new RegExp(`data-demo-mode="${m}"`));
  assert.match(html, /<dialog class="zoom"/);
});
