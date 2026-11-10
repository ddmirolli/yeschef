// Finding T3 Code on this Mac. Run: node --test desktop/t3.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DEFAULT_T3, findT3, older, t3Answers } from './t3.mjs';

const runtime = (obj) => () => JSON.stringify(obj);
const home = '/Users/someone';

test('T3 Code\'s own file names the address and the version', () => {
  let asked = null;
  const read = (file) => { asked = file; return JSON.stringify({ origin: 'http://127.0.0.1:4100', port: 4100, serverVersion: '0.1.9' }); };
  assert.deepEqual(findT3({ env: {}, home, read }), { origin: 'http://127.0.0.1:4100', version: '0.1.9', from: 'server-runtime.json' });
  assert.equal(asked, '/Users/someone/.t3/userdata/server-runtime.json');
});

test('YESCHEF_T3_ORIGIN wins over the file, and its version is unknown', () => {
  const read = runtime({ origin: 'http://127.0.0.1:4100', serverVersion: '0.1.9' });
  assert.deepEqual(findT3({ env: { YESCHEF_T3_ORIGIN: 'http://127.0.0.1:5000/' }, home, read }),
    { origin: 'http://127.0.0.1:5000', version: null, from: 'YESCHEF_T3_ORIGIN' });
});

test('no file, a broken file or an odd address falls back to 3773', () => {
  const none = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
  for (const read of [none, () => '{not json', runtime({}), runtime({ origin: 'file:///etc/passwd' }),
    runtime({ origin: 'http://user:pw@127.0.0.1:4100' }), runtime({ origin: 'http://127.0.0.1:4100/somewhere' })]) {
    assert.deepEqual(findT3({ env: {}, home, read }), { origin: DEFAULT_T3, version: null, from: 'default' });
  }
});

test('a version that is not a string is not shown as one', () => {
  assert.equal(findT3({ env: {}, home, read: runtime({ origin: 'http://127.0.0.1:3773', serverVersion: 17 }) }).version, null);
});

test('older compares x.y.z numerically and never guesses', () => {
  assert.equal(older('0.1.5', '0.1.7'), true);
  assert.equal(older('0.1.7', '0.1.7'), false);
  assert.equal(older('0.1.10', '0.1.7'), false);
  assert.equal(older('0.2.0', '0.10.0'), true);
  assert.equal(older('0.1.7-nightly.20261110.1', '0.1.7'), false);
  assert.equal(older('v0.1.6', '0.1.7'), true);
  assert.equal(older(null, '0.1.7'), false);
  assert.equal(older('dev', '0.1.7'), false);
});

test('t3Answers is true only when T3 Code\'s sign-in metadata answers', async () => {
  const srv = createServer((req, res) => res.writeHead(req.url === '/.well-known/oauth-authorization-server' ? 200 : 404).end('{}'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal(await t3Answers(origin), true);
  } finally { srv.close(); }
  // Nothing listens there now.
  assert.equal(await t3Answers(origin), false);
  // A server that never answers runs out of time instead of hanging.
  const hang = createServer(() => {});
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  try {
    const t0 = Date.now();
    assert.equal(await t3Answers(`http://127.0.0.1:${hang.address().port}`, { timeoutMs: 300 }), false);
    assert.ok(Date.now() - t0 < 2000);
  } finally { hang.closeAllConnections(); hang.close(); }
});
