import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, themeOf, nextTheme, onTheme } from './theme.mjs';
import { BAR_CSS } from './bar.mjs';

const TAIL = ':root:where([data-theme=light]){color-scheme:light}:root:where([data-theme=dark]){color-scheme:dark}';

test('Appearance cycles Match system, Light, Dark, as T3 Code does; anything else reads as Match system', () => {
  assert.deepEqual(THEMES, ['system', 'light', 'dark']);
  assert.equal(nextTheme('system'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'system');
  assert.equal(themeOf(null), 'system');
  assert.equal(themeOf('sepia'), 'system');
  assert.equal(nextTheme(undefined), 'light');
});

test('each color-scheme block is written for Match system and for the chosen theme', () => {
  const out = onTheme('a{color:red}@media (prefers-color-scheme:dark){:root{--bg:#000}.plate,.plate-foot{background:var(--bg)}}b{color:blue}');
  assert.equal(out,
    'a{color:red}'
    + '@media (prefers-color-scheme:dark){:root:where(:not([data-theme])){--bg:#000}.plate:where(:root:not([data-theme]),:root:not([data-theme]) *),.plate-foot:where(:root:not([data-theme]),:root:not([data-theme]) *){background:var(--bg)}}'
    + ':root:where([data-theme=dark]){--bg:#000}.plate:where(:root[data-theme=dark],:root[data-theme=dark] *),.plate-foot:where(:root[data-theme=dark],:root[data-theme=dark] *){background:var(--bg)}'
    + 'b{color:blue}' + TAIL);
});

test('the guard adds no specificity: a selector on the root keeps :root, and a comma inside :is() stays put', () => {
  const out = onTheme('@media (prefers-color-scheme:light){ :root .x:is(.a, .b){--blue:#0052AB} html{color:#000} #bar::backdrop{opacity:1} }');
  assert.match(out, /:root:where\(\[data-theme=light\]\) \.x:is\(\.a, \.b\)\{--blue:#0052AB\}/);
  assert.match(out, /html:where\(\[data-theme=light\]\)\{color:#000\}/);
  assert.match(out, /#bar:where\(:root\[data-theme=light\],:root\[data-theme=light\] \*\)::backdrop\{opacity:1\}/);
  assert.ok(!/:root:where\([^)]*\)[^{]*:root/.test(out), 'never a :root inside a :root');
});

test('a block nested in another media query is rewritten in place', () => {
  const out = onTheme('@media (max-width:760px){.a{x:1}@media (prefers-color-scheme:dark){.a{x:2}}}');
  assert.equal(out, '@media (max-width:760px){.a{x:1}@media (prefers-color-scheme:dark){.a:where(:root:not([data-theme]),:root:not([data-theme]) *){x:2}}.a:where(:root[data-theme=dark],:root[data-theme=dark] *){x:2}}' + TAIL);
});

test('a selector that starts at a class on <html> still matches: the guard is on its first compound, as the root or in it', () => {
  // The page puts its view and density classes on <html>, so .v-kitchen here is the root, not a descendant of it.
  const out = onTheme('@media (prefers-color-scheme:light){ .v-kitchen .head .badge{--blue:#0052AB} .d-compact>.x::after,.y:before{z:1} [data-x="a,b c"] .y{w:1} }');
  assert.match(out, /\.v-kitchen:where\(:root\[data-theme=light\],:root\[data-theme=light\] \*\) \.head \.badge\{--blue:#0052AB\}/);
  assert.match(out, /\.d-compact:where\(:root\[data-theme=light\],:root\[data-theme=light\] \*\)>\.x::after,\.y:where\(:root\[data-theme=light\],:root\[data-theme=light\] \*\):before\{z:1\}/);
  assert.match(out, /\[data-x="a,b c"\]:where\(:root\[data-theme=light\],:root\[data-theme=light\] \*\) \.y\{w:1\}/);
  assert.ok(!/:where\(:root[^)]*\) \.v-kitchen/.test(out), 'never a root class as a descendant of the root');
});

test('what it cannot read fails loudly, never half-themed', () => {
  assert.throws(() => onTheme('@media (prefers-color-scheme:dark){@supports (x:y){.a{b:c}}}'), /nested rule/);
  assert.throws(() => onTheme('@media (prefers-color-scheme:dark) and (hover:none){.a{b:c}}'), /cannot read/);
  assert.throws(() => onTheme('@media (prefers-color-scheme:dark){.a{b:c}'), /closing brace/);
});

test('the real sheets: pass.py tokens and the bar each come out with every block written twice', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pass = readFileSync(join(here, '..', 'pass.py'), 'utf8').match(/CSS = r"""([\s\S]*?)"""/)[1];
  for (const css of [pass, BAR_CSS]) {
    const blocks = (css.match(/prefers-color-scheme/g) || []).length;
    const out = onTheme(css);
    assert.ok(blocks > 0);
    assert.equal((out.match(/prefers-color-scheme/g) || []).length, blocks, 'each media query stays, once');
    assert.equal((out.match(/\[data-theme=(dark|light)\]/g) || []).length > blocks, true);
  }
  const dark = onTheme(pass);
  assert.match(dark, /:root:where\(\[data-theme=dark\]\)\{\s*--bg:#1C1C1E/);
});
