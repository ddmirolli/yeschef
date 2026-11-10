// node --test site/*.test.mjs. The /join page's link to the app (join.js), run outside a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const box = {}; box.globalThis = box;
vm.runInNewContext(readFileSync(new URL('./join.js', import.meta.url), 'utf8'), box);
const { appLink } = box.YCJoin;

test('an invite link opens the app with the same fragment', () => {
  assert.equal(appLink('https://yeschef.codes/join#eyJ2IjoxfQ'), 'yeschef://join#eyJ2IjoxfQ');
});
test('a link with no invite, or anything but base64url in it, opens nothing', () => {
  for (const href of ['https://yeschef.codes/join', 'https://yeschef.codes/join#', 'https://yeschef.codes/join#a b', 'https://yeschef.codes/join#x"><script>', `https://yeschef.codes/join#${'a'.repeat(5000)}`]) {
    assert.equal(appLink(href), null, href);
  }
});
test('the page sends the invite nowhere: no referrer, no fetch, no other script', () => {
  const html = readFileSync(new URL('./join.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.deepEqual([...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]), ['/join.js']);
  assert.doesNotMatch(readFileSync(new URL('./join.js', import.meta.url), 'utf8'), /fetch|XMLHttpRequest|sendBeacon/);
});
