// Too big's code from T3 Code (client/diffs.ts): the address the page asks, the request T3's diff panel makes, the
// cache, the key T3 refuses, and the drawing with T3's renderer. No network: a stand-in fetch answers as T3 Code does.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { createDiffs, diffRoute, drawPatch, readDiffUrl, readableOnLightCode, splitFile, DIFF_OPTIONS, LIMITS } from './diffs.ts';
import type { Drawn, Withheld } from './diffs.ts';

const url = (path: string) => new URL(path, 'http://x');

test('the page asks for a PR by owner/name and number, and a file by its path; anything else is not an address', () => {
  assert.deepEqual(readDiffUrl(url('/diff?repo=acme%2Ffernpay&n=440')), { pr: { repo: 'acme/fernpay', n: 440 }, file: null, rev: null });
  assert.deepEqual(readDiffUrl(url('/diff?repo=acme/fernpay&n=440&v=1762.41.9&f=src%2Fa.ts')), { pr: { repo: 'acme/fernpay', n: 440 }, file: 'src/a.ts', rev: '1762.41.9' });
  for (const bad of ['/diff', '/diff?repo=acme&n=1', '/diff?repo=a/b/c&n=1', '/diff?repo=../x&n=1', '/diff?repo=a/..&n=1', '/diff?repo=a%20b/c&n=1',
    '/diff?repo=a/b&n=0', '/diff?repo=a/b&n=-1', '/diff?repo=a/b&n=1.5', '/diff?repo=a/b&n=x', '/diff?repo=a/b&n=1&f=', `/diff?repo=a/b&n=1&f=${'x'.repeat(1001)}`, '/other?repo=a/b&n=1',
    '/diff?repo=a/b&n=1&v=', '/diff?repo=a/b&n=1&v=a%20b', `/diff?repo=a/b&n=1&v=${'1'.repeat(65)}`]) {
    assert.equal(readDiffUrl(url(bad)), null, bad);
  }
});

test('/diff reads only a PR a Too big call on the board names, and answers JSON nobody sniffs', async () => {
  const asked: string[] = [];
  const diffs = {
    view: async (pr: { repo: string; n: number }, rev: string | null = null) => { asked.push(`view ${pr.repo}#${pr.n}@${rev}`); return { ok: false as const, why: 'stub' }; },
    file: async (pr: { repo: string; n: number }, f: string, rev: string | null = null) => { asked.push(`file ${pr.repo}#${pr.n}@${rev} ${f}`); return { ok: true as const, code: '<pre></pre>' }; },
  };
  const shown = () => [{ repo: 'Acme/Fernpay', n: 440 }];
  assert.equal(await diffRoute(url('/app'), { diffs, shown }), null);
  const no = await diffRoute(url('/diff?repo=acme/fernpay&n=441'), { diffs, shown });
  assert.equal(no!.status, 404);
  assert.equal((await diffRoute(url('/diff?repo=../x&n=440'), { diffs, shown }))!.status, 404);
  const v = await diffRoute(url('/diff?repo=acme/fernpay&n=440'), { diffs, shown });
  assert.equal(v!.status, 200);
  assert.equal(v!.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(v!.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(JSON.parse(v!.body), { ok: false, why: 'stub' });
  const f = await diffRoute(url('/diff?repo=acme/fernpay&n=440&v=7.1.2&f=src/a.ts'), { diffs, shown });
  assert.deepEqual(JSON.parse(f!.body), { ok: true, code: '<pre></pre>' });
  assert.deepEqual(asked, ['view acme/fernpay#440@null', 'file acme/fernpay#440@7.1.2 src/a.ts']);
});

/** A stand-in T3 Code: each POST to /api/pull-requests/diff takes the next answer. */
function t3(answers: { status: number; body: unknown }[]) {
  const seen: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    seen.push({ url: req.url, auth: req.headers.get('authorization'), body: JSON.parse(await req.text()) as Record<string, unknown> });
    const a = answers.shift() ?? { status: 500, body: { _tag: 'Unexpected' } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}
const drawn = (patch: string): Promise<Drawn> => Promise.resolve({ style: '<style></style>', sprite: '<svg></svg>',
  files: patch.split('\n').filter(Boolean).map((line) => ({ path: line, prev: null, type: 'change', add: 1, del: 0, header: `<div>${line}</div>`, code: `<pre>${line}</pre>` })) });
const keysOf = (tokens: string[]) => { let at = 0; const k = { dropped: 0, get: async () => tokens[at]!, drop: () => { at++; k.dropped++; } }; return k; };

test('it asks T3 Code as its diff panel does: read-only key, the project, host github.com, then each page by cursor', async () => {
  const { seen, fetchImpl } = t3([
    { status: 200, body: { patch: 'a.ts', truncated: false, nextCursor: 'c2', omittedFileStats: [{ path: 'big.lock', additions: 9000, deletions: 0 }] } },
    { status: 200, body: { patch: 'b.ts\n', truncated: false, nextCursor: null } },
  ]);
  let held: readonly Withheld[] = [];
  const draw = (patch: string, withheld: readonly Withheld[]): Promise<Drawn> => { held = withheld; return drawn(patch); };
  const diffs = createDiffs({ origin: 'http://127.0.0.1:3773', keys: keysOf(['k1']), project: () => 'proj-1', fetchImpl, draw });
  const v = await diffs.view({ repo: 'acme/fernpay', n: 440 });
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.url, 'http://127.0.0.1:3773/api/pull-requests/diff');
  assert.equal(seen[0]!.auth, 'Bearer k1');
  assert.deepEqual(seen[0]!.body, { projectId: 'proj-1', host: 'github.com', repository: 'acme/fernpay', number: 440 });
  assert.deepEqual(seen[1]!.body, { projectId: 'proj-1', host: 'github.com', repository: 'acme/fernpay', number: 440, cursor: 'c2' });
  assert.ok(v.ok);
  // The page gets each file's header, never its code. A file GitHub withheld goes to the drawing with T3's counts, and
  // nothing is left to link to.
  assert.deepEqual(v.files.map((f) => f.path), ['a.ts', 'b.ts']);
  assert.ok(v.files.every((f) => !('code' in f)));
  assert.deepEqual(held, [{ path: 'big.lock', additions: 9000, deletions: 0 }]);
  assert.equal(v.rest, false);
  // A file's code comes from the same read: T3 is asked once a minute, not once a file.
  assert.deepEqual(await diffs.file({ repo: 'ACME/fernpay', n: 440 }, 'b.ts'), { ok: true, code: '<pre>b.ts</pre>' });
  assert.deepEqual(await diffs.file({ repo: 'acme/fernpay', n: 440 }, 'gone.ts'), { ok: false, why: 'This file is not in the PR now' });
  assert.equal(seen.length, 2);
});

test('the page limit stops the read, says the diff goes on, and a minute later T3 is asked again', async () => {
  const page = { status: 200, body: { patch: 'x.ts', truncated: false, nextCursor: 'more' } };
  const { seen, fetchImpl } = t3(Array.from({ length: LIMITS.pages * 2 }, () => structuredClone(page)));
  let t = 0;
  const diffs = createDiffs({ origin: 'http://127.0.0.1:3773', keys: keysOf(['k']), project: () => 'p', fetchImpl, draw: drawn, now: () => t });
  const v = await diffs.view({ repo: 'a/b', n: 1 });
  assert.equal(seen.length, LIMITS.pages);
  assert.ok(v.ok && v.rest);
  t = LIMITS.keep - 1;
  await diffs.view({ repo: 'a/b', n: 1 });
  assert.equal(seen.length, LIMITS.pages);
  t = LIMITS.keep;
  await diffs.view({ repo: 'a/b', n: 1 });
  assert.equal(seen.length, LIMITS.pages * 2);
});

test('reads are kept per revision; a file always comes from the read its list came from, however old', async () => {
  const one = { status: 200, body: { patch: 'a.ts', truncated: false, nextCursor: null } };
  const two = { status: 200, body: { patch: 'b.ts', truncated: false, nextCursor: null } };
  const { seen, fetchImpl } = t3([one, two, structuredClone(two)]);
  let t = 0;
  const diffs = createDiffs({ origin: 'http://127.0.0.1:3773', keys: keysOf(['k']), project: () => 'p', fetchImpl, draw: drawn, now: () => t });
  const pr = { repo: 'a/b', n: 1 };
  assert.deepEqual((await diffs.view(pr, 'r1')).ok && (await diffs.view(pr, 'r1') as { files: { path: string }[] }).files.map((f) => f.path), ['a.ts']);
  assert.equal(seen.length, 1);
  // Long after, the list's own read still answers its files, though T3 now has a newer patch.
  t = LIMITS.keep * 10;
  assert.deepEqual(await diffs.file(pr, 'a.ts', 'r1'), { ok: true, code: '<pre>a.ts</pre>' });
  assert.equal(seen.length, 1);
  // A new revision is a new read at once, and the old list read again after a minute is one too.
  assert.deepEqual((await diffs.view(pr, 'r2') as { files: { path: string }[] }).files.map((f) => f.path), ['b.ts']);
  assert.equal(seen.length, 2);
  await diffs.view(pr, 'r1');
  assert.equal(seen.length, 3);
});

test('a key T3 refuses is dropped and a new one tried once; any other failure says why and is not kept', async () => {
  const ok = { status: 200, body: { patch: 'a.ts', truncated: false, nextCursor: null } };
  const one = t3([{ status: 401, body: { _tag: 'Unauthorized' } }, ok]);
  const keys = keysOf(['old', 'new']);
  const v = await createDiffs({ origin: 'http://127.0.0.1:3773', keys, project: () => 'p', fetchImpl: one.fetchImpl, draw: drawn }).view({ repo: 'a/b', n: 1 });
  assert.ok(v.ok);
  assert.equal(keys.dropped, 1);
  assert.deepEqual(one.seen.map((s) => s.auth), ['Bearer old', 'Bearer new']);

  const two = t3([{ status: 502, body: { _tag: 'PullRequestOperationError' } }, ok]);
  const diffs = createDiffs({ origin: 'http://127.0.0.1:3773', keys: keysOf(['k']), project: () => 'p', fetchImpl: two.fetchImpl, draw: drawn });
  assert.deepEqual(await diffs.view({ repo: 'a/b', n: 1 }), { ok: false, why: 'T3 Code gave no diff (502)' });
  assert.ok((await diffs.view({ repo: 'a/b', n: 1 })).ok);

  const shape = t3([{ status: 200, body: { patch: 7 } }]);
  assert.deepEqual(await createDiffs({ origin: 'http://127.0.0.1:3773', keys: keysOf(['k']), project: () => 'p', fetchImpl: shape.fetchImpl, draw: drawn }).view({ repo: 'a/b', n: 1 }),
    { ok: false, why: 'T3 Code gave no diff (200)' });
  const none = t3([]);
  assert.deepEqual(await createDiffs({ origin: 'http://127.0.0.1:3773', keys: keysOf(['k']), project: () => null, fetchImpl: none.fetchImpl, draw: drawn }).view({ repo: 'a/b', n: 1 }),
    { ok: false, why: 'T3 Code lists no project to ask through' });
  assert.equal(none.seen.length, 0);
});

const PATCH = [
  'diff --git a/src/<b>.ts b/src/<b>.ts',
  'index 1111111..2222222 100644',
  '--- a/src/<b>.ts',
  '+++ b/src/<b>.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = "<script>alert(1)</script>";',
  '+const b = "<img src=x onerror=alert(1)>";',
  '+const c = a + 1;',
  ' export { a };',
  'diff --git a/README.md b/README.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/README.md',
  '@@ -0,0 +1,2 @@',
  '+# Statements',
  '+Export to CSV.',
  '',
].join('\n');

test('a patch is drawn with T3 Code\'s renderer and settings: headers folded with its chevron, code apart, all text escaped', async () => {
  assert.deepEqual(DIFF_OPTIONS, { diffStyle: 'unified', lineDiffType: 'none', overflow: 'wrap', theme: { dark: 'pierre-dark', light: 't3-light' }, themeType: 'system', preferredHighlighter: 'highlights' });
  const d = await drawPatch(PATCH);
  assert.deepEqual(d.files.map(({ path, type, add, del }) => ({ path, type, add, del })), [
    { path: 'src/<b>.ts', type: 'change', add: 2, del: 1 }, { path: 'README.md', type: 'new', add: 2, del: 0 }]);
  assert.match(d.style, /^<style data-core-css="">[^]*<\/style><style data-theme-css="">[^]*<\/style>$/);
  assert.match(d.sprite, /^<svg data-icon-sprite/);
  const [a] = d.files;
  assert.match(a!.header, /^<div data-sticky="" data-diffs-header="default" data-change-type="change"><div data-header-content=""><button type="button" data-fold aria-expanded="false" aria-label="Expand src\/&#60;b&#62;\.ts" title="Expand diff"><svg /);
  assert.doesNotMatch(a!.header, /<pre|<slot name="header-prefix">/);
  assert.match(a!.code, /^<pre data-diff/);
  // Code and paths are text: no tag from the patch survives.
  for (const html of [a!.header, a!.code]) assert.doesNotMatch(html, /<script|<img|<b>/);
  assert.match(a!.code, /&lt;script&gt;|&#x3C;script/);
});

test('a cut T3 explains with withheld files leaves nothing to link to; a cut it does not explain links to the rest', async () => {
  const read = async (body: object) => createDiffs({ origin: 'http://127.0.0.1:3773', keys: keysOf(['k']), project: () => 'p',
    fetchImpl: t3([{ status: 200, body }]).fetchImpl, draw: drawn }).view({ repo: 'a/b', n: 1 });
  const held = await read({ patch: 'a.ts', truncated: true, nextCursor: null, omittedFileStats: [{ path: 'a.png', additions: 1, deletions: 0 }] });
  assert.ok(held.ok && !held.rest);
  const cut = await read({ patch: 'a.ts', truncated: true, nextCursor: null });
  assert.ok(cut.ok && cut.rest);
});

test('a file GitHub withheld keeps its place, shows T3\'s counts as pierre draws them, and says why it has no code', async () => {
  const patch = PATCH + ['diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml', '--- a/pnpm-lock.yaml', '+++ b/pnpm-lock.yaml',
    'diff --git a/img/logo.png b/img/logo.png', 'new file mode 100644', '--- /dev/null', '+++ b/img/logo.png', ''].join('\n');
  const d = await drawPatch(patch, [{ path: 'pnpm-lock.yaml', additions: 2104, deletions: 3 }, { path: 'img/logo.png', additions: 1, deletions: 0 },
    { path: 'src/<b>.ts', additions: 99, deletions: 99 }]);
  assert.deepEqual(d.files.map(({ path, type, add, del }) => ({ path, type, add, del })), [
    { path: 'src/<b>.ts', type: 'change', add: 2, del: 1 }, { path: 'README.md', type: 'new', add: 2, del: 0 },
    { path: 'pnpm-lock.yaml', type: 'change', add: 2104, del: 3 }, { path: 'img/logo.png', type: 'new', add: 1, del: 0 }]);
  const [a, , lock, logo] = d.files;
  assert.match(lock!.header, /<div data-metadata=""><span data-deletions-count="">-3<\/span><span data-additions-count="">\+2104<\/span><slot name="header-metadata"><\/slot><\/div>/);
  assert.match(logo!.header, /<div data-metadata=""><span data-additions-count="">\+1<\/span><slot name="header-metadata"><\/slot><\/div>/);
  for (const f of [lock, logo]) assert.equal(f!.code, '<div class="ld">GitHub withheld this file\'s code: a binary file, or a change too large to inline.</div>');
  // A file the patch has code for keeps pierre's own counts and code, whatever the list says.
  assert.match(a!.header, /-1<\/span><span data-additions-count="">\+2</);
  assert.match(a!.code, /^<pre data-diff/);
});

test('a renderer page this module cannot split says so', () => {
  assert.throws(() => splitFile('<div>no icons</div>'), /gave no icons/);
});

test('T3\'s readable light theme darkens a syntax color only until it reads on light code', () => {
  assert.equal(readableOnLightCode('#000000'), '#000000');
  const dark = readableOnLightCode('#ffca00');
  assert.notEqual(dark, '#ffca00');
  assert.match(dark, /^#[0-9a-f]{6}$/);
  assert.equal(readableOnLightCode('#ffca0080').slice(-2), '80');
  assert.equal(readableOnLightCode('teal'), 'teal');
});
