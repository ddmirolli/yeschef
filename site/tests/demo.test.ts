import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKitchen } from '../src/demo/kitchen.ts';
import { createHash as browserHash } from '../src/demo/node-crypto.ts';
import { createHash } from 'node:crypto';

const kitchen = () => createKitchen({
  now: () => new Date('2026-11-10T15:00:00Z').getTime(),
  where: (directory) => ({ icon: `icons/${directory}.svg` }),
  shot: (name) => `img/${name}-dark.png`, later: null,
});

test('the typed demo renders the real app modules with only made-up projects', () => {
  const demo = kitchen();
  assert.ok(demo.board().tickets.length > 0);
  const page = demo.page();
  assert.match(page, /Fernpay/);
  assert.match(page, /Retry failed payouts/);
  assert.doesNotMatch(page, /\/icon\//);
  assert.match(page, /https:\/\/t3\.codes\//);
});

test('unknown demo tools cannot reach T3 or the network', async () => {
  await assert.rejects(kitchen().t3.call('real-tool'), /not in the demo kitchen/);
});

test('demo rule changes stay in memory and reject invalid values', async () => {
  const demo = kitchen();
  assert.equal((await demo.act('kind=rules&key=reviewer&value=invalid'))[0], 400);
  assert.equal((await demo.act('kind=rules&key=reviewer&value=coderabbit'))[0], 200);
  assert.match(demo.page(), /"reviewer":"coderabbit"/);
});

test('browser screenshot IDs stay identical to the app generator IDs', () => {
  for (const text of ['', '/demo/payouts-before.png', 'Fernpay', 'a'.repeat(130), 'crème']) {
    assert.equal(browserHash('sha1').update(text).digest(), createHash('sha1').update(text).digest('hex'));
  }
});
