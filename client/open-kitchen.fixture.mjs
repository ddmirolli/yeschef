// A made-up team for Open kitchen's tests and screenshots, in Team.view()'s shape (client/team.mjs, 3b) with the
// summary fields step 4 PROPOSED to 3b (bases, seen, startedAt, last, ask, changes, prs[].mergedAt/size/checks).
// Never shown to a user: the Your team view turns on only from real team data. Times are relative to `now`.
import { callId } from './open-kitchen.mjs';

const MIN = 60000;
const iso = (t) => new Date(t).toISOString();

/** The team at `now`: 14 people below the lead; six calls in The Pass, one held by its dev (Ben, fixing an alarm),
 *  and one dev not reporting (Lee). */
export function fixtureView(now = Date.UTC(2026, 10, 10, 14, 3)) {
  const ago = (m) => now - m * MIN;
  const t = (thread, project, place, title, more = {}) => ({ thread, title, project, place, atPass: false, working: 1, asks: 0, call: false, prs: [],
    updatedAt: iso(ago(3)), startedAt: iso(ago(240)), ...more });
  const pr = (repo, n, state, more = {}) => ({ repo, n, state, url: `https://github.com/${repo}/pull/${n}`, draft: false, mergedAt: null, size: null, checks: null, ...more });
  const runs = (greens, reds, from, every = 14) => [...Array(greens + reds)].map((_, i) => ({ at: ago(from - i * every), sha: `c${i}`, title: `run ${i + 1}`, result: i < greens ? 'passing' : 'failing' }));
  const ch = (repo, files, more = {}) => ({ state: 'checked', at: ago(1), repo, base: 'main', mergeBase: 'b0', files, head: 'h1', headAt: iso(ago(30)), more: 0, size: null, ...more });

  const nina = t('mcp:nina-1', 'Quillo', 'In review', 'Tray icon states', { working: 2, prs: [pr('acme/quillo', 428, 'open', { checks: { result: 'failing', redRuns: 6, at: ago(5), runs: runs(4, 6, 233, 20) } })] });
  const ninaFail = callId('failing', 'mcp:nina-1#428', ago(233 - 4 * 20));
  const ben = t('mcp:ben-1', 'Fernpay', 'In progress', 'Diff viewer: word wrap', { prs: [pr('acme/fernpay', 436, 'open', { checks: { result: 'failing', redRuns: 3, at: ago(2), runs: runs(2, 3, 50, 10) } })] });
  const benFail = callId('failing', 'mcp:ben-1#436', ago(50 - 2 * 10));
  const kai = t('mcp:kai-1', 'Loopline', 'In review', 'Pin threads to the sidebar', { working: 5, startedAt: iso(ago(390)),
    prs: [pr('acme/loopline', 412, 'open')], changes: ch('acme/loopline', [{ p: 'contracts/src/orchestration.ts', r: [[118, 170], [300, 318]], a: 61, d: 9 }, { p: 'web/src/sidebar.tsx', r: [[10, 40]], a: 30, d: 2 }]) });
  const jon = t('mcp:jon-1', 'Loopline', 'In progress', 'Group threads by parent', { working: 3, startedAt: iso(ago(303)),
    prs: [pr('acme/loopline', 415, 'open')], changes: ch('acme/loopline', [{ p: 'contracts/src/orchestration.ts', r: [[120, 168], [204, 231], [380, 392]], a: 80, d: 12 }]) });
  const overlapId = callId('overlap', 'mcp:jon-1+mcp:kai-1', ago(303));
  const mainRed = ago(141);
  const ravi = [t('mcp:ravi-1', 'Fernpay', 'Merged', 'Updater channel picker', { working: 0, prs: [pr('acme/fernpay', 431, 'merged', { mergedAt: iso(mainRed), size: { files: 5, added: 212, removed: 40, at: ago(150) } })] }),
    t('mcp:ravi-2', 'Fernpay', 'In progress', 'Nightly icon', { startedAt: iso(ago(125)) })];

  const person = (id, name, tickets, more = {}) => ({ id, name, role: 'engineer', perms: ['see'], online: true, lastSeen: null, at: ago(1), live: true,
    summary: { v: 1, tickets, more: 0, bases: [], seen: {} }, ...more });
  const people = [
    person('ravi', 'Ravi', ravi, { summary: { v: 1, tickets: ravi, more: 0, seen: { [callId('main', 'acme/fernpay@main', mainRed)]: ago(4) },
      bases: [{ repo: 'acme/fernpay', branch: 'main', sha: 'f431', title: 'Updater channel picker (#431)', committedAt: iso(mainRed), redSince: iso(mainRed), result: 'failing', requiredResult: 'failing', failing: ['test:desktop'], at: ago(2) }] } }),
    person('kai', 'Kai', [kai]), person('jon', 'Jon', [jon]), person('nina', 'Nina', [nina]),
    person('iris', 'Iris', [t('mcp:iris-1', 'Fernpay', 'In review', 'Export: tables', { startedAt: iso(ago(51)), prs: [pr('acme/fernpay', 440, 'open', { size: { files: 41, added: 1079, removed: 161, at: ago(3) } })],
      changes: ch('acme/fernpay', [['packages/export/src/tables/a.ts', 598, 42], ['packages/export/src/markdown/b.ts', 262, 48], ['apps/web/src/export/c.ts', 131, 59], ['packages/contracts/src/d.ts', 88, 12], ['pnpm-lock.yaml', 2104, 0, 1]].map(([p, a, d, x]) => ({ p, r: [[1, a]], a, d, ...(x ? { x: 1 } : {}) }))) })]),
    person('omar', 'Omar', [t('mcp:omar-1', 'Loopline', 'In progress', 'Relay: inbox expiry', { working: 2, updatedAt: iso(ago(38)), last: 'Running the expiry migration against the staging copy. On about 180,000 rows it can take a while.',
      prs: [pr('acme/loopline', 421, 'open', { checks: { result: 'passing', redRuns: 0, at: ago(53), runs: runs(3, 0, 80, 13) } })], changes: ch('acme/loopline', [], { headAt: iso(ago(61)) }) })]),
    person('ben', 'Ben', [ben]),
    person('lee', 'Lee', [t('mcp:lee-1', 'Quillo', 'In progress', 'Relay retries', { updatedAt: iso(ago(131)),
      ask: { at: ago(131), q: 'A send fails while the other Mac is asleep. How should the relay retry?', options: [{ k: 'a', t: 'Retry forever, backing off to once every 5 min' }, { k: 'b', t: 'Stop after 5 tries and mark the message failed' }, { k: 'c', t: 'Keep it in the inbox until the other Mac asks for it' }], rec: 'b', n: 1 } })],
      { online: false, lastSeen: ago(122), at: ago(122) }),
    person('maya', 'Maya', [t('mcp:maya-1', 'Fernpay', 'In progress', 'Shell stream protocol v3', { prs: [pr('acme/fernpay', 444, 'open')] }),
      t('mcp:maya-0', 'Fernpay', 'Merged', 'Stream backpressure', { working: 0, prs: [pr('acme/fernpay', 425, 'merged', { mergedAt: iso(ago(330)) })] })]),
    person('sam', 'Sam', [t('mcp:sam-1', 'Fernpay', 'In progress', 'Pricing page', { prs: [pr('acme/fernpay', 445, 'open')] }),
      t('mcp:sam-0', 'Fernpay', 'Merged', 'Plan names', { working: 0, prs: [pr('acme/fernpay', 427, 'merged', { mergedAt: iso(ago(290)) }), pr('acme/fernpay', 429, 'merged', { mergedAt: iso(ago(205)) })] })]),
    person('elena', 'Elena', [t('mcp:elena-1', 'Quillo', 'In progress', 'Banner a11y')]),
    person('ada', 'Ada', [t('mcp:ada-1', 'Loopline', 'In progress', 'Settings search', { changes: ch('acme/loopline', [{ p: 'web/src/sidebar.tsx', r: [[90, 120]], a: 25, d: 3 }]) })]),
    person('tom', 'Tom', [t('mcp:tom-1', 'Quillo', 'Planned', 'Keyboard shortcuts sheet', { working: 0 })]),
    person('priya', 'Priya', [t('mcp:priya-1', 'Fernpay', 'In progress', 'Push token store'),
      t('mcp:priya-0', 'Fernpay', 'Merged', 'Token refresh', { working: 0, prs: [pr('acme/fernpay', 430, 'merged', { mergedAt: iso(ago(170)) })] })]),
  ];
  // Seen, as each dev's Yes Chef would send it.
  people[1].summary.seen = { [overlapId]: ago(18) };
  people[3].summary.seen = { [ninaFail]: ago(17) };
  people[6].summary.seen = { [benFail]: ago(25) };
  return {
    status: 'member', link: 'online', linkAt: ago(300), team: 't1', teamName: 'Platform', unsaved: false, lead: true,
    me: { id: 'me', name: 'Dana', role: 'lead', perms: ['see', 'reply', 'projects', 'merge', 'invite', 'rules'] },
    people: [{ id: 'me', name: 'Dana', role: 'lead', perms: [], online: true, summary: null, at: null, live: false }, ...people],
    pending: [], invites: [],
  };
}
