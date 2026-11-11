// The /join page's link to the app, run without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appLink } from '../src/scripts/join.ts';

test('an invite link opens the app with the same fragment', () => {
  assert.equal(appLink('https://yeschef.codes/join#eyJ2IjoxfQ'), 'yeschef://join#eyJ2IjoxfQ');
});

test('a link with no invite, or anything but base64url in it, opens nothing', () => {
  for (const href of ['https://yeschef.codes/join', 'https://yeschef.codes/join#', 'https://yeschef.codes/join#a b', 'https://yeschef.codes/join#x"><script>', `https://yeschef.codes/join#${'a'.repeat(5000)}`]) {
    assert.equal(appLink(href), null, href);
  }
});

test('the page sends the invite nowhere: no referrer, not indexed, no request in its script', () => {
  const page = readFileSync(new URL('../src/pages/join.astro', import.meta.url), 'utf8');
  assert.match(page, /<meta name="referrer" content="no-referrer">/);
  assert.match(page, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(page, /<script[^>]*src=/);
  assert.doesNotMatch(readFileSync(new URL('../src/scripts/join.ts', import.meta.url), 'utf8'), /fetch|XMLHttpRequest|sendBeacon|WebSocket/);
});
