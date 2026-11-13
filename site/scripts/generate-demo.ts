// Builds the site's live demo (site/demo/), the real Pass on a made-up kitchen, from the app in client/.
// Run it from the repo root after a change to the app's UI:  npm run demo:generate --prefix site -- [port]
//
// It copies the app's board, calls, kitchen, actions, you, open-kitchen and demo-team modules, and the client modules they import,
// to site/demo/lib/ unchanged, and the made-up projects' icons and screenshots from tools/hero-art/. Then it starts
// client/server.ts in a temp folder with a stand-in for client/t3mcp.ts that answers from the typed demo kitchen. It never signs in
// to T3 Code. It saves site/demo/app.html as an input to Astro; src/pages/demo/app.astro supplies the
// typed bootstrap. The generated snapshot is not a standalone page. It also saves site/demo/team.html, the same page with
// the made-up team below the visitor (client/demo-team.ts), drawn by the browser kitchen: the server has no team. Last, it
// draws the team's Too big PR (client/demo-diff.ts) through the app's diff pipe (client/diffs.ts) into public/demo/diff/,
// where the shim answers the page's /diff asks.
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const PORT = Number(process.argv[2] || 8690);
const DEMO = join(ROOT, 'site', 'demo');
const STATIC = join(ROOT, 'site', 'public', 'demo');
const ART = join(ROOT, 'tools', 'hero-art');
const DIRS: Record<string, string> = { 'p-pay': 'fernpay', 'p-loop': 'loopline', 'p-quill': 'quillo', 'p-ledger': 'ledgerly', 'p-pine': 'pinecast', 'p-orbit': 'orbitly' };

// The app modules stay unchanged. Astro supplies browser stand-ins for these Node imports.
const SHIMMED = new Set(['node:crypto', 'node:fs', 'node:path']);
// demo/lib holds only these copies, so a module the app no longer uses leaves with the next run.
rmSync(join(DEMO, 'lib'), { recursive: true, force: true });
mkdirSync(join(DEMO, 'lib'), { recursive: true });
// The list grows as it goes: each client module a copy imports is copied too.
const copy = ['board.ts', 'calls.ts', 'kitchen.ts', 'actions.ts', 'you.ts', 'open-kitchen.ts', 'demo-team.ts'];
for (const f of copy) {
  const src = readFileSync(join(ROOT, 'client', f), 'utf8');
  for (const m of src.matchAll(/^import [^;]*? from '([^']+)';/gm)) {
    const spec = m[1] ?? '';
    if (spec.startsWith('./')) { if (!copy.includes(spec.slice(2))) copy.push(spec.slice(2)); continue; }
    if (!SHIMMED.has(spec)) throw new Error(`client/${f} imports ${spec}: give it a stand-in in site/demo/lib first`);
  }
  writeFileSync(join(DEMO, 'lib', f), src);
}
mkdirSync(join(STATIC, 'icons'), { recursive: true });
mkdirSync(join(STATIC, 'img'), { recursive: true });
for (const dir of Object.values(DIRS)) copyFileSync(join(ART, 'icons', `${dir}.svg`), join(STATIC, 'icons', `${dir}.svg`));
for (const w of ['before', 'after']) for (const t of ['dark', 'light']) copyFileSync(join(ART, `payouts-${w}-${t}.png`), join(STATIC, 'img', `payouts-${w}-${t}.png`));

// 2. The server's page, from a copy of the app that reads the made-up kitchen.
const tmp = mkdtempSync(join(tmpdir(), 'yc-site-demo-'));
let server: ReturnType<typeof spawn> | null = null;
try {
  cpSync(join(ROOT, 'client'), join(tmp, 'client'), { recursive: true });
  for (const dir of Object.values(DIRS)) {
    mkdirSync(join(tmp, 'proj', dir), { recursive: true });
    copyFileSync(join(ART, 'icons', `${dir}.svg`), join(tmp, 'proj', dir, 'icon.svg'));
  }
  const kitchenUrl = pathToFileURL(join(ROOT, 'site', 'src', 'demo', 'kitchen.ts')).href;
  const { DEMO_RULES } = await import('../src/demo/kitchen.ts');
  writeFileSync(join(tmp, 'kitchen-rules.json'), JSON.stringify(DEMO_RULES));
  writeFileSync(join(tmp, 'client', 't3mcp.ts'), `// Stand-in written by site/scripts/generate-demo.ts: the made-up kitchen, never T3 Code.
import { createKitchen } from ${JSON.stringify(kitchenUrl)};
const kitchen = createKitchen({ where: (dir) => ({ workspaceRoot: ${JSON.stringify(join(tmp, 'proj'))} + '/' + dir, faviconPath: 'icon.svg' }),
  shot: (name) => name, later: null });
export async function signIn() { return { resource: 'demo', token: 'demo', scope: 'orchestration:read' }; }
export function connect() { return kitchen.t3; }
export { kitchen };
`);
  // The board reads its threads from T3 Code's live stream (client/t3live.ts). This stand-in hands the server the
  // same kitchen's threads as stream shells, the inverse of client/shells.ts threadRow; step 4 checks the result.
  writeFileSync(join(tmp, 'client', 't3live.ts'), `// Stand-in written by site/scripts/generate-demo.ts: the made-up kitchen as stream shells, never T3 Code.
import { kitchen } from './t3mcp.ts';
const LATER = '2999-01-01T00:00:00.000Z';
export function createKeys() { return { sweep: async () => 0, revokeMine: async () => 0 }; }
export function createLive({ onChange }) {
  let shells = [], up = false;
  const shell = async (t) => {
    const asks = (await kitchen.t3.call('t3_pending_request', { action: 'list', threadId: t.threadId })).requestIds || [];
    return { id: t.threadId, projectId: t.projectId, title: t.title, status: t.status, latestRunId: t.latestRunId,
      modelSelection: { model: t.model }, pullRequests: t.pullRequests.map((p) => ({ ...p, snapshot: { state: p.state } })),
      settledOverride: t.settled ? 'settled' : null, settledAt: t.settledAt ?? null, snoozedUntil: t.snoozed ? LATER : null,
      lineage: { parentThreadId: t.parentThreadId }, visibleItemCount: t.itemCount, createdAt: t.updatedAt, updatedAt: t.updatedAt,
      pendingRuntimeRequest: asks.length ? { id: asks[0] } : null };
  };
  return {
    async start() {
      const rows = [];
      for (const settled of [false, true]) rows.push(...(await kitchen.t3.call('t3_thread_list', { settled })).threads);
      shells = await Promise.all(rows.map(shell));
      up = true;
      onChange({ ids: [], live: true });
    },
    async stop() { up = false; },
    probe() {},
    live: () => up, why: () => 'the demo stream has not started', generation: () => 1, projectsRev: () => 1,
    threads: () => shells, project: () => null,
  };
}
`);
  // The server needs a page address and an allow list to start (#62). Nothing here sends, so both are placeholders.
  server = spawn(process.execPath, [join(tmp, 'client', 'server.ts'), 'https://t3.codes', String(PORT)], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, YESCHEF_RULES_FILE: join(tmp, 'kitchen-rules.json'), BRIGADE_PASS_ORIGIN: `http://127.0.0.1:${PORT}`, BRIGADE_ALLOW: '/dev/null' } });
  let log = '';
  server.stdout?.on('data', (d) => { log += d; });
  server.stderr?.on('data', (d) => { log += d; });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).status !== 200) continue;
      page = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    } catch { /* not up yet */ }
  }
  if (!page) throw new Error(`the app server did not start on ${PORT}:\n${log.slice(-2000)}`);

  // 3. The demo page: the server's page with the stand-ins first, and the browser's own addresses.
  const { createKitchen } = await import('../src/demo/kitchen.ts');
  const { imageId } = await import('../demo/lib/calls.ts');
  const head = '<meta name="robots" content="noindex">';
  let html = page.replace('<head><meta charset="utf-8">', (m) => m + head)
    .replace('<title>Yes Chef</title>', '<title>Yes Chef demo</title>');
  // Open in T3 goes to T3 Code's site: the made-up threads are nowhere in T3 Code.
  html = html.replace(/href="https:\/\/t3\.codes\/demo\/demo-\d+"/g, 'href="https://t3.codes/"');
  for (const [id, dir] of Object.entries(DIRS)) html = html.replaceAll(`/icon/${encodeURIComponent(id)}"`, `icons/${dir}.svg"`);
  for (const name of ['payouts-before', 'payouts-after']) html = html.replaceAll(`/img/${imageId(`/demo/${name}.png`)}"`, `img/${name}-dark.png"`);

  // 4. Checks: everything was found, and the browser's first render matches the server's board.
  for (const want of [head, 'Yes Chef demo']) if (!html.includes(want)) throw new Error(`app.html is missing ${want.slice(0, 60)}`);
  const left = html.match(/["(]\/(icon|img|act|events)\b[^"]*/g)?.filter((s) => !s.startsWith('"/act')) || [];
  if (left.length) throw new Error(`app.html still points at server routes: ${[...new Set(left)].join(', ')}`);
  const browser = createKitchen({ where: (dir) => ({ icon: `icons/${dir}.svg` }), shot: (name) => `img/${name}-dark.png`, later: null });
  // The same board, byte for byte, apart from what each render takes from the clock: form ids, the poll time (also
  // You's clock) and the rules' revision.
  const ids = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID').replace(/Checked [^"<]*?\(\d+ ms\)/g, 'Checked').replace(/"rev":\d+/g, '"rev":0')
    .replace(/<time[^>]*>[^<]*<\/time>/g, '<time>');
  const served = ids(html.slice(html.indexOf('<main id="app">') + 15, html.indexOf('</main>'))), drawn = ids(browser.page(''));
  if (served !== drawn) {
    let i = 0;
    while (served[i] === drawn[i]) i++;
    throw new Error(`the browser kitchen renders another board than the server did, at ${i}:\n${served.slice(Math.max(0, i - 80), i + 120)}\n${drawn.slice(Math.max(0, i - 80), i + 120)}`);
  }
  writeFileSync(join(DEMO, 'app.html'), html);
  console.log(`site/demo/app.html: ${html.length} bytes, ${browser.board().tickets.length} tickets`);

  // 5. The team demo (Dan, 2026-11-12): the same page, Dana's team below her in French Brigade (Dan, 2026-11-13). The modes section's
  // buttons on the home page switch it to Open kitchen (site/src/pages/demo/team.astro).
  const teamKitchen = createKitchen({ where: (dir) => ({ icon: `icons/${dir}.svg` }), shot: (name) => `img/${name}-dark.png`, later: null, team: 'brigade' });
  const main = html.indexOf('<main id="app">') + 15, end = html.indexOf('</main>');
  if (main < 15 || end < main) throw new Error('app.html has no <main id="app"> to draw the team into');
  const team = html.slice(0, main).replace('<title>Yes Chef demo</title>', '<title>Yes Chef for teams demo</title>') + teamKitchen.page('') + html.slice(end);
  for (const want of ['<title>Yes Chef for teams demo</title>', 'id="yc-team"', '"mode":"brigade"']) if (!team.includes(want)) throw new Error(`team.html is missing ${want}`);
  writeFileSync(join(DEMO, 'team.html'), team);
  console.log(`site/demo/team.html: ${team.length} bytes`);

  // 6. Too big's code (Dan, 2026-11-13: "pipe it in from t3"). The app's pipe reads a stand-in T3 Code that answers
  // /api/pull-requests/diff with the made-up patch, and its own route answers each ask. The files are those answers,
  // byte for byte: the PR's file list (<repo>-<n>.json), then each file's code by its place in the list (<repo>-<n>/<i>.json).
  const { demoDiff } = await import('../../client/demo-diff.ts');
  const { createDiffs, diffRoute } = await import('../../client/diffs.ts');
  const dd = demoDiff();
  const ask = `/diff?repo=${encodeURIComponent(dd.pr.repo)}&n=${dd.pr.n}`;
  // The page adds the PR's revision (&v=), which the demo's files do not depend on.
  if (!team.includes(`data-diff="${ask.replaceAll('&', '&amp;')}&amp;v=`)) throw new Error(`team.html has no diff panel asking ${ask}`);
  const fromT3 = async (): Promise<Response> => Response.json({ patch: dd.patch, truncated: true, nextCursor: null, omittedFileStats: dd.withheld });
  const diffs = createDiffs({ origin: 'http://t3.invalid', keys: { get: async () => 'demo', drop: () => {} }, project: () => 'demo', fetchImpl: fromT3 });
  const answer = async (url: string): Promise<string> => {
    const r = await diffRoute(new URL(url, 'http://demo.invalid'), { diffs, shown: () => [dd.pr] });
    if (r?.status !== 200) throw new Error(`the diff route answered ${r?.status} for ${url}: ${r?.body.slice(0, 200)}`);
    return r.body;
  };
  const out = join(STATIC, 'diff'), name = `${dd.pr.repo.replace('/', '-')}-${dd.pr.n}`;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, name), { recursive: true });
  const list = await answer(ask);
  const { files } = JSON.parse(list) as { files: { path: string }[] };
  writeFileSync(join(out, `${name}.json`), list);
  let size = list.length;
  for (const [i, f] of files.entries()) {
    const code = await answer(`${ask}&f=${encodeURIComponent(f.path)}`);
    writeFileSync(join(out, name, `${i}.json`), code);
    size += code.length;
  }
  console.log(`site/public/demo/diff/${name}: ${files.length} files, ${size} bytes`);
} finally {
  server?.kill();
  rmSync(tmp, { recursive: true, force: true });
}
