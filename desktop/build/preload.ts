// The window's preload as Electron loads it. A sandboxed preload must be one CommonJS file with no imports, and
// Electron runs it as it is, so preload.cts (typed) becomes preload.cjs here with its types stripped by Node's own
// stripper. Each type becomes blanks, so lines and columns stay as in preload.cts. preload.cjs is never committed:
// `npm start` and `npm run capture` make it next to main.ts, and build/package.ts makes it in the app it builds.
//
//   node build/preload.ts            write desktop/preload.cjs
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');

/** preload.cts with its types stripped: the CommonJS the window runs. */
export function preloadCode(): string {
  return stripTypeScriptTypes(readFileSync(join(DESKTOP, 'preload.cts'), 'utf8'), { mode: 'strip' });
}

/** Write the preload to `out` (desktop/preload.cjs by default) and return its path. */
export function buildPreload(out = join(DESKTOP, 'preload.cjs')): string {
  writeFileSync(out, preloadCode());
  return out;
}

if (import.meta.main) console.log(`Wrote ${buildPreload()}`);
