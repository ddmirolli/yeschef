// Which release each channel takes from GitHub: electron-updater's own GitHubProvider (the pinned version in
// node_modules, so run `vp install` at the repo root first), set up as updates.ts sets up the app's updater, against a
// stubbed github.com. A Stable release published after a Nightly sits at the top of the releases feed; Nightly must
// still take only Nightly releases (PR-Agent r4 on #66).
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { FEED } from './channels.ts';
import { createUpdates } from './updates.ts';
import type { Squirrel, Timers, Updater } from './updates.ts';

const require = createRequire(import.meta.url);
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');

const BASE = `/${FEED.owner}/${FEED.repo}/releases`;

// GitHub's releases.atom lists the newest release first, prereleases included.
const atom = (tags: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">${tags.map((tag) => `
  <entry><title>${tag}</title><link rel="alternate" type="text/html" href="https://github.com${BASE}/tag/${tag}"/><content>No content.</content></entry>`).join('')}
</feed>`;
const yml = (version: string) => `version: ${version}
files:
  - url: Yes-Chef-${version}-arm64.zip
    sha512: c2hh
    size: 1
path: Yes-Chef-${version}-arm64.zip
sha512: c2hh
releaseDate: '2026-11-10T00:00:00.000Z'
`;

// github.com as the provider reads it: the Atom feed, /releases/latest (the newest release that is not a
// prerelease) and the channel files of each release.
function github({ tags, latest }: { tags: string[]; latest: string }) {
  const asked: string[] = [];
  const executor = {
    async request(options: { path: string }) {
      const path = options.path.split('?')[0]!;
      asked.push(path);
      if (path === `${BASE}.atom`) return atom(tags);
      if (path === `${BASE}/latest`) return JSON.stringify({ tag_name: latest });
      const file = new RegExp(`^${BASE}/download/v([^/]+)/(latest|nightly)-mac\\.yml$`).exec(path);
      if (file && tags.includes(`v${file[1]}`)) {
        const nightly = file[1]!.includes('-nightly.');
        if ((file[2] === 'nightly') === nightly) return yml(file[1]!);
      }
      const error: Error & { statusCode?: number } = new Error(`404 ${path}`);
      error.statusCode = 404;
      throw error;
    },
  };
  return { executor, asked };
}

// The updater settings updates.ts makes for an app of this version, read back from a stand-in updater. The stand-ins
// have only what this path uses, so they are passed as the real types.
function configured(version: string) {
  const updater = new (class extends EventEmitter {
    declare channel: string | null;
    declare allowPrerelease: boolean;
    declare allowDowngrade: boolean;
    updateDownloaded() {}
    checkForUpdates() { return Promise.resolve(null); }
  })();
  const timers: Timers = { setTimeout() {}, setInterval() {}, clearTimeout() {}, clearInterval() {} };
  createUpdates({
    updater: updater as unknown as Updater, squirrel: new EventEmitter() as unknown as Squirrel, app: { isPackaged: true }, version, feed: null,
    log: { info() {}, warn() {}, error() {}, debug() {} }, timers, onChange() {},
  });
  return { channel: updater.channel, allowPrerelease: updater.allowPrerelease, allowDowngrade: updater.allowDowngrade };
}

async function pick(version: string, site: { tags: string[]; latest: string }) {
  const settings = configured(version);
  const { executor, asked } = github(site);
  const provider = new GitHubProvider({ ...FEED }, { ...settings, currentVersion: version, fullChangelog: false },
    { executor, platform: 'darwin', isUseMultipleRangeRequest: false });
  const info = await provider.getLatestVersion();
  return { settings, info, asked };
}

// Stable 0.2.1 was published after two Nightlies of 0.2.1, so it is the newest entry in the feed.
const PROMOTED = { tags: ['v0.2.1', 'v0.2.1-nightly.20261110.2', 'v0.2.1-nightly.20261110.1', 'v0.2.0'], latest: 'v0.2.1' };

test('Nightly takes the newest Nightly release, not a Stable release published after it', async () => {
  const { settings, info, asked } = await pick('0.2.1-nightly.20261110.1', PROMOTED);
  assert.deepEqual(settings, { channel: 'nightly', allowPrerelease: true, allowDowngrade: false });
  assert.equal(info.tag, 'v0.2.1-nightly.20261110.2');
  assert.equal(info.version, '0.2.1-nightly.20261110.2');
  assert.deepEqual(asked, [`${BASE}.atom`, `${BASE}/download/v0.2.1-nightly.20261110.2/nightly-mac.yml`]);
});

test('with only Stable releases newer, Nightly finds its own newest release and nothing of Stable\'s', async () => {
  const { info, asked } = await pick('0.2.1-nightly.20261110.2', PROMOTED);
  assert.equal(info.tag, 'v0.2.1-nightly.20261110.2', 'the version it has, so electron-updater offers nothing');
  assert.ok(!asked.some((p) => p.includes('/v0.2.1/') || p.endsWith('latest-mac.yml') || p.endsWith('/latest')), asked.join(' '));
});

test('Nightly with no Nightly release published finds none, rather than a Stable one', async () => {
  await assert.rejects(pick('0.2.1-nightly.20261110.1', { tags: ['v0.2.1', 'v0.2.0'], latest: 'v0.2.1' }),
    (e: unknown) => (e as { code?: unknown }).code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS');
});

test('Stable takes the release GitHub marks latest, even when a Nightly is newer in the feed', async () => {
  const { settings, info, asked } = await pick('0.2.0', { tags: ['v0.2.2-nightly.20261111.1', 'v0.2.1', 'v0.2.0'], latest: 'v0.2.1' });
  assert.deepEqual(settings, { channel: 'latest', allowPrerelease: false, allowDowngrade: false });
  assert.equal(info.tag, 'v0.2.1');
  assert.deepEqual(asked, [`${BASE}.atom`, `${BASE}/latest`, `${BASE}/download/v0.2.1/latest-mac.yml`]);
});
