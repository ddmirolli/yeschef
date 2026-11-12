import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phones (Dan, 2026-11-11): the hero shows a screenshot of the app for each view, as t3.codes does, never the live
// demo, and the demo frames do not load there. npm test builds dist first.
const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');

test('each view has a light and a dark webp screenshot of the app next to its live demo', () => {
  for (const view of ['solo', 'team']) {
    const fig = html.match(new RegExp(`<figure class="board demo-fig" data-swap="${view}">[\\s\\S]*?</figure>`))?.[0] ?? '';
    assert.match(fig, /<div class="board-frame demo-frame"><iframe data-src="\/demo\/(app|team)\.html"/);
    const pic = fig.match(/<div class="board-frame demo-shot"><picture>[\s\S]*?<\/picture><\/div>/)?.[0] ?? '';
    assert.match(pic, /<source media="\(prefers-color-scheme: light\)" srcset="[^"]*\.webp 800w, [^"]*\.webp 1200w, [^"]*\.webp 1600w"/);
    assert.match(pic, /<img src="[^"]*\.webp" srcset="[^"]*\.webp 800w[^"]*" sizes="calc\(100vw - 32px\)" alt="[^"]+" width="1440" height="900" loading="lazy"/);
  }
});

test('on a phone the screenshot replaces the live demo and its buttons; elsewhere the demo shows', () => {
  assert.match(css, /^\.demo-shot \{ display: none; \}$/m);
  assert.match(css, /@media \(max-width: 1023px\) \{ \.demo-frame, \.demo-fig figcaption \{ display: none; \} \.demo-shot \{ display: block; \} \}/);
  // After the base .demo-link rule, so it wins (PR-Agent r1 on #47).
  assert.ok(css.indexOf('@media (max-width: 1023px) { .demo-link { display: none; } }') > css.indexOf('.demo-link { align-self'));
  assert.match(readFileSync(new URL('../src/scripts/site.ts', import.meta.url), 'utf8'), /if \(frame && !phone\.matches && !frame\.getAttribute\("src"\)\)/);
});
