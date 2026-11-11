// node --test site/*.test.mjs. The site's release lookup (releases.js), run outside a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./releases.js', import.meta.url), 'utf8');
function load() {
  const box = { URLSearchParams, Intl, Date, JSON, Math, Promise };
  box.globalThis = box;
  vm.runInNewContext(source, box);
  return box.YCReleases;
}
const R = load();

const asset = (name, size = 120342209) => ({ name, size, browser_download_url: `https://github.com/ddmirolli/yeschef/releases/download/x/${name}` });
const stable = { tag_name: 'v0.2.0', draft: false, prerelease: false, published_at: '2026-11-10T12:00:00Z',
  assets: [asset('Yes-Chef-0.2.0-arm64.zip'), asset('latest-mac.yml', 500), asset('Yes-Chef-0.2.0-arm64.dmg')] };
const nightly = { tag_name: 'v0.2.1-nightly.20261111.1', draft: false, prerelease: true, published_at: '2026-11-11T09:00:00Z',
  assets: [asset('Yes-Chef-0.2.1-nightly.20261111.1-arm64.dmg', 121000000)] };

function fakeFetch(routes, asked = []) {
  return async (url) => {
    asked.push(url);
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (!r) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    return { ok: r.status ? r.status < 300 : true, status: r.status || 200, json: async () => r.body };
  };
}
function memoryStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}
const API = 'https://api.github.com/repos/ddmirolli/yeschef/releases';

test('the DMG is the Apple silicon disk image, not the ZIP or the feed', () => {
  assert.equal(R.dmgOf(stable).name, 'Yes-Chef-0.2.0-arm64.dmg');
  assert.equal(R.dmgOf({ assets: [asset('Yes-Chef-0.2.0-arm64.zip')] }), null);
  assert.equal(R.dmgOf(null), null);
});

test('Nightly picks the newest published nightly with a DMG', () => {
  const draft = { ...nightly, tag_name: 'v0.2.1-nightly.20261112.1', draft: true };
  const bare = { ...nightly, tag_name: 'v0.2.1-nightly.20261111.2', assets: [] };
  assert.equal(R.pickNightly([draft, bare, stable, nightly]).tag_name, 'v0.2.1-nightly.20261111.1');
  assert.equal(R.pickNightly([stable]), null);
  assert.equal(R.pickNightly({ message: 'Not Found' }), null);
});

test('Stable asks /releases/latest and keeps the answer for the tab', async () => {
  const asked = [], store = memoryStore();
  const f = fakeFetch({ [`${API}/latest`]: { body: stable } }, asked);
  const r = await R.lookup('stable', f, store);
  assert.equal(r.state, 'ok');
  assert.equal(r.dmg.url, 'https://github.com/ddmirolli/yeschef/releases/download/x/Yes-Chef-0.2.0-arm64.dmg');
  const again = await R.lookup('stable', f, store);
  assert.equal(again.state, 'ok');
  assert.deepEqual(asked, [`${API}/latest`]);
});

test('no release yet (404, as for a private repo) is "none" and is not kept', async () => {
  const store = memoryStore();
  assert.deepEqual({ ...(await R.lookup('stable', fakeFetch({}), store)) }, { state: 'none' });
  assert.equal(store.m.size, 0);
});

test('a rate limit or a network failure is "error"', async () => {
  assert.equal((await R.lookup('stable', fakeFetch({ [`${API}/latest`]: { status: 403, body: {} } }), null)).state, 'error');
  assert.equal((await R.lookup('stable', fakeFetch({ [`${API}/latest`]: new TypeError('offline') }), null)).state, 'error');
});

test('Nightly asks one page of the newest releases and skips Stable releases', async () => {
  const asked = [];
  const r = await R.lookup('nightly', fakeFetch({ [`${API}?per_page=30`]: { body: [stable, nightly] } }, asked), memoryStore());
  assert.equal(r.state, 'ok');
  assert.equal(r.release.tag_name, 'v0.2.1-nightly.20261111.1');
  assert.deepEqual(asked, [`${API}?per_page=30`]);
  assert.equal((await R.lookup('nightly', fakeFetch({ [`${API}?per_page=30`]: { body: [stable] } }), null)).state, 'none');
});

test('a full page with no Nightly is "older", never "none" (PR-Agent r1 on #75)', async () => {
  const page = Array.from({ length: R.PER_PAGE }, (_, i) => ({ ...stable, tag_name: `v0.${i}.0` }));
  assert.equal((await R.lookup('nightly', fakeFetch({ [`${API}?per_page=30`]: { body: page } }), null)).state, 'older');
  assert.equal(R.NIGHTLIES, 'https://github.com/ddmirolli/yeschef/releases?q=nightly&expanded=true');
});

test('a body that fails to read is "error", not a rejection (PR-Agent r1 on #75)', async () => {
  const broken = async () => ({ ok: true, status: 200, json: async () => { throw new TypeError('network error'); } });
  assert.equal((await R.lookup('stable', broken, memoryStore())).state, 'error');
  assert.equal((await R.lookup('nightly', broken, null)).state, 'error');
});

test('a kept answer that lost its DMG is asked again', async () => {
  const store = memoryStore();
  store.setItem('yc.release.stable', JSON.stringify({ tag_name: 'v0.1.9', assets: [] }));
  const r = await R.lookup('stable', fakeFetch({ [`${API}/latest`]: { body: stable } }), store);
  assert.equal(r.release.tag_name, 'v0.2.0');
});
