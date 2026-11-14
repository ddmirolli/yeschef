// Yes Chef's two release channels and their versions (docs/desktop-release-plan-v0_1.md, sections 5 and 6).
// Plain Node, no Electron: the app (main.ts, updates.ts) and the build scripts (build/*.ts) share it.
//
// Stable and Nightly are one app, as in T3 Code (Dan, 2026-11-14: "copy and build that in ours"): one name, bundle ID,
// data folder, Keychain item and update cache, and a Nightly build differs only by its icon and its version. Settings
// for the track live in the app menu (Update Track); switching downloads the other track's newest build and restarts
// into it (updates.ts setChannel). Squirrel.Mac installs only a bundle that meets the running app's code requirement,
// which names the bundle ID and the team, so one bundle ID is what lets the two builds replace each other.

// The update feed: GitHub Releases on the public source repo, as T3 Code's (ruling, 2026-11-09).
export const FEED = { provider: 'github', owner: 'ddmirolli', repo: 'yeschef' } as const;

// `latest` is electron-updater's name for the stable channel: its feed file is latest-mac.yml.
/** One channel's app: its name, bundle ID, package name and icon. */
export interface Channel { label: string; name: string; appId: string; pkg: string; icon: string }
export type ChannelName = 'latest' | 'nightly';
/** True for a saved track: only these two words. */
export const isChannel = (v: unknown): v is ChannelName => v === 'latest' || v === 'nightly';
export const CHANNELS: Record<ChannelName, Channel> = {
  latest: { label: 'Stable', name: 'Yes Chef', appId: 'codes.yeschef.desktop', pkg: 'yeschef-desktop', icon: 'icon.png' },
  nightly: { label: 'Nightly', name: 'Yes Chef', appId: 'codes.yeschef.desktop', pkg: 'yeschef-desktop', icon: 'icon-nightly.png' },
};

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
// T3 Code's form: <next patch>-nightly.<UTC date>.<run>, so the version alone names the channel.
const NIGHTLY = /^(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.([1-9]\d*)$/;

/** The channel a version belongs to: `nightly` for the nightly form, else `latest` (Stable, and local builds). */
export const channelOf = (version: unknown): ChannelName => (NIGHTLY.test(String(version)) ? 'nightly' : 'latest');

/** True for the only two forms a release may take: 1.2.3 and 1.2.4-nightly.20261110.1. */
export const isReleaseVersion = (version: unknown): boolean => STABLE.test(String(version)) || NIGHTLY.test(String(version));

/** The tag of a release, as T3 Code's: v<version>. The Nightly updater reads the channel from it, so it must be semver. */
export const tagOf = (version: string): string => `v${version}`;

const parts = (v: string): number[] => (STABLE.exec(v) || NIGHTLY.exec(v) || []).slice(1).map(Number);

/** Compare two release versions (semver order for these two forms): negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  if (!x.length || !y.length) throw new Error(`not a release version: ${x.length ? b : a}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  // A prerelease sorts before its release: 1.2.4-nightly.* < 1.2.4.
  if (x.length !== y.length) return x.length === 3 ? 1 : -1;
  return x.length === 3 ? 0 : (x[3]! - y[3]!) || (x[4]! - y[4]!);
}

/** YYYYMMDD in UTC, as T3 Code's nightly dates. */
export const utcDay = (date: Date): string => date.toISOString().slice(0, 10).replace(/-/g, '');

/**
 * The next Nightly version. Its base is the patch after the highest stable version known (package.json and the
 * releases already published), as T3 Code's; its run number is one more than any Nightly of that base and day in
 * `taken` (versions or tags of the releases on GitHub, drafts included).
 */
export function nextNightly({ stable, taken = [], date = new Date() }: { stable: string[]; taken?: unknown[]; date?: Date }): string {
  const known = stable.filter((v) => STABLE.test(v));
  if (!known.length) throw new Error('no stable version to build a Nightly on');
  const top = known.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  const [major, minor, patch] = parts(top) as [number, number, number];
  const prefix = `${major}.${minor}.${patch + 1}-nightly.${utcDay(date)}.`;
  const runs = taken.map((t) => String(t).replace(/^v/, '')).filter((v) => v.startsWith(prefix) && NIGHTLY.test(v)).map((v) => parts(v)[4]!);
  return prefix + (Math.max(0, ...runs) + 1);
}
