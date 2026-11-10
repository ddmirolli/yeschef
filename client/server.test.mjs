// The web prototype carries nobody's addresses: it refuses to start without them. Run: node --test client/server.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keysCore } from './keys.mjs';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BRIGADE_|YESCHEF_)/.test(k)));
const run = (args, env = {}) => spawnSync(process.execPath, [SERVER, ...args], { env: { ...clean, ...env }, encoding: 'utf8', timeout: 10000 });

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

test('Settings has no Ticket layout: every ticket uses the bar, and a stored "side" is never read (Dan, 2026-11-10)', () => {
  const src = readFileSync(SERVER, 'utf8');
  assert.doesNotMatch(src, /Ticket layout|name="layout"|Side panel<|pv-side|a-side|a-bottom/);
  assert.doesNotMatch(src, /getItem\('yc\.layout2'\)|store\('yc\.layout2'/);
  // Density stays, and Shortcuts lists every command in client/keys.mjs, More's key among them.
  assert.match(src, /<legend>Density<\/legend>/);
  assert.match(src, /<div id="kx-list"><\/div>/);
  assert.deepEqual(keysCore(true).CMD['ticket.more'].keys, ['.']);
  // The bar's CSS: the blue action fills, the menu is a popover, and on a phone it opens as a sheet.
  assert.match(src, /\.abar \.ab\.fill\{background:var\(--accent\);color:#fff\}/);
  assert.match(src, /\.abar \.menu:popover-open\{display:flex/);
  assert.match(src, /\.abar \.menu::backdrop\{/);
});

test('a narrow ticket in a wide window never clips the bar: it steps down by the ticket\'s own width (PR-Agent r1 on #72)', () => {
  const src = readFileSync(SERVER, 'utf8');
  const block = src.slice(src.indexOf('@media (min-width:761px){\n  @container (max-width:560px){'));
  assert.ok(block.length < src.length, 'the fallback sits in a wide-window media query, so the phone bar keeps its words');
  // Changes and Reply keep only their icons; the word stays the button's name for screen readers, never display:none.
  assert.match(block, /@container \(max-width:560px\)\{\s*\.abar \.ab:not\(\.primary\)\{width:36px;padding:0\}\s*\.abar \.ab:not\(\.primary\) \.bl\{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset\(50%\)/);
  // Hold and Settle move into More, then the row wraps.
  assert.match(block, /@container \(max-width:420px\)\{\s*\.abar \.ib:not\(\.more-b\),\.abar \.vr\{display:none\}\s*\.abar \.mi\.ph\{display:flex\}/);
  assert.match(block, /@container \(max-width:300px\)\{ \.abar\{flex-wrap:wrap;row-gap:6px\} \}/);
});

test('the blue Send names two picks at most, so it fits the phone pill; its words end in an ellipsis before the next slot (PR-Agent r2 on #72)', () => {
  const src = readFileSync(SERVER, 'utf8');
  assert.match(src, /\(plan\.length > 2 \? 'Send all' : 'Send ' \+ picks\)/);
  assert.match(src, /\.abar \.ab \.bl\{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis\}/);
});

test('the code names no one\'s address, relay or files', () => {
  const lines = readFileSync(SERVER, 'utf8').split('\n').filter((l) => /t3coderelay|\.ts\.net|pass\.allow/.test(l));
  assert.deepEqual(lines, []);
});
