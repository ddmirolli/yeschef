import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, themeOf, nextTheme, onTheme, rootTokens, miniCss, minis, MINI_CSS, MINI_TOKENS } from './theme.ts';
import { BAR_CSS } from './bar.ts';

const TAIL = ':root:where([data-theme=light]){color-scheme:light}:root:where([data-theme=dark]){color-scheme:dark}';

test('Appearance cycles System, Light, Dark, as T3 Code does; anything else reads as System', () => {
  assert.deepEqual(THEMES, ['system', 'light', 'dark']);
  assert.equal(nextTheme('system'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'system');
  assert.equal(themeOf(null), 'system');
  assert.equal(themeOf('sepia'), 'system');
  assert.equal(nextTheme(undefined), 'light');
});

test('each color-scheme block is written for System and for the chosen theme', () => {
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

test('the real sheets: pass.css tokens and the bar each come out with every block written twice', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pass = readFileSync(join(here, 'pass.css'), 'utf8');
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

test('the pictures read the page\'s tokens as the page does: every :root in order, scheme blocks for their theme only', () => {
  const sheet = ':root{--bg:#EEE;--card:#FFF;--x:var(--card)}/* :root{--bg:red} */'
    + '@media (prefers-color-scheme:dark){:root{--bg:#111;--card:#222}}'
    + '@media (max-width:760px){:root{--bg:pink}}'
    + ':root{--bg:#FFF;--card:#F2F2F7}@media (prefers-color-scheme:dark){:root{--bg:#1C1C1E}}';
  const t = rootTokens(sheet);
  assert.equal(t.light.bg, '#FFF', 'a later :root wins, as in the cascade');
  assert.equal(t.light.card, '#F2F2F7');
  assert.equal(t.light.x, '#F2F2F7', 'var() resolves to the final value');
  assert.equal(t.dark.bg, '#1C1C1E', 'a later dark block wins in dark');
  assert.equal(t.dark.card, '#F2F2F7', 'a plain :root after the dark block wins in dark too');
  assert.ok(!Object.values(t.light).includes('red'), 'comments are skipped');
  assert.ok(!Object.values(t.light).includes('pink') && !Object.values(t.dark).includes('pink'), 'a width query is not a theme');
});

test('the pictures need every token they draw with, and stop the build when one is missing', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pass = readFileSync(join(here, 'pass.css'), 'utf8');
  assert.throws(() => miniCss(pass), /no --st-merged for light/, 'the stage colors live in the prototype, not in pass.css');
  const all = MINI_TOKENS.map((k) => `--${k}:#${k.length}`).join(';');
  const css = miniCss(`:root{${all}}@media (prefers-color-scheme:dark){:root{--bg:#000}}`);
  assert.match(css, /^\.mt-light\{--m-bg:#2;/);
  assert.match(css, /\.mt-dark\{--m-bg:#000;/);
  for (const k of MINI_TOKENS) assert.ok(css.includes(`--m-${k}:`), k);
  // Every --m- color the pictures draw with is one miniCss writes, or one the pictures make from those.
  const made = new Set(['m-page', 'm-panel', ...MINI_TOKENS.map((k) => 'm-' + k)]);
  for (const [, k = ''] of MINI_CSS.matchAll(/var\(--(m-[\w-]+)\)/g)) assert.ok(made.has(k), '--' + k + ' has a source');
});

test('six pictures: System is light and dark halves, each is decoration only, and none can end the page script', () => {
  const m = minis();
  assert.deepEqual(Object.keys(m), ['system', 'light', 'dark', 'default', 'comfortable', 'compact']);
  assert.match(m.system, /class="hv mt-light">[\s\S]*class="hv mt-dark hv-half">/);
  assert.match(m.light, /class="hv mt-light"/); assert.doesNotMatch(m.light, /mt-dark/);
  assert.match(m.dark, /class="hv mt-dark"/); assert.doesNotMatch(m.dark, /mt-light/);
  for (const [k, h] of Object.entries(m)) {
    assert.match(h, /^<i class="mini[ "][^>]*aria-hidden="true">/, k);
    assert.doesNotMatch(h, /<\/script|`|\$\{|\\/, k);
  }
  const rows = (h: string) => (h.match(/class="hv-tk/g) || []).length;
  assert.ok(rows(m.compact) > rows(m.comfortable) && rows(m.comfortable) > rows(m.default), 'denser shows more tickets');
  assert.doesNotMatch(m.compact, /hv-l2|hv-chips/, 'Compact is titles only');
});
