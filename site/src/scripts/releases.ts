export const REPO = 'ddmirolli/yeschef';
export const PAGE = `https://github.com/${REPO}/releases`;
export const API = `https://api.github.com/repos/${REPO}/releases`;
export const NIGHTLIES = `${PAGE}?q=nightly&expanded=true`;
export const PER_PAGE = 30;

export type Channel = 'stable' | 'nightly';
export interface Dmg { url: string; size: number; name: string; }
export type Release = Record<string, unknown>;
export type LookupResult =
  | { state: 'ok'; release: Release; dmg: Dmg }
  | { state: 'none' | 'error' | 'older' };
export interface ReleaseResponse { ok: boolean; status: number; json(): Promise<unknown>; }
export type FetchReleases = (url: string, init?: RequestInit) => Promise<ReleaseResponse>;
export type ReleaseStore = Pick<Storage, 'getItem' | 'setItem'>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function dmgOf(release: unknown): Dmg | null {
  if (!record(release) || !Array.isArray(release.assets)) return null;
  for (const asset of release.assets) {
    if (record(asset) && typeof asset.name === 'string' && /-arm64\.dmg$/.test(asset.name)
      && typeof asset.browser_download_url === 'string' && asset.browser_download_url) {
      return { url: asset.browser_download_url, size: typeof asset.size === 'number' ? asset.size : 0, name: asset.name };
    }
  }
  return null;
}

export function isNightly(tag: unknown): boolean {
  return typeof tag === 'string' && /-nightly\./.test(tag);
}

export function pickNightly(list: unknown): Release | null {
  if (!Array.isArray(list)) return null;
  return list.find((release: unknown): release is Release =>
    record(release) && !release.draft && isNightly(release.tag_name) && dmgOf(release) !== null) ?? null;
}

export async function lookup(channel: Channel, fetchImpl: FetchReleases, store: ReleaseStore | null): Promise<LookupResult> {
  const key = `yc.release.${channel}`;
  try {
    const kept = store?.getItem(key);
    const release: unknown = kept ? JSON.parse(kept) : null;
    const dmg = dmgOf(release);
    if (record(release) && dmg) return { state: 'ok', release, dmg };
  } catch { /* Storage can be blocked or contain an older answer. */ }

  try {
    const url = channel === 'nightly' ? `${API}?per_page=${PER_PAGE}` : `${API}/latest`;
    const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (response.status === 404) return { state: 'none' };
    if (!response.ok) return { state: 'error' };
    const body: unknown = await response.json();
    const release = channel === 'nightly' ? pickNightly(body) : body;
    const dmg = dmgOf(release);
    if (!record(release) || !dmg) {
      return { state: channel === 'nightly' && Array.isArray(body) && body.length >= PER_PAGE ? 'older' : 'none' };
    }
    try { store?.setItem(key, JSON.stringify(release)); } catch { /* Downloads also work without storage. */ }
    return { state: 'ok', release, dmg };
  } catch {
    return { state: 'error' };
  }
}
