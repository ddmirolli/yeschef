// The made-up team the site's demo runs (Dan, 2026-11-12: "build some notional team data so that our site can
// showcase the updated app UI/UX from both open kitchen, french brigade, and solo perspectives"; language 1A: strict
// TypeScript in client/, on the summary types). Dana leads a team of 14 on the solo demo's three products, so her own
// You view and her team's views tell one story. Every time is relative to `now`, so the demo never ages.
//
// Each teammate's summary has the shape client/team-summaries.ts summarize() sends, and the whole has the shape of
// client/team.ts View. This file cannot import those (the site copies it, and team.ts reaches the relay and the seals),
// so it spells the shapes out below and client/demo-team.test.ts checks them against the real types: a change to what
// a Mac sends fails the typecheck until the demo follows.
import { callId, type TeamView } from './open-kitchen.ts';
import { cleanTeamRules, type AreaRules, type TeamRules } from './team-rules.ts';

type Range = [number, number];
/** A changed file as summaryChanges() sends it. */
export type DemoFile = { p: string; r: Range[] | null; a: number | null; d: number | null; x?: 1 };
/** A PR as summaryPr() sends it. */
export type DemoPr = { repo: string; n: number; state: string; url: string | null; base: string | null; draft: boolean | null; mergedAt: number | null;
  size?: { files: number | null; added: number | null; removed: number | null; at: number | null; overAt?: number } | null; readyAt?: number | null;
  checks?: { result: string | null; redRuns: number | null; at: number | null; runs: { at: number | null; sha: string | null; title: string | null; result: string | null }[] } | null;
  reviewers?: { who: string; team: boolean; state: 'requested' | 'approved' | 'changes' | 'commented'; at: number | null }[] | null; mergeSha?: string | null };
/** A ticket as the summary sends it. */
export type DemoTicket = { thread: string; title: string; project: string; place: string; atPass: boolean; working: number; asks: number; call: boolean;
  prs: DemoPr[]; updatedAt: string | null; startedAt: number | null; last: string | null;
  /** Its feature, as a dev's Yes Chef reads it from Linear (step 7): null for tickets in no project. */
  feature?: { id: string; name: string } | null;
  blocked?: { id: string; title: string | null; at: number }[];
  ask: { at: number | null; q: string; rec: string | null; n: number; options: { k: string | null; t: string | null }[] } | null;
  changes?: { state: 'checked'; at: number | null; repo: string | null; base: string | null; mergeBase: string | null; head: string | null; headAt: number | null;
    files: DemoFile[]; more: number; size: { files: number | null; added: number | null; removed: number | null } } };
/** A base branch's checks as summaryBase() sends it. */
export type DemoBase = { repo: string | null; branch: string | null; sha: string | null; title: string | null; committedAt: number | null; result: string | null;
  requiredResult: string | null; redSha: string | null; redSince: number | null; failing: string[]; at: number | null };
/** One teammate's summary: summarize()'s result, with when it was made and the Mac's health. */
export type DemoFeature = { id: string; name: string; lead?: string | null; leadAt?: number; list?: { n: number; closed: number; unread: number; at: number };
  threads: { n: number; merged: number } };
export type DemoSummary = { v: number; tickets: DemoTicket[]; more: number; gh: string | null; bases: DemoBase[]; seen: Record<string, number>; fine: Record<string, number>;
  features: DemoFeature[]; ships: Record<string, number>;
  at: number; health: { ok: boolean | null; since: number | null } };
type Role = 'lead' | 'deputy' | 'owner' | 'engineer' | 'viewer';
type Perm = 'see' | 'reply' | 'projects' | 'merge' | 'invite' | 'rules';
export type DemoPerson = { id: string; name: string; role: Role; perms: Perm[]; area: string | null; under: string | null;
  online: boolean; summary: DemoSummary | null; at: number | null; live: boolean; notCheckedSince: number | null };
export type DemoTeam = TeamView & { status: 'member'; link: 'online'; linkAt: number; team: string; teamName: string; unsaved: boolean;
  me: { id: string; name: string; role: Role; perms: Perm[]; area: string | null; under: string | null };
  lead: boolean; leadName: string; code: string | null; asked: string[]; areas: AreaRules[]; rules: TeamRules; people: DemoPerson[];
  pending: never[]; invites: never[] };

const MIN = 60000, HOUR = 60 * MIN;
/** The solo demo's three products (site/src/demo/kitchen.ts), by the names its board shows. */
const REPO = { Fernpay: 'fernpay/fernpay', Loopline: 'loopline/dispatch', Quillo: 'quillo/quillo' } as const;
type Project = keyof typeof REPO;

/** The team at `now`. Nine calls rise, as a lead would meet them: main broken by a merge, two threads in one file, red
 *  checks (one held by its dev), a PR too big to review, a quiet thread, a question from a dev whose Mac is away, a
 *  thread blocked by an open ticket, and a feature whose every ticket is done.
 *  Everyone else's threads are calm: each has a fresh message, passing checks and its own files. */
export function demoTeam(now: number): DemoTeam {
  const ago = (m: number) => now - m * MIN, iso = (m: number) => new Date(ago(m)).toISOString();
  const login = (id: string) => `${id}-codes`;
  // Who each person reports to (French Brigade's ladder): Dana leads Kai and Maya; Kai leads Priya and Nina; Priya leads
  // Jon, Ada, Omar and Ben; Maya leads Sam, Lee and Tom; Sam leads Iris, Ravi and Elena.
  const under: Record<string, string> = { kai: 'me', maya: 'me', priya: 'kai', nina: 'kai', jon: 'priya', ada: 'priya', omar: 'priya', ben: 'priya',
    sam: 'maya', lee: 'maya', tom: 'maya', iris: 'sam', ravi: 'sam', elena: 'sam' };
  // The people a PR climbs before it merges: every lead above its author but the last, who merges.
  const ladder = (id: string) => { const up: string[] = []; for (let x = under[id]; x && x !== 'me'; x = under[x]) up.push(x); return up.length > 1 ? up.slice(0, -1) : up; };

  const pr = (project: Project, n: number, state: 'open' | 'merged', more: Partial<DemoPr> = {}): DemoPr => ({ repo: REPO[project], n, state,
    url: `https://github.com/${REPO[project]}/pull/${n}`, base: 'main', draft: false, mergedAt: null, ...more });
  // Each run is on its own commit: `commits` names them, oldest first, as [title, sha].
  const runs = (greens: number, reds: number, from: number, every: number, commits: readonly (readonly [string, string])[] = []) => [...Array(greens + reds)].map((_, i) => ({
    at: ago(from - i * every), sha: commits[i]?.[1] ?? `c${n6(i)}`, title: commits[i]?.[0] ?? `run ${i + 1}`, result: i < greens ? 'passing' : 'failing' }));
  const passing = (m: number) => ({ result: 'passing', redRuns: 0, at: ago(m), runs: runs(3, 0, m + 40, 20) });
  const changes = (project: Project, files: DemoFile[], headAt = 4): NonNullable<DemoTicket['changes']> => ({ state: 'checked', at: ago(1), repo: REPO[project], base: 'main',
    mergeBase: 'b0c1d2e', head: 'f3e4d5c', headAt: ago(headAt), files, more: 0,
    size: { files: files.length, added: files.reduce((s, f) => s + (f.x ? 0 : f.a ?? 0), 0), removed: files.reduce((s, f) => s + (f.x ? 0 : f.d ?? 0), 0) } });
  const t = (thread: string, project: Project, place: string, title: string, more: Partial<DemoTicket> = {}): DemoTicket => ({ thread, title, project, place,
    atPass: false, working: place === 'In progress' ? 1 : 0, asks: 0, call: false, prs: [], updatedAt: iso(3), startedAt: ago(240), last: null, ask: null, ...more });

  // ---- The calls ----
  const mainRed = ago(141);
  const ravi = [t('mcp:ravi-1', 'Fernpay', 'Merged', 'Payout batch scheduler', { startedAt: ago(420),
      prs: [pr('Fernpay', 431, 'merged', { mergedAt: mainRed, mergeSha: 'f431a0c', size: { files: 7, added: 186, removed: 24, at: mainRed } })] }),
    t('mcp:ravi-2', 'Fernpay', 'In progress', 'Fix the payout scheduler test', { working: 2, startedAt: ago(125), updatedAt: iso(2),
      last: 'The scheduler test assumed UTC midnight. Pinning the clock and rerunning the suite.' })];
  const ravisBase: DemoBase = { repo: REPO.Fernpay, branch: 'main', sha: 'f431a0c', title: 'Payout batch scheduler (#431)', committedAt: mainRed, result: 'failing',
    requiredResult: 'failing', redSha: 'f431a0c', redSince: mainRed, failing: ['test:payouts'], at: ago(2) };
  const kai = t('mcp:kai-1', 'Loopline', 'In review', 'Driver ETA on the dispatch map', { working: 3, startedAt: ago(390),
    prs: [pr('Loopline', 412, 'open', { readyAt: ago(128), checks: passing(20), size: { files: 6, added: 240, removed: 31, at: ago(3) },
      reviewers: [{ who: login('me'), team: false, state: 'requested', at: null }] })],
    changes: changes('Loopline', [{ p: 'packages/routing/src/eta.ts', r: [[118, 170], [300, 318]], a: 61, d: 9 }, { p: 'apps/web/src/map/DriverCard.tsx', r: [[10, 40]], a: 30, d: 2 }]) });
  const jon = t('mcp:jon-1', 'Loopline', 'In progress', 'Group stops by delivery zone', { working: 2, startedAt: ago(303),
    prs: [pr('Loopline', 415, 'open', { draft: true })],
    changes: changes('Loopline', [{ p: 'packages/routing/src/eta.ts', r: [[120, 168], [204, 231], [380, 392]], a: 80, d: 12 }, { p: 'packages/routing/src/zones.ts', r: [[1, 90]], a: 90, d: 0 }]) });
  const nina = t('mcp:nina-1', 'Quillo', 'In review', 'Offline drafts sync', { working: 2,
    prs: [pr('Quillo', 428, 'open', { readyAt: ago(236), size: { files: 9, added: 310, removed: 44, at: ago(5) }, checks: { result: 'failing', redRuns: 6, at: ago(5), runs: runs(4, 6, 233, 20, NINA) },
      reviewers: [{ who: login('kai'), team: false, state: 'commented', at: ago(90) }] })] });
  const ben = t('mcp:ben-1', 'Fernpay', 'In progress', 'Refund webhook signatures', {
    prs: [pr('Fernpay', 436, 'open', { checks: { result: 'failing', redRuns: 3, at: ago(2), runs: runs(2, 3, 50, 10, BEN) } })] });
  const iris = t('mcp:iris-1', 'Fernpay', 'In review', 'Export statements to CSV', { startedAt: ago(51),
    prs: [pr('Fernpay', 440, 'open', { readyAt: ago(44), checks: passing(9), size: { files: 41, added: 1079, removed: 161, at: ago(3), overAt: ago(51) },
      reviewers: [{ who: login('sam'), team: false, state: 'approved', at: ago(20) }, { who: 'coderabbitai[bot]', team: false, state: 'commented', at: ago(40) }] })],
    changes: changes('Fernpay', [...IRIS.map(([p, a, d]): DemoFile => ({ p, r: [[1, a]], a, d })), { p: 'pnpm-lock.yaml', r: [[1, 2104]], a: 2104, d: 0, x: 1 }]) });
  const omar = t('mcp:omar-1', 'Loopline', 'In progress', 'Expire stale dispatch offers', { working: 2, updatedAt: iso(38),
    last: 'Running the expiry migration against the staging copy. On about 180,000 offers it can take a while.',
    prs: [pr('Loopline', 421, 'open', { draft: true, checks: { result: 'passing', redRuns: 0, at: ago(53), runs: runs(3, 0, 80, 13) } })],
    changes: changes('Loopline', [{ p: 'packages/offers/migrations/0042_expiry.sql', r: [[1, 40]], a: 40, d: 0 }], 61) });
  const lee = t('mcp:lee-1', 'Quillo', 'In progress', 'Sync retries while offline', { updatedAt: iso(131), asks: 1,
    ask: { at: ago(131), q: 'A sync fails while the laptop is asleep. How should it retry?', rec: 'b', n: 1, options: [
      { k: 'a', t: 'Retry forever, backing off to once every 5 min' }, { k: 'b', t: 'Stop after 5 tries and show the draft as not synced' },
      { k: 'c', t: 'Wait until the app is open again' }] } });

  // ---- Everyone's calm threads: a fresh message, passing checks, files of their own, and the ladder's reviews ----
  const WORK: Record<Project, string[]> = {
    Fernpay: ['Payout limits per merchant', 'Invoice PDF footer', 'Currency rounding rules', 'Dispute evidence upload', 'Card update emails', 'Settlement report filters', 'Tax ID check', 'Ledger export speed'],
    Loopline: ['Driver shift handoff', 'Proof of delivery photos', 'Route replay', 'Depot opening hours', 'Customer ETA texts', 'Late delivery alerts', 'Vehicle capacity check', 'Stop notes for drivers'],
    Quillo: ['Mentions in comments', 'Shared notebook links', 'Search highlights', 'Template gallery', 'Focus mode', 'Version history list', 'Paste from Docs', 'Word count goals'],
  };
  const HOME: Record<string, Project> = { kai: 'Loopline', jon: 'Loopline', ada: 'Loopline', omar: 'Loopline', priya: 'Fernpay', ben: 'Fernpay', iris: 'Fernpay', ravi: 'Fernpay',
    sam: 'Fernpay', maya: 'Fernpay', nina: 'Quillo', lee: 'Quillo', tom: 'Quillo', elena: 'Quillo' };
  // The order each person's calm threads take through the stages: most in progress, a few in review, one ready, some merged.
  const PLACES = ['In progress', 'In review', 'In progress', 'Merged', 'Ready to merge', 'In progress', 'In review', 'Merged', 'Planned'];
  const COUNT: Record<string, number> = { kai: 4, maya: 5, priya: 6, nina: 5, jon: 6, ada: 7, omar: 5, ben: 6, sam: 6, lee: 3, tom: 4, iris: 6, ravi: 5, elena: 7 };
  let n = 500;
  const calm = (id: string): DemoTicket[] => {
    const home = HOME[id]!, side: Project = home === 'Fernpay' ? 'Loopline' : home === 'Loopline' ? 'Quillo' : 'Fernpay';
    return Array.from({ length: COUNT[id] ?? 4 }, (_, i) => {
      const project = i % 3 === 2 ? side : home, place = PLACES[i % PLACES.length]!, num = n++;
      const title = WORK[project][(id.charCodeAt(0) + i * 3) % WORK[project].length]!;
      const age = place === 'In progress' ? 2 + ((i * 7 + id.length) % 15) : 60 * (1 + ((i * 5 + id.charCodeAt(1)) % 30));
      const file = `${project === 'Fernpay' ? 'packages/payments' : project === 'Loopline' ? 'packages/dispatch' : 'apps/editor'}/src/${id}/${title.toLowerCase().replace(/[^a-z]+/g, '-')}.ts`;
      const lines = 40 + ((i * 37 + id.length * 11) % 260);
      const signers = ladder(id);
      const reviewers: DemoPr['reviewers'] = place === 'Ready to merge' ? signers.map((who) => ({ who: login(who), team: false, state: 'approved', at: ago(age + 30) }))
        : place === 'In review' && i % 2 && signers.length > 1 ? [{ who: login(signers[0]!), team: false, state: 'approved', at: ago(age + 10) }] : [];
      const open = place === 'In review' || place === 'Ready to merge' || (place === 'In progress' && i % 2 === 1);
      const prs = place === 'Merged' ? [pr(project, num, 'merged', { mergedAt: ago(age), mergeSha: `m${num}` })]
        : open ? [pr(project, num, 'open', { draft: place === 'In progress', readyAt: place === 'In progress' ? null : ago(age + 15), checks: passing(Math.min(age, 12)),
          size: { files: 2 + (i % 5), added: lines, removed: Math.round(lines / 4), at: ago(2) }, reviewers })] : [];
      const k = t(`mcp:${id}-c${i}`, project, place, title, { prs, updatedAt: iso(age), startedAt: ago(age + 90 + i * 25), working: place === 'In progress' ? 1 + (i % 3) : 0,
        last: place === 'In progress' ? 'Tests pass locally. Pushing the next commit.' : null });
      if (place === 'In progress') k.changes = changes(project, [{ p: file, r: [[1, lines]], a: lines, d: Math.round(lines / 4) }], Math.max(1, age - 1));
      return k;
    });
  };

  const story: Record<string, DemoTicket[]> = { ravi, kai: [kai], jon: [jon], nina: [nina], ben: [ben], iris: [iris], omar: [omar], lee: [lee] };
  const NAMES: [string, string][] = [['kai', 'Kai'], ['maya', 'Maya'], ['priya', 'Priya'], ['nina', 'Nina'], ['jon', 'Jon'], ['ada', 'Ada'], ['omar', 'Omar'],
    ['ben', 'Ben'], ['sam', 'Sam'], ['lee', 'Lee'], ['tom', 'Tom'], ['iris', 'Iris'], ['ravi', 'Ravi'], ['elena', 'Elena']];
  // Seen, as each dev's Yes Chef sends it: Ravi has seen main break, Kai the overlap, Nina and Ben their red checks.
  const seen: Record<string, Record<string, number>> = {
    ravi: { [callId('main', `${REPO.Fernpay}@main`, mainRed)]: ago(4) },
    kai: { [callId('overlap', 'mcp:jon-1+mcp:kai-1', ago(303))]: ago(18) },
    nina: { [callId('failing', `mcp:nina-1:${REPO.Quillo}#428`, ago(233 - 4 * 20))]: ago(17) },
    ben: { [callId('failing', `mcp:ben-1:${REPO.Fernpay}#436`, ago(50 - 2 * 10))]: ago(25) },
  };
  // The areas, as a lead sets them in Settings -> Rules (the mock Dan approved, 2026-11-13): Kai and Maya own the two
  // products, Priya the code they share, which runs in French Brigade.
  const OWNS: Record<string, string> = { kai: 'a-pay', maya: 'a-dispatch', priya: 'a-shared' };
  const areas: AreaRules[] = [
    { id: 'a-pay', name: 'Payments', projects: ['Fernpay'], mode: 'open', budget: 10 },
    { id: 'a-dispatch', name: 'Dispatch', projects: ['Loopline'], mode: 'open', budget: 10 },
    { id: 'a-shared', name: 'Shared code', projects: ['Fernpay', 'Loopline', 'Quillo'], mode: 'brigade', budget: 10 },
  ];
  // Each product's Linear projects, the features French Brigade groups by; about one ticket in seven is in none.
  const FEATURES: Record<Project, { id: string; name: string }[]> = {
    Fernpay: [{ id: 'f-payouts', name: 'Payouts v2' }, { id: 'f-merchant', name: 'Merchant tools' }],
    Loopline: [{ id: 'f-dispatch', name: 'Dispatch map' }, { id: 'f-driver', name: 'Driver app' }],
    Quillo: [{ id: 'f-offline', name: 'Offline sync' }, { id: 'f-sharing', name: 'Sharing' }],
  };
  // Receipts is done (step 7 PR 2): Priya's, Sam's and Iris's merged Fernpay threads are its whole list, every ticket
  // closed, and Priya leads it in Linear, so it rises as Ready for your look with Ship to Priya's agent.
  const RECEIPTS = { id: 'f-receipts', name: 'Receipts' }, DONE = new Set(['mcp:priya-c3', 'mcp:sam-c3', 'mcp:iris-c3']);
  // Elena's first thread waits on a Quillo ticket still open (Blocked).
  const BLOCKED: Record<string, NonNullable<DemoTicket['blocked']>> = { 'mcp:elena-c0': [{ id: 'QUI-212', title: 'Sync conflict rules', at: ago(45) }] };
  const withFeature = (k: DemoTicket): DemoTicket => {
    const sum = [...k.title].reduce((a, ch) => a + ch.charCodeAt(0), 0);
    return { ...k, feature: DONE.has(k.thread) ? RECEIPTS : sum % 7 === 0 ? null : FEATURES[k.project as Project][sum % 2]!, ...(BLOCKED[k.thread] ? { blocked: BLOCKED[k.thread]! } : {}) };
  };
  // What Priya's agents read of Receipts in Linear; each dev's summary counts their own threads per feature.
  const read: Record<string, Partial<DemoFeature>> = { priya: { lead: 'Priya', leadAt: ago(6), list: { n: 3, closed: 3, unread: 0, at: ago(5) } } };
  const featuresOf = (id: string, tickets: DemoTicket[]): DemoFeature[] => [...new Map(tickets.flatMap((k) => (k.feature ? [[k.feature.id, k.feature] as const] : []))).values()].map((f) => {
    const on = tickets.filter((k) => k.feature?.id === f.id);
    return { ...f, ...(f.id === RECEIPTS.id ? read[id] : {}), threads: { n: on.length, merged: on.filter((k) => k.place === 'Merged').length } };
  });
  const people: DemoPerson[] = NAMES.map(([id, name]) => {
    const away = id === 'lee';
    const tickets = [...(story[id] ?? []), ...calm(id)].map(withFeature);
    return { id, name, role: OWNS[id] ? 'owner' : 'engineer', perms: ['see'], area: OWNS[id] ?? null, under: under[id] ?? null,
      online: !away, at: away ? ago(122) : ago(1), live: !away, notCheckedSince: away ? ago(112) : null,
      summary: { v: 1, tickets, more: 0, gh: login(id), bases: id === 'ravi' ? [ravisBase] : [], seen: seen[id] ?? {}, fine: {}, ships: {}, features: featuresOf(id, tickets), at: away ? ago(122) : ago(1), health: { ok: true, since: ago(600) } } };
  });
  const me = { id: 'me', name: 'Dana', role: 'lead' as const, perms: ['see', 'reply', 'projects', 'merge', 'invite', 'rules'] as Perm[], area: null, under: null };
  return {
    status: 'member', link: 'online', linkAt: now - 5 * HOUR, team: 't-demo', teamName: 'Platform', unsaved: false, me, lead: true, leadName: 'Dana', code: null, asked: [], areas, rules: cleanTeamRules(null),
    people: [{ ...me, online: true, summary: null, at: null, live: false, notCheckedSince: null }, ...people], pending: [], invites: [],
  };
}

// The commits behind the red checks, oldest first: the runs that passed, the change that went red, then the agent's
// fixes, each run on its own commit.
const NINA = [['Store drafts in IndexedDB', '5e2f9a1'], ['Read drafts from the local store first', '8c03d4b'], ['Show the offline badge on drafts', '2b7e610'],
  ['Sync drafts when the app comes back online', 'd94c3f7'], ['Queue drafts in IndexedDB while offline', 'a41c9e2'], ['Wait for the queue to flush in the sync test', '7d02b18'],
  ['Mock the network clock in sync tests', 'c95e4a0'], ['Retry the flush on reconnect', '3b8f611'], ['Raise the sync test timeout to 30 s', 'e0d7c53'],
  ['Skip the offline flush test on CI', '91fa3d6']] as const;
const BEN = [['Verify refund webhook signatures', '4f1a8e2'], ['Reject unsigned refund webhooks', 'b72c05d'], ['Read the signing secret per merchant', '6e93d1a'],
  ['Use the raw body for the signature check', 'c18f47b'], ['Compare signatures in constant time', '0a5d2e9']] as const;
/** Iris's CSV export: all 41 files her PR counts (+1,079 -161), as [path, added, removed]. The lockfile is apart. */
export const IRIS: readonly (readonly [string, number, number])[] = [
  ...([['columns', 62, 8], ['currency', 34, 6], ['dates', 22, 4], ['escape', 28, 4], ['format', 96, 30], ['headers', 18, 2], ['index', 8, 2], ['locale', 16, 3],
    ['rows', 120, 18], ['stream', 40, 6], ['totals', 20, 3], ['writer', 26, 4]] as const).map(([f, a, d]) => [`packages/statements/src/csv/${f}.ts`, a, d] as const),
  ...([['columns', 34], ['currency', 22], ['dates', 18], ['empty', 10], ['escape', 30], ['format', 42], ['headers', 12], ['large', 40], ['locale', 16], ['rows', 48],
    ['stream', 26], ['totals', 14], ['unicode', 38], ['writer', 20]] as const).map(([f, a]) => [`packages/statements/src/csv/__tests__/${f}.test.ts`, a, 0] as const),
  ...([['ExportButton.tsx', 24, 6], ['ExportDialog.tsx', 38, 12], ['ExportProgress.tsx', 18, 0], ['StatementsPage.tsx', 14, 22], ['columns.ts', 9, 4],
    ['download.ts', 6, 0], ['format.ts', 4, 8], ['index.ts', 2, 2], ['useExport.ts', 16, 5]] as const).map(([f, a, d]) => [`apps/web/src/statements/${f}`, a, d] as const),
  ...([['csv.ts', 18, 0], ['errors.ts', 6, 2], ['export.ts', 22, 0], ['index.ts', 4, 0], ['money.ts', 8, 4], ['statement.ts', 30, 6]] as const)
    .map(([f, a, d]) => [`packages/contracts/src/${f}`, a, d] as const),
];

/** A short, steady stand-in for a commit hash. */
function n6(i: number): string { return (0xa1b2c3 + i * 0x1f1f).toString(16).slice(-6); }
