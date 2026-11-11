// Where T3 Code runs on this Mac, and whether it answers (docs/desktop-release-plan-v0_1.md, sections 4 and 5).
// T3 Code writes its address to ~/.t3/userdata/server-runtime.json when it starts (origin, port, serverVersion).
// YESCHEF_T3_ORIGIN overrides that file, and http://127.0.0.1:3773, T3 Code's own default, is the last resort.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_T3 = 'http://127.0.0.1:3773';
// The T3 Code version this Yes Chef was last tested with. An older T3 Code gets a note, never a refusal.
export const TESTED_T3 = '0.1.7';

/** Where T3 Code was found, and from what. */
export interface FoundT3 { origin: string; version: string | null; from: 'YESCHEF_T3_ORIGIN' | 'server-runtime.json' | 'default' }

/** { origin, version, from }: version is T3 Code's serverVersion when its own file named this origin, else null. */
export function findT3({ env = process.env, home = homedir(), read = (file: string) => readFileSync(file, 'utf8') }: {
  env?: NodeJS.ProcessEnv; home?: string; read?: (file: string) => string;
} = {}): FoundT3 {
  if (env.YESCHEF_T3_ORIGIN) return { origin: env.YESCHEF_T3_ORIGIN.replace(/\/+$/, ''), version: null, from: 'YESCHEF_T3_ORIGIN' };
  try {
    const d = JSON.parse(read(join(home, '.t3', 'userdata', 'server-runtime.json'))) as { origin?: unknown; serverVersion?: unknown };
    const u = new URL(String(d.origin));
    // Only a plain web address: no login in it, no path, nothing after it.
    if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash) {
      return { origin: u.origin, version: typeof d.serverVersion === 'string' ? d.serverVersion : null, from: 'server-runtime.json' };
    }
  } catch { /* no file, or one this Yes Chef cannot read: the default */ }
  return { origin: DEFAULT_T3, version: null, from: 'default' };
}

/** True when version a is older than b. Only the leading x.y.z counts; a version that has none is never older. */
export function older(a: unknown, b: unknown): boolean {
  const parts = (v: unknown) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '')) || []).slice(1).map(Number);
  const x = parts(a), y = parts(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
}

/** Whether T3 Code answers at origin: its sign-in metadata, within two seconds. */
export async function t3Answers(origin: string, { fetch: get = fetch, timeoutMs = 2000 }: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<boolean> {
  try {
    const r = await get(`${origin}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}
