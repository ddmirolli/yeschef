// What the board server inlines into the page script for an exported function: its source as Node gives it, with
// the types stripped and nothing else changed. Vitest re-prints TypeScript (quotes, comments), so a test that reads
// or runs that inlined source asks Node for it. Lives in client/test/, which the app build leaves out.
import { execFileSync } from 'node:child_process';

export function nodeSource(file: URL, name: string): string {
  const script = `const m = await import(${JSON.stringify(file.href)}); process.stdout.write(String(m[${JSON.stringify(name)}]));`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
}
