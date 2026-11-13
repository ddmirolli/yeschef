// The team demo's made-up diff (client/demo-diff.ts): every file of Iris's PR with its exact counts, drawn by the app's
// own pipe as the site demo draws it.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { parsePatchFiles } from '@pierre/diffs';
import { demoDiff, DEMO_DIFF_PR } from './demo-diff.ts';
import { IRIS } from './demo-team.ts';
import { drawPatch } from './diffs.ts';

test('the demo patch holds each of the PR\'s 41 files with its counts, then the lockfile GitHub withheld, the same on every run', () => {
  const d = demoDiff();
  assert.deepEqual(d.pr, { repo: 'fernpay/fernpay', n: 440 });
  assert.equal(d.patch, demoDiff().patch);
  const files = parsePatchFiles(d.patch).flatMap((p) => p.files);
  const counted = files.map((f) => [f.name, f.hunks.reduce((n, h) => n + h.additionLines, 0), f.hunks.reduce((n, h) => n + h.deletionLines, 0)]);
  assert.deepEqual(counted, [...IRIS.map(([p, a, d]) => [p, a, d]), ['pnpm-lock.yaml', 0, 0]]);
  assert.deepEqual(d.withheld, [{ path: 'pnpm-lock.yaml', additions: 2104, deletions: 0 }]);
  // The 41 files are the PR's size on the board.
  assert.equal(IRIS.reduce((n, [, a]) => n + a, 0), 1079);
  assert.equal(IRIS.reduce((n, [, , d]) => n + d, 0), 161);
  // A file that only adds lines is new, except a package's index; tests are all new.
  for (const f of files.filter((x) => x.name.includes('/__tests__/'))) assert.equal(f.type, 'new');
  assert.equal(files.find((x) => x.name === 'packages/contracts/src/index.ts')?.type, 'change');
  // Made from names, never from a missing one.
  assert.doesNotMatch(d.patch, /undefined|NaN|\[object/);
});

test('the app\'s pipe draws the demo patch: every file, the lockfile with T3\'s counts and the reason it has no code', async () => {
  const d = demoDiff();
  const drawn = await drawPatch(d.patch, d.withheld);
  assert.equal(drawn.files.length, 42);
  const lock = drawn.files.at(-1)!;
  assert.deepEqual([lock.path, lock.add, lock.del], ['pnpm-lock.yaml', 2104, 0]);
  assert.match(lock.code, /GitHub withheld this file's code/);
  for (const f of drawn.files.slice(0, -1)) assert.match(f.code, /^<pre data-diff/);
  assert.equal(DEMO_DIFF_PR.n, 440);
});
