// The board page as the server sends it: server.ts holds its HTML and CSS, page.ts its script. Node strips the types
// and leaves spaces where they were, so a test's pattern for a typed line allows the spaces (\s*). Vitest re-prints
// TypeScript, so a test that reads or runs the page's source reads it here. Lives in client/test/, which the app
// build leaves out.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const stripped = (name: string): string => stripTypeScriptTypes(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'), { mode: 'strip' });

/** client/page.ts with its types stripped: the page script as the browser runs it. */
export function pageScript(): string {
  return stripped('page.ts');
}

/** client/server.ts with its types stripped, then the page script: everything the page is made of. */
export function servedSource(): string {
  return stripped('server.ts') + '\n' + pageScript();
}
