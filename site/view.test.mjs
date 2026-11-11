// The site's "I run" view on load (Dan, 2026-11-10). Run: node --test site/view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const head = html.match(/<script>\s*(\/\* The "I run" view before the first paint[\s\S]*?)<\/script>/)[1];

// Runs the head script for an address, with a pick a visitor saved before this change.
function viewFor(search) {
  const attrs = {};
  const ctx = vm.createContext({
    URLSearchParams, location: { search },
    localStorage: { getItem: () => 'solo' },
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
  });
  vm.runInContext(head, ctx);
  return attrs['data-view'];
}

test('the site opens on team, whatever was picked on an earlier visit', () => {
  assert.equal(viewFor(''), 'team');
  assert.equal(viewFor('?view=nonsense'), 'team');
  assert.equal(viewFor('?view=team'), 'team');
  // A link that names solo still opens on solo.
  assert.equal(viewFor('?view=solo'), 'solo');
  // Nothing stores the pick.
  assert.doesNotMatch(readFileSync(new URL('./site.js', import.meta.url), 'utf8'), /localStorage/);
  assert.doesNotMatch(head, /localStorage/);
});

test('the Download button has no line under it', () => {
  assert.doesNotMatch(html, /dl-meta|Needs T3 Code on the same Mac/);
  assert.match(html, /<span>Download for Mac<\/span><\/a>\n {10}<a class="hero-source"/);
});
