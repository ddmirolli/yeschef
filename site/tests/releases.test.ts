// The release lookup runs without a browser or network access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/scripts/releases.ts';
import type { FetchReleases, ReleaseResponse } from '../src/scripts/releases.ts';

const asset = (name: string, size = 120342209) => ({ name, size, browser_download_url: `https://github.com/ddmirolli/yeschef/releases/download/x/${name}` });
const stable = { tag_name: 'v0.2.0', draft: false, prerelease: false, published_at: '2026-11-10T12:00:00Z',
  assets: [asset('Yes-Chef-0.2.0-arm64.zip'), asset('latest-mac.yml', 500), asset('Yes-Chef-0.2.0-arm64.dmg')] };
const nightly = { tag_name: 'v0.2.1-nightly.20261111.1', draft: false, prerelease: true, published_at: '2026-11-11T09:00:00Z',
  assets: [asset('Yes-Chef-0.2.1-nightly.20261111.1-arm64.dmg', 121000000)] };

function fakeFetch(routes: Record<string, Error | { status?: number; body: unknown }>, asked: string[] = []): FetchReleases {
  return async (url) => {
    asked.push(url);
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (!r) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    return { ok: r.status ? r.status < 300 : true, status: r.status || 200, json: async () => r.body };
  };
}
function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => (m.get(k) ?? null), setItem: (k: string, v: string) => m.set(k, String(v)), m };
}
const API = 'https://api.github.com/repos/ddmirolli/yeschef/releases';

test('the build line says how long ago, never the version, and links only to this repo\'s release', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  assert.equal(R.builtAgo('2026-11-13T11:59:50Z', now), 'Built 1 minute ago');
  assert.equal(R.builtAgo('2026-11-13T09:00:00Z', now), 'Built 3 hours ago');
  assert.equal(R.builtAgo('2026-11-11T13:00:00Z', now), 'Built 47 hours ago');
  assert.equal(R.builtAgo('2026-11-10T12:00:00Z', now), 'Built 3 days ago');
  assert.equal(R.builtAgo('not a time', now), null);
  assert.equal(R.builtAgo(undefined, now), null);
  assert.equal(R.builtOn('2026-11-11T13:00:00Z', 'UTC'), 'Built Nov 11, 2026');
  assert.equal(R.builtOn('2026-11-11T03:00:00Z', 'America/New_York'), 'Built Nov 10, 2026');
  assert.equal(R.builtOn('not a time'), null);
  assert.equal(R.builtOn(undefined), null);
  assert.equal(R.releasePage({ html_url: 'https://github.com/ddmirolli/yeschef/releases/tag/v0.2.2' }), 'https://github.com/ddmirolli/yeschef/releases/tag/v0.2.2');
  assert.equal(R.releasePage({ html_url: 'https://evil.example/ddmirolli/yeschef/releases/tag/v1' }), null);
  assert.equal(R.releasePage({ html_url: 'javascript:alert(1)' }), null);
  assert.equal(R.releasePage(null), null);
});

test('the DMG is the Apple silicon disk image, not the ZIP or the feed', () => {
  assert.equal(R.dmgOf(stable)?.name, 'Yes-Chef-0.2.0-arm64.dmg');
  assert.equal(R.dmgOf({ assets: [asset('Yes-Chef-0.2.0-arm64.zip')] }), null);
  assert.equal(R.dmgOf(null), null);
});

test('Nightly picks the newest published nightly with a DMG', () => {
  const draft = { ...nightly, tag_name: 'v0.2.1-nightly.20261112.1', draft: true };
  const bare = { ...nightly, tag_name: 'v0.2.1-nightly.20261111.2', assets: [] };
  assert.equal(R.pickNightly([draft, bare, stable, nightly])?.tag_name, 'v0.2.1-nightly.20261111.1');
  assert.equal(R.pickNightly([stable]), null);
  assert.equal(R.pickNightly({ message: 'Not Found' }), null);
});

test('Stable asks /releases/latest and keeps the answer for the tab', async () => {
  const asked: string[] = [], store = memoryStore();
  const f = fakeFetch({ [`${API}/latest`]: { body: stable } }, asked);
  const r = await R.lookup('stable', f, store);
  assert.ok(r.state === 'ok');
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
  const asked: string[] = [];
  const r = await R.lookup('nightly', fakeFetch({ [`${API}?per_page=30`]: { body: [stable, nightly] } }, asked), memoryStore());
  assert.ok(r.state === 'ok');
  assert.ok(r.state === 'ok');
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
  const broken = async (): Promise<ReleaseResponse> => ({ ok: true, status: 200, json: async () => { throw new TypeError('network error'); } });
  assert.equal((await R.lookup('stable', broken, memoryStore())).state, 'error');
  assert.equal((await R.lookup('nightly', broken, null)).state, 'error');
});

test('a kept answer that lost its DMG is asked again', async () => {
  const store = memoryStore();
  store.setItem('yc.release.stable', JSON.stringify({ tag_name: 'v0.1.9', assets: [] }));
  const r = await R.lookup('stable', fakeFetch({ [`${API}/latest`]: { body: stable } }), store);
  assert.ok(r.state === 'ok');
  assert.equal(r.release.tag_name, 'v0.2.0');
});
