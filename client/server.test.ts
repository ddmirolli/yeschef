// The web prototype carries nobody's addresses: it refuses to start without them.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { keysCore } from './keys.ts';
import { grab, nth } from './test/expect.ts';
import { servedSource } from './test/served.ts';

const SERVER = fileURLToPath(new URL('./server.ts', import.meta.url));
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BRIGADE_|YESCHEF_)/.test(k)));
const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [SERVER, ...args], { env: { ...clean, ...env }, encoding: 'utf8', timeout: 10000 });

test('with no T3 origin, page address or allow list, it names all three and stops', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the T3 origin \(first argument\), BRIGADE_PASS_ORIGIN, BRIGADE_ALLOW/);
  assert.equal(r.stdout, '');
});

test('a T3 origin alone is not enough for the web prototype', () => {
  const r = run(['http://127.0.0.1:1']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs BRIGADE_PASS_ORIGIN, BRIGADE_ALLOW\./);
});

test('YESCHEF_DESKTOP without the app\'s pipe is still the web prototype', () => {
  const r = run(['http://127.0.0.1:1'], { YESCHEF_DESKTOP: '1', BRIGADE_ALLOW: '/nonexistent/allow' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs BRIGADE_PASS_ORIGIN\./);
});

test('no phone build: at phone width the page is one screen that points to the Mac app or a computer (Dan, 2026-11-11)', () => {
  const src = servedSource();
  assert.match(src, /<body class="pass-app"><section class="only-phone" aria-labelledby="op-t"><span class="op-logo"><svg [^>]*aria-hidden="true">\$\{ICON\.cloche\}<\/svg><\/span><h1 id="op-t">Yes Chef runs on your Mac<\/h1><a class="btn fill" href="https:\/\/yeschef\.codes\/download" target="_top" rel="noopener">Get the Mac app<\/a><p>Or open this page on a computer\.<\/p><\/section><main id="app">\$\{body\}<\/main>/);
  assert.match(src, /^\.only-phone\{display:none\}$/m);
  assert.match(src, /@media \(max-width:760px\)\{\n {2}body\.pass-app>:not\(\.only-phone\)\{display:none!important\}\n {2}\.only-phone\{display:flex;/);
  // That block is the only phone rule left: no phone layout, and the page script has no phone branch.
  assert.equal(src.match(/@media \(max-width:(760|600|560)px\)/g)?.length, 1);
  assert.doesNotMatch(src, /wideQ|min-width: 761px'\)/);
  // Narrowing to it closes any open dialog, so the page under it is not left inert (PR-Agent r1 on #47).
  assert.match(src, /phoneQ\.addEventListener\('change', function\(\)\{ if \(phoneQ\.matches\) \$\$\s*\('dialog\[open\]'\)\.forEach\(function\(d\)\{ d\.close\(\); \}\); \}\);/);
  // The Mac app's window stays wider than that.
  assert.match(readFileSync(new URL('../desktop/main.ts', import.meta.url), 'utf8'), /new BrowserWindow\(\{ width: 1440, height: 900, minWidth: 960,/);
});

test('Settings has no Ticket layout: every ticket uses the bar, and a stored "side" is never read (Dan, 2026-11-10)', () => {
  const src = servedSource();
  assert.doesNotMatch(src, /Ticket layout|name="layout"|Side panel<|pv-side|a-side|a-bottom/);
  assert.doesNotMatch(src, /getItem\('yc\.layout2'\)|store\('yc\.layout2'/);
  // Density stays, and Shortcuts lists every command in client/keys.ts, More's key among them.
  assert.match(src, /<legend>Density<\/legend>/);
  assert.match(src, /<div id="kx-list"><\/div>/);
  assert.deepEqual(keysCore(true).CMD['ticket.more']?.keys, ['.']);
  // The bar's CSS: the blue action fills, and the menu is a popover.
  assert.match(src, /\.abar \.ab\.fill\{background:var\(--accent\);color:#fff\}/);
  assert.match(src, /\.abar \.menu:popover-open\{display:flex/);
});

test('a narrow ticket in a wide window never clips the bar: it steps down by the ticket\'s own width (PR-Agent r1 on #72)', () => {
  const src = servedSource();
  const block = src.slice(src.indexOf('@media (min-width:761px){\n  @container (max-width:560px){'));
  assert.ok(block.length < src.length, 'the fallback sits in a wide-window media query, so the phone bar keeps its words');
  // Changes and Reply keep only their icons; the word stays the button's name for screen readers, never display:none.
  assert.match(block, /@container \(max-width:560px\)\{\s*\.abar \.ab:not\(\.primary\)\{width:36px;padding:0\}\s*\.abar \.ab:not\(\.primary\) \.bl\{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset\(50%\)/);
  // Hold and Settle move into More, then the row wraps.
  assert.match(block, /@container \(max-width:420px\)\{\s*\.abar \.ib:not\(\.more-b\),\.abar \.vr\{display:none\}\s*\.abar \.mi\.ph\{display:flex\}/);
  assert.match(block, /@container \(max-width:300px\)\{ \.abar\{flex-wrap:wrap;row-gap:6px\} \}/);
});

test('the blue Send names two picks at most, so it fits a narrow bar (PR-Agent r2 on #72)', () => {
  const src = servedSource();
  assert.match(src, /\(plan\.length > 2 \? 'Send all' : 'Send ' \+ picks\)/);
});

type Node = { outerHTML: string; kids: Record<string, Node[]>; title: string; tagName: string; dataset: Record<string, string>; cls: Set<string>; replaced: number;
  classList: { add(c: string): void; remove(c: string): void }; replaceWith(n: Node): void };

test('a refresh leaves a list alone when it draws the same; a changed one comes in already marked (Dan, 2026-11-10: the app blinked)', () => {
  const src = servedSource();
  // The types are gone and their spaces stay (test/served.ts), hence \s* where a typed line had them.
  const block = grab(src, / {2}var drawn\s*= \{\};\n[\s\S]*?\n {2}function swap\(sel\s*, fresh\s*, keepScroll\s*\)\s*\{[\s\S]*?\n {2}\}/);
  const node = (html: string, kids: Record<string, Node[]> = {}): Node => {
    const cls = new Set<string>();
    return { outerHTML: html, kids, title: '', tagName: 'SECTION', dataset: {}, cls, replaced: 0,
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) }, replaceWith(n) { this.replaced++; ctx.onScreen = n; } };
  };
  const timers: (() => void)[] = [];
  const ctx = vm.createContext({ onScreen: null as Node | null, nu: null as Node | null, state: { sel: 'p1' }, acted: {}, app: {}, CSS: { escape: (s: string) => s },
    setTimeout: (f: () => void) => timers.push(f), $: () => ctx.onScreen, $$: (sel: string, root?: Node) => (root && root.kids[sel]) || [] });
  vm.runInContext(block, ctx);
  const draw = (sel: string, n: Node) => vm.runInContext(`swap(${JSON.stringify(sel)}, { querySelector: () => nu })`, Object.assign(ctx, { nu: n }));
  // The first refresh puts its copy in, with the open ticket's card already selected and its fades held off.
  const old = node('<section class="you">old</section>'), tile = node('<button>');
  ctx.onScreen = old;
  const a = node('<section class="you">A</section>', { '[data-plate="p1"]': [tile] });
  draw('.you', a);
  assert.deepEqual([old.replaced, ctx.onScreen === a, tile.cls.has('sel'), a.cls.has('fresh')], [1, true, true, true]);
  timers.forEach((f) => f());
  assert.equal(a.cls.has('fresh'), false);
  // The same HTML again: nothing is replaced, so nothing blinks.
  draw('.you', node('<section class="you">A</section>'));
  assert.deepEqual([a.replaced, ctx.onScreen === a], [0, true]);
  // A real change comes in.
  const b = node('<section class="you">B</section>');
  draw('.you', b);
  assert.deepEqual([a.replaced, ctx.onScreen === b], [1, true]);
  // The Live lamp's tooltip names each read's time: it changes in place, and the lamp is not redrawn.
  const lamp = (t: string) => { const li = node(''); li.title = t; return node(`<ul class="lamps"><li class="ok" title="${t}"><i></i>Live</li></ul>`, { '.lamps li': [li] }); };
  const first = lamp('Checked 3:00');
  ctx.onScreen = first; draw('.bar .lamps', first);
  draw('.bar .lamps', lamp('Checked 3:05'));
  assert.deepEqual([ctx.onScreen === first, nth(first.kids['.lamps li']).title], [true, 'Checked 3:05']);
  // A lost connection and a project pick change the lists in place, so both forget what was drawn.
  assert.match(src, /net\(false, msg\); app\.classList\.add\('is-stale'\); drawn = \{\};/);
  assert.match(src, /function drawPicked\(names\s*\)\s*\{\n {4}drawn = \{\};/);
  // A refreshed list's cards take their hover with no fade.
  assert.match(src, /^\.fresh \.tile\{transition:none\}$/m);
  // The open ticket is kept while the refresh draws it the same, apart from what every draw makes up anew; never while
  // a send from it is in flight or not confirmed, and a kept one takes the new one-time ids.
  const key = vm.runInContext(`${grab(src, /function plateKey\(html\s*\)\s*\{[^\n]*\}/)} plateKey`, vm.createContext({})) as (html: string) => string;
  const plate = (nonce: string, menu: string, body: string) => `<article class="plate"><form><input type="hidden" name="nonce" value="${nonce}">${body}</form><button popovertarget="m-${menu}"></button><div id="m-${menu}" popover></div></article>`;
  const u1 = '0b6f5a3e-1d2c-4e8f-9a7b-3c4d5e6f7a8b', u2 = 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b';
  assert.equal(key(plate(u1, u1, 'Hold')), key(plate(u2, u2, 'Hold')));
  assert.notEqual(key(plate(u1, u1, 'Hold')), key(plate(u1, u1, 'Merge')));
  // The site demo's stand-in makes digit ids: the same.
  assert.equal(key(plate('1794351975', '1794351975', 'Hold')), key(plate('1794351981', '1794351981', 'Hold')));
  assert.match(src, /var sending = \$\('form\.act\[data-busy\], form\.act\[data-touched\], form\[data-sent-sig\]', mounted\) \|\| unconfirmed\[mounted\.id\];\n {8}if \(was === now && !sending\) \{\n {10}var ids = \$\$\s*\('input\[name=nonce\]', p\); \$\$\s*\('input\[name=nonce\]', mounted\)\.forEach\(function\(x, i\)\{ if \(ids\[i\]\) x\.value = ids\[i\]\.value; \}\);\n {10}return;/);
  assert.match(src, /\{ plateSrc\.set\(p, plateKey\(p\.outerHTML\)\); store_\.appendChild\(p\); \}/);
});

test('Settings sits in the middle of the window and never runs past it; each tab scrolls inside (Dan, 2026-11-10)', () => {
  const src = servedSource();
  assert.match(src, /^#settings\[open\]\{display:grid;grid-template-columns:168px minmax\(0,1fr\);grid-template-rows:minmax\(0,1fr\) auto;height:min\(720px,calc\(100dvh - 32px\)\);max-height:calc\(100dvh - 32px\);margin:auto\}$/m);
  assert.match(src, /^#settings \.set-panes\{grid-column:2;min-height:0;max-height:none;/m);
  assert.match(src, /^\.set-panes\{[^}]*overflow-y:auto\}$/m);
  // Nothing pins it to the top of the window.
  assert.doesNotMatch(src, /#settings(\[open\])?\{[^}]*(margin-top|margin:\d|top:)/);
  // A tab opens at its top.
  assert.match(src, /if \(panes && \(!setDlg\.open \|\| !was \|\| was\.dataset\.tab !== tab\)\) panes\.scrollTop = 0;/);
});

test('the code names no one\'s address, relay or files', () => {
  const lines = servedSource().split('\n').filter((l) => /t3coderelay|\.ts\.net|pass\.allow/.test(l));
  assert.deepEqual(lines, []);
});
