// Yes Chef's two release channels and their versions (docs/desktop-release-plan-v0_1.md, sections 5 and 6).
// Plain Node, no Electron: the app (main.mjs, updates.mjs) and the build scripts (build/*.mjs) share it.
//
// Stable and Nightly are two apps. Nightly has its own name, bundle ID, icon and package name, so it never shares
// Stable's data folder, Keychain item ("<name> Safe Storage") or update cache, and an update for one can never
// install over the other: Squirrel.Mac only installs a bundle that meets the running app's code requirement, which
// names its bundle ID. (T3 Code keeps one bundle ID for both and switches channels in its settings. Yes Chef has
// no channel switch, so two IDs cost nothing.)

// The update feed: GitHub Releases on the public source repo, as T3 Code's (ruling, 2026-11-09).
export const FEED = { provider: 'github', owner: 'ddmirolli', repo: 'yeschef' };

// `latest` is electron-updater's name for the stable channel: its feed file is latest-mac.yml.
export const CHANNELS = {
  latest: { label: 'Stable', name: 'Yes Chef', appId: 'codes.yeschef.desktop', pkg: 'yeschef-desktop', icon: 'icon.png' },
  nightly: { label: 'Nightly', name: 'Yes Chef (Nightly)', appId: 'codes.yeschef.desktop.nightly', pkg: 'yeschef-desktop-nightly', icon: 'icon-nightly.png' },
};

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
// T3 Code's form: <next patch>-nightly.<UTC date>.<run>, so the version alone names the channel.
const NIGHTLY = /^(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.([1-9]\d*)$/;

/** The channel a version belongs to: `nightly` for the nightly form, else `latest` (Stable, and local builds). */
export const channelOf = (version) => (NIGHTLY.test(String(version)) ? 'nightly' : 'latest');

/** True for the only two forms a release may take: 1.2.3 and 1.2.4-nightly.20261110.1. */
export const isReleaseVersion = (version) => STABLE.test(String(version)) || NIGHTLY.test(String(version));

/** The tag of a release, as T3 Code's: v<version>. The Nightly updater reads the channel from it, so it must be semver. */
export const tagOf = (version) => `v${version}`;

const parts = (v) => (STABLE.exec(v) || NIGHTLY.exec(v) || []).slice(1).map(Number);

/** Compare two release versions (semver order for these two forms): negative, zero or positive. */
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  if (!x.length || !y.length) throw new Error(`not a release version: ${x.length ? b : a}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  // A prerelease sorts before its release: 1.2.4-nightly.* < 1.2.4.
  if (x.length !== y.length) return x.length === 3 ? 1 : -1;
  return x.length === 3 ? 0 : (x[3] - y[3]) || (x[4] - y[4]);
}

/** YYYYMMDD in UTC, as T3 Code's nightly dates. */
export const utcDay = (date) => date.toISOString().slice(0, 10).replace(/-/g, '');

/**
 * The next Nightly version. Its base is the patch after the highest stable version known (package.json and the
 * releases already published), as T3 Code's; its run number is one more than any Nightly of that base and day in
 * `taken` (versions or tags of the releases on GitHub, drafts included).
 */
export function nextNightly({ stable, taken = [], date = new Date() }) {
  const known = stable.filter((v) => STABLE.test(v));
  if (!known.length) throw new Error('no stable version to build a Nightly on');
  const top = known.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  const [major, minor, patch] = parts(top);
  const prefix = `${major}.${minor}.${patch + 1}-nightly.${utcDay(date)}.`;
  const runs = taken.map((t) => String(t).replace(/^v/, '')).filter((v) => v.startsWith(prefix) && NIGHTLY.test(v)).map((v) => parts(v)[4]);
  return prefix + (Math.max(0, ...runs) + 1);
}
