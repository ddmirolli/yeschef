// French Brigade's made-up team for its tests and screenshots: Open kitchen's team (client/open-kitchen.fixture.ts) with
// a reporting ladder three tiers deep, each Mac's GitHub login, a few more threads ready to merge, and reviewers on the
// open PRs. Never shown to a user. Times are relative to `now`.
import { fixtureView } from './open-kitchen.fixture.ts';
import type { TeamView } from './open-kitchen.ts';

type Fields = Record<string, unknown>;
const MIN = 60000;

/** Dana (me) leads Kai and Maya. Kai: Priya (over Jon, Ada, Omar, Ben) and Nina. Maya: Sam (over Iris, Ravi, Elena),
 *  Lee and Tom. Jon, Ada, Omar, Ben, Iris, Ravi and Elena sit three tiers below Dana, so they fold into "Priya's team"
 *  and "Sam's team". */
export function brigadeView(now = Date.UTC(2026, 10, 10, 14, 3)): TeamView & { people: Fields[] } {
  const v = fixtureView(now);
  const iso = (m: number) => new Date(now - m * MIN).toISOString();
  const under: Record<string, string> = { kai: 'me', maya: 'me', priya: 'kai', nina: 'kai', jon: 'priya', ada: 'priya', omar: 'priya', ben: 'priya',
    sam: 'maya', lee: 'maya', tom: 'maya', iris: 'sam', ravi: 'sam', elena: 'sam' };
  const who = (id: string): Fields & { summary: Fields & { tickets: Fields[] } } => v.people.find((p) => p.id === id) as never;
  for (const p of v.people) {
    if (typeof p.id === 'string' && under[p.id]) p.under = under[p.id];
    if (p.summary && typeof p.summary === 'object') (p.summary as Fields).gh = `${String(p.id)}-acme`;
  }
  const pr = (repo: string, n: number, more: Fields = {}) => ({ repo, n, state: 'open', url: `https://github.com/${repo}/pull/${n}`, base: 'main', draft: false, mergedAt: null, size: null, checks: null, ...more });
  const t = (thread: string, project: string, place: string, title: string, more: Fields = {}) => ({ thread, title, project, place, atPass: false, working: 1, asks: 0, call: false, prs: [],
    updatedAt: iso(3), startedAt: iso(240), ...more });
  // Iris's export PR: Sam approved, so it has passed Sam and waits on checks. Kai's pin PR: asked of Dana.
  const irisPr = who('iris').summary.tickets[0]!.prs as Fields[];
  irisPr[0]!.reviewers = [{ who: 'sam-acme', team: false, state: 'approved', at: now - 20 * MIN }, { who: 'coderabbitai[bot]', team: false, state: 'commented', at: now - 40 * MIN }];
  (who('kai').summary.tickets[0]!.prs as Fields[])[0]!.reviewers = [{ who: 'me-acme', team: false, state: 'requested', at: null }];
  who('ada').summary.tickets.push(t('mcp:ada-2', 'Loopline', 'In review', 'Sidebar keyboard nav', { updatedAt: iso(30 * 60), prs: [pr('acme/loopline', 418, { reviewers: [] })] }));
  who('jon').summary.tickets.push(t('mcp:jon-2', 'Loopline', 'Ready to merge', 'Thread parent column', { updatedAt: iso(26 * 60), prs: [pr('acme/loopline', 416, { reviewers: [{ who: 'priya-acme', team: false, state: 'approved', at: now - 60 * MIN }] })] }));
  who('sam').summary.tickets.push(t('mcp:sam-2', 'Fernpay', 'Ready to merge', 'Plan limits', { updatedAt: iso(80), prs: [pr('acme/fernpay', 446, { reviewers: [] })] }));
  who('elena').summary.tickets.push(t('mcp:elena-2', 'Quillo', 'In review', 'Banner copy', { updatedAt: iso(5 * 24 * 60), prs: [pr('acme/quillo', 431, { reviewers: null })] }));
  who('nina').summary.tickets.push(t('mcp:nina-2', 'Quillo', 'Merged', 'Tray menu order', { working: 0, prs: [pr('acme/quillo', 426, { state: 'merged', mergedAt: iso(100) })] }));
  return v;
}
