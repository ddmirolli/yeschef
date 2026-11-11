// The public copy of this repository (Dan's ruling 1A, 2026-11-09: a fresh public repo from a clean copy of main).
//
//   node tools/public-tree.ts check          scan the files git tracks; exit 1 on any hit
//   node tools/public-tree.ts build OUT_DIR  write HEAD without PRIVATE into OUT_DIR, then scan it
//
// Node standard library only. It reads git and writes only OUT_DIR, which must not exist yet.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node tools/public-tree.ts check | build OUT_DIR';

/** Files that stay in the private archive. The public copy leaves them out. */
export const PRIVATE = new Set([
  'docs/team-brigade-brief-v0_1.md', // the pitch, private until Dan says otherwise
]);

/** What must never reach the public copy. Each rule: a name, then a pattern. */
const BANNED: [name: string, rx: RegExp][] = [
  // A tailnet: its tail<hex> name in any form (PR-Agent r2 on #63), or any <name>.ts.net host, including
  // word-style tailnet names such as yak-bebop (r3). The placeholders example.ts.net and <tailnet>.ts.net are fine.
  ['tailnet address', /\btail[0-9a-f]{6}\b/g],
  ['tailnet address', /\b(?!example\.)[A-Za-z0-9-]+\.ts\.net\b/g],
  // A real home folder or a path in it (r3: no trailing slash needed).
  // Placeholders are fine: chef, dan, me, someone, you, Shared and <name>.
  ['home path', /\/Users\/(?!(?:chef|dan|me|someone|you|Shared)(?![A-Za-z0-9._-])|<)[A-Za-z0-9._-]+/g],
  ['pitch name', /\bTheo\b/g],
  ['1Password reference', /\bop:\/\/[A-Za-z0-9]/g],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  // OpenAI and Anthropic, AWS, GitHub, Slack, Linear, Browserbase, and 1Password service account tokens.
  ['API key', new RegExp('\\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}'
    + '|xox[abprs]-[A-Za-z0-9-]{10,}|lin_api_[A-Za-z0-9]{20,}|bb_live_[A-Za-z0-9_-]{20,}|ops_[A-Za-z0-9+/=_-]{40,})', 'g')],
];
/** A match under these rules is never kept or printed, only its file, line and rule. */
const SECRET = new Set(['1Password reference', 'private key', 'API key']);

/** One banned match: file, line number, rule name, and the matched text, or "(hidden)" for a SECRET rule. */
export type Hit = [path: string, line: number, rule: string, text: string];

// Python's str.splitlines() boundaries, so line numbers match what an editor shows for every line ending.
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

/** Every banned match in one file. */
export function scanText(path: string, text: string): Hit[] {
  const hits: Hit[] = [];
  text.split(LINE_BREAK).forEach((raw, i) => {
    // Undo regex and JSON escapes first (\/ and \.), so every rule also sees escaped forms (PR-Agent r2 to r4 on #63).
    const line = raw.replaceAll('\\/', '/').replaceAll('\\.', '.');
    for (const [name, rx] of BANNED) {
      for (const m of line.matchAll(rx)) hits.push([path, i + 1, name, SECRET.has(name) ? '(hidden)' : m[0]]);
    }
  });
  return hits;
}

/** A file's bytes: binary files (a NUL in the first 8 KiB: images and icons) are skipped. */
export function scanBytes(path: string, data: Uint8Array): Hit[] {
  if (data.subarray(0, 8192).includes(0)) return [];
  return scanText(path, new TextDecoder('utf-8').decode(data));
}

function tracked(): string[] {
  return execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean);
}

/** Scans the given files under root (by default every file git tracks), leaving out PRIVATE ones and symlinks. */
export function check(root = ROOT, paths: string[] = tracked()): Hit[] {
  const hits: Hit[] = [];
  for (const p of paths) {
    if (PRIVATE.has(p)) continue;
    const full = join(root, p);
    let file = false;
    try { file = lstatSync(full).isFile(); } catch { /* missing: nothing to scan */ }
    if (file) hits.push(...scanBytes(p, readFileSync(full)));
  }
  return hits;
}

/** Writes HEAD's files, without PRIVATE ones and symlinks, into a new folder, then scans what it wrote. */
export function build(outDir: string): { files: string[]; hits: Hit[] } {
  if (existsSync(outDir)) throw new Error(`${outDir} already exists. Pick a new folder.`);
  // Each entry: "<mode> <type> <object>\t<path>". Mode 100644 and 100755 are files; 120000 symlinks and 160000
  // submodules are left out.
  const entries = execFileSync('git', ['-C', ROOT, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\0').filter(Boolean).map((e) => {
      const tab = e.indexOf('\t');
      const [mode = '', type = '', object = ''] = e.slice(0, tab).split(' ');
      return { mode, type, object, path: e.slice(tab + 1) };
    })
    .filter((e) => e.type === 'blob' && (e.mode === '100644' || e.mode === '100755') && !PRIVATE.has(e.path));
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  for (const e of entries) {
    const out = join(outDir, e.path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, execFileSync('git', ['-C', ROOT, 'cat-file', 'blob', e.object], { maxBuffer: 256 << 20 }));
    if (e.mode === '100755') chmodSync(out, 0o755);
    files.push(e.path);
  }
  return { files, hits: check(outDir, files) };
}

/** Prints the hits and returns the exit code. */
function report(hits: Hit[]): number {
  for (const [path, n, name, text] of hits) console.log(`${path}:${n}: ${name}: ${text}`);
  console.log(hits.length ? `${hits.length} banned matches.` : 'Clean: no banned matches.');
  return hits.length ? 1 : 0;
}

if (import.meta.main) {
  const [cmd, out, ...rest] = process.argv.slice(2);
  if (cmd === 'check') process.exit(report(check()));
  if (cmd === 'build' && out !== undefined && rest.length === 0) {
    let built: ReturnType<typeof build>;
    try { built = build(out); } catch (e) { console.error((e as Error).message); process.exit(1); }
    console.log(`Wrote ${built.files.length} files to ${out}, without ${[...PRIVATE].sort().join(', ')}.`);
    process.exit(report(built.hits));
  }
  console.error(USAGE);
  process.exit(1);
}
