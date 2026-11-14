// The section 2 checks on a built or downloaded Yes Chef (docs/desktop-release-plan-v0_1.md):
//
//   npm run check -- "<path>/Yes Chef.app" [--release]
//   npm run check -- <path>/Yes-Chef-<version>-arm64.dmg [--release]
//
// A DMG is checked itself, then mounted read-only and the one app inside it checked (Yes Chef.app, for
// Stable and Nightly alike). hdiutil's output, and its deprecation warning on macOS 27, are not shown. --release adds the checks only a
// notarized Developer ID build passes: the Developer ID authority, Gatekeeper and the stapled tickets.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkApp, checkDmg, report } from './release.ts';

const release = process.argv.includes('--release');
const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!target || !existsSync(target)) { console.error('Usage: npm run check -- <Yes Chef.app or .dmg> [--release]'); process.exit(2); }
const path = resolve(target);

let ok: boolean;
if (path.endsWith('.dmg')) {
  const results = checkDmg(path, { release });
  const mount = mkdtempSync(join(tmpdir(), 'yeschef-dmg-'));
  execFileSync('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path], { stdio: 'ignore' });
  try {
    const apps = readdirSync(mount).filter((f) => f.endsWith('.app'));
    if (apps.length === 1) results.push(...(await checkApp(join(mount, apps[0]!), { release })));
    else results.push({ name: 'one app in the DMG', ok: false, detail: apps.join(', ') || 'none' });
  }
  finally { execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'ignore' }); rmSync(mount, { recursive: true, force: true }); }
  ok = report(results);
} else {
  ok = report(await checkApp(path, { release }));
}
process.exit(ok ? 0 : 1);
