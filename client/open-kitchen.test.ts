// Open kitchen, the Your team view (step 4). Run: vp test run open-kitchen.test.ts, in client/
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { openKitchen, kitchenBoard, areaOf, callId, below, reporting, reach, sortCalls, may, RULES } from './open-kitchen.ts';
import type { Kind, OpenKitchen, TeamCall, TeamView } from './open-kitchen.ts';
import { fixtureView } from './open-kitchen.fixture.ts';
import { renderApp } from './board.ts';
import { grab, nth, one } from './test/expect.ts';
import type { TeamInput } from './board.ts';

// A teammate's summary is JSON from another Mac. Open kitchen checks every field of it, and these tests prove that
// by writing any value anywhere in the made-up team. So this file reads and writes the team as untyped JSON.
type Wire = any;
/** A call of one kind, so its facts read as that kind's. */
type CallOf<K extends Kind> = Extract<TeamCall, { kind: K }>;

const NOW = Date.UTC(2026, 10, 10, 14, 3);
const MIN = 60000;
const ago = (m: number) => NOW - m * MIN;
const view = (): Wire => fixtureView(NOW);
const who = (v: Wire, id: string): Wire => v.people.find((p: Wire) => p.id === id);
const ticket = (v: Wire, id: string): Wire => who(v, id).summary.tickets[0];
const read = (v: TeamView) => openKitchen(v, { now: NOW });
const kinds = (calls: readonly TeamCall[]) => calls.map((c) => `${c.kind}:${c.who.join('+')}`);
/** The first call of a kind (and dev) among calls, or the test fails. */
function find<K extends Kind>(calls: readonly TeamCall[], kind: K, dev?: string): CallOf<K> {
  const c = calls.find((x): x is CallOf<K> => x.kind === kind && (dev === undefined || x.who[0] === dev));
  assert.ok(c, `no ${kind} call${dev ? ` for ${dev}` : ''}`);
  return c;
}
/** Every call, in The Pass and held. */
const all = (ok: OpenKitchen) => [...ok.pass, ...ok.held];
// Today's merges count from local midnight, so a test of them anchors the made-up team at 14:03 local time, on any TZ.
const NOWL = new Date(2026, 10, 10, 14, 3).getTime();
const agoL = (m: number) => NOWL - m * MIN;
const viewL = (): Wire => fixtureView(NOWL);

test('the made-up team gives the approved mock’s Pass: red first, then amber by age', () => {
  const ok = read(view());
  assert.equal(ok.status, 'live');
  assert.deepEqual(kinds(ok.pass), ['main:ravi', 'overlap:kai+jon', 'failing:nina', 'waiting:lee', 'big:iris', 'stuck:omar']);
  assert.deepEqual(ok.pass.map((c) => c.reach.why), ['red', 'red', 'runs', 'quiet', 'unseen', 'unseen']);
  // Ben marked their own alarm Seen, so it stays theirs.
  assert.deepEqual(kinds(ok.held), ['failing:ben']);
  const state = Object.fromEntries(ok.people.map((p) => [p.id, p.state]));
  assert.deepEqual(Object.entries(state).filter(([, s]) => s !== 'track').map(([id, s]) => `${id}:${s}`).sort(),
    ['ben:alarm', 'iris:pass', 'jon:pass', 'kai:pass', 'lee:quiet', 'nina:pass', 'omar:pass', 'ravi:pass']);
  assert.equal(ok.people.length, 14, 'the lead is not below themself');
});

test('a call’s id is the same on every Mac, so a dev’s Seen matches the lead’s call', () => {
  assert.equal(callId('main', 'acme/fernpay@main', 5), 'main:acme/fernpay@main:5');
  assert.equal(callId('stuck', 'mcp:a', null), 'stuck:mcp:a:0');
  const main = find(read(view()).pass, 'main');
  assert.equal(main.id, callId('main', 'acme/fernpay@main', ago(141)));
  assert.deepEqual(main.seen, { ravi: ago(4) });
});

test('below: a lead has everyone until the chart lands; with it, everyone under me at every level', () => {
  const v = view();
  assert.equal(below(v).length, 14);
  assert.deepEqual(below({ ...v, lead: false }), []);
  const people = [{ id: 'me' }, { id: 'a', under: 'me' }, { id: 'b', under: 'a' }, { id: 'c', under: 'x' }];
  assert.deepEqual(below({ me: { id: 'me' }, people }).map((p) => p.id), ['a', 'b']);
  assert.deepEqual(below({ me: { id: 'a' }, people }).map((p) => p.id), ['b']);
  assert.deepEqual(below({ people }), []);
});

test('Not reporting: 10 quiet minutes with live threads; unknown when this Mac is offline or nothing came yet', () => {
  const p = (more: Wire = {}) => ({ online: false, at: ago(11), summary: { tickets: [{ working: 1 }] }, ...more });
  assert.equal(reporting(p(), { now: NOW, link: 'online' }), false);
  assert.equal(reporting(p({ at: ago(9) }), { now: NOW, link: 'online' }), true);
  assert.equal(reporting(p({ summary: { tickets: [{ working: 0 }] } }), { now: NOW, link: 'online' }), true, 'no live thread, nothing to report');
  assert.equal(reporting(p({ lastSeen: ago(2) }), { now: NOW, link: 'online' }), true, 'the relay’s last-seen wins');
  assert.equal(reporting(p({ online: true }), { now: NOW, link: 'online' }), true);
  assert.equal(reporting(p(), { now: NOW, link: 'offline' }), null);
  assert.equal(reporting(p({ summary: null }), { now: NOW, link: 'online' }), null);
  assert.equal(reporting(p({ at: null }), { now: NOW, link: 'online' }), null);
});

test('a team reading that cannot be had says Not checked, never an empty Pass', () => {
  const off = read({ ...view(), link: 'offline' });
  assert.equal(off.status, 'not-checked');
  assert.equal(off.why, 'offline');
  assert.deepEqual(off.pass, []);
  assert.ok(off.people.every((p) => p.state === 'unknown' && p.reporting === null));
  const v = view();
  for (const p of v.people) p.summary = null;
  assert.equal(read(v).why, 'no-summaries');
});

test('Main broken needs a failing required check; the cause is the last merge before it, clean only with none after', () => {
  let v = view();
  who(v, 'ravi').summary.bases[0].requiredResult = null;
  assert.ok(!read(v).pass.some((c) => c.kind === 'main'), 'null is not checked, never a guess');
  v = view();
  const main = find(read(v).pass, 'main');
  assert.equal(main.facts.cause?.pr.n, 431);
  assert.equal(main.facts.clean, true);
  assert.equal(main.holds, 4);
  assert.deepEqual(main.facts.waiting.map((w) => w.n).sort(), [436, 440, 444, 445]);
  // A commit after the first red one makes a roll back unclean, whoever pushed it.
  who(v, 'ravi').summary.bases[0].sha = 'f999';
  assert.equal(find(read(v).pass, 'main').facts.cause?.pr.n, 431);
  assert.equal(find(read(v).pass, 'main').facts.clean, false);
  // The first red commit is no team merge (a direct push): no cause is named, even with older merges before it.
  v = view();
  who(v, 'ravi').summary.bases[0].redSha = 'd001';
  const none = find(read(v).pass, 'main');
  assert.equal(none.facts.cause, null);
  assert.deepEqual(none.who, []);
  // A later merge moves the head's time, never the break: the cause stays #431, and the roll back is no longer clean.
  v = view();
  const base = who(v, 'ravi').summary.bases[0];
  who(v, 'priya').summary.tickets[1].prs[0].mergedAt = base.committedAt = new Date(ago(100)).toISOString();
  Object.assign(who(v, 'priya').summary.tickets[1].prs[0], { mergeSha: 'f500' });
  base.sha = 'f500';
  const later = find(read(v).pass, 'main');
  assert.equal(later.facts.cause?.pr.n, 431);
  assert.equal(later.facts.clean, false);
  assert.equal(later.id, find(read(view()).pass, 'main').id, 'the call keeps its id, so Seen still matches');
  // No first red commit: the cause is not checked.
  v = view();
  delete who(v, 'ravi').summary.bases[0].redSha;
  assert.equal(find(read(v).pass, 'main').facts.cause, null);
  // A Mac away now: its base reads are not used (someone may have fixed main since).
  v = view();
  Object.assign(who(v, 'ravi'), { online: false, lastSeen: ago(5) });
  assert.ok(!read(v).pass.some((c) => c.kind === 'main'));
  // Two devs read the same base: the newest read counts.
  v = view();
  who(v, 'maya').summary.bases = [{ ...who(v, 'ravi').summary.bases[0], requiredResult: 'passing', at: ago(1) }];
  assert.ok(!read(v).pass.some((c) => c.kind === 'main'));
});

test('Overlap is the same lines of one file in one repo and base; different lines, lockfiles and unread ranges are not', () => {
  const ov = find(read(view()).pass, 'overlap');
  assert.equal(ov.facts.files[0]?.path, 'contracts/src/orchestration.ts');
  assert.deepEqual(ov.facts.files[0]?.shared, [[120, 168]]);
  assert.equal(ov.facts.rebaser.person, 'jon', 'In progress rebases on In review');
  // Ada and Kai change web/src/sidebar.tsx on different lines: no call.
  assert.equal(read(view()).pass.filter((c) => c.kind === 'overlap').length, 1);
  const off = (edit: (v: Wire) => void) => { const v = view(); edit(v); return read(v).pass.some((c) => c.kind === 'overlap'); };
  assert.equal(off((v: Wire) => { ticket(v, 'jon').changes.files[0].r = null; }), false, 'ranges not read: not checked');
  assert.equal(off((v: Wire) => { ticket(v, 'jon').changes.files[0].x = 1; }), false, 'generated or lockfile');
  assert.equal(off((v: Wire) => { ticket(v, 'jon').changes.base = 'release'; }), false, 'another base');
  assert.equal(off((v: Wire) => { ticket(v, 'jon').changes.state = 'not-checked'; }), false);
  // A pure insertion [n + 1, n] is the point n + 1.
  assert.equal(off((v: Wire) => { ticket(v, 'jon').changes.files[0].r = [[171, 170]]; }), false);
  assert.equal(off((v: Wire) => { ticket(v, 'jon').changes.files[0].r = [[170, 169]]; }), true);
  // Same stage: the later start rebases.
  const v = view(); ticket(v, 'kai').place = 'In progress';
  assert.equal(find(read(v).pass, 'overlap').facts.rebaser.person, 'jon');
  ticket(v, 'jon').startedAt = new Date(ago(500)).toISOString();
  assert.equal(find(read(v).pass, 'overlap').facts.rebaser.person, 'kai');
});

test('Failing rises at 3 red runs, reaches the lead after 15 minutes unseen, and at 6 runs whatever is seen', () => {
  const ben = () => find(read(view()).held, 'failing', 'ben');
  assert.equal(ben().facts.redRuns, 3);
  assert.equal(ben().since, ago(30));
  // Unseen, its wait starts at the third red run, not the first.
  let v = view(); who(v, 'ben').summary.seen = {};
  assert.ok(read(v).held.some((c) => c.who[0] === 'ben'), 'the third run was 2 min ago');
  for (const r of ticket(v, 'ben').prs[0].checks.runs) r.at -= 20 * MIN;
  assert.deepEqual(find(read(v).pass, 'failing', 'ben').reach, { lead: true, why: 'unseen', min: 15 });
  v = view(); ticket(v, 'ben').prs[0].checks.redRuns = 2;
  assert.ok(![...read(v).pass, ...read(v).held].some((c) => c.who[0] === 'ben'));
  const held = ben(), call = { ...held, who: ['x'], since: ago(1), facts: { ...held.facts, redRuns: 6 } };
  assert.deepEqual(reach(call, { seen: { x: ago(1) }, now: NOW }), { lead: true, why: 'runs', runs: 6 });
});

test('Stuck needs a running thread and a reporting Mac; Waiting still rises while the dev is away', () => {
  let v = view(); ticket(v, 'omar').working = 0;
  assert.ok(!read(v).pass.some((c) => c.kind === 'stuck'));
  v = view(); Object.assign(who(v, 'omar'), { online: false, at: ago(30) });
  const ok = read(v);
  assert.ok(!ok.pass.some((c) => c.kind === 'stuck'), 'a quiet Mac makes every thread look quiet');
  assert.equal(one(ok.people, (p) => p.id === 'omar', 'omar').state, 'quiet');
  // Lee is away: the question reaches the lead at once.
  assert.equal(find(read(view()).pass, 'waiting').reach.why, 'quiet');
  // Back online: under 30 minutes it stays Lee's; at 30 it reaches the lead.
  v = view(); Object.assign(who(v, 'lee'), { online: true }); ticket(v, 'lee').ask.at = ago(20);
  assert.ok(read(v).held.some((c) => c.kind === 'waiting'));
  ticket(v, 'lee').ask.at = ago(31);
  assert.equal(find(read(v).pass, 'waiting').reach.why, 'time');
  ticket(v, 'lee').ask.at = ago(10);
  assert.ok(![...read(v).pass, ...read(v).held].some((c) => c.kind === 'waiting'), 'under 15 min is no call');
});

test('Too big needs a size read in full: over 800 lines or 30 files, lockfiles left out', () => {
  let v = view(); ticket(v, 'iris').prs[0].size = null;
  assert.ok(!read(v).pass.some((c) => c.kind === 'big'));
  v = view(); ticket(v, 'iris').prs[0].size = { files: 30, added: 700, removed: 100, at: ago(1) };
  assert.ok(![...read(v).pass, ...read(v).held].some((c) => c.kind === 'big'));
  ticket(v, 'iris').prs[0].size.files = 31;
  assert.ok([...read(v).pass, ...read(v).held].some((c) => c.kind === 'big'));
});

test('The Pass’s order: red, then amber; then the call that holds up the most work; then the oldest', () => {
  const c = (id: string, kind: Kind, holds: number, since: number | null) => ({ id, kind, holds, since, who: [] });
  assert.deepEqual(sortCalls([c('a', 'stuck', 1, 5), c('b', 'big', 1, 2), c('c', 'overlap', 2, 9), c('d', 'main', 6, 9), c('e', 'failing', 3, 9), c('f', 'waiting', 1, null)]).map((x) => x.id),
    ['d', 'c', 'e', 'b', 'a', 'f']);
});

test('roles: an Engineer sees only; Reply needs reply, the rest needs merge; a lead may do everything', () => {
  const eng = { role: 'engineer', perms: ['see'] }, dep = { role: 'deputy', perms: ['see', 'reply', 'projects', 'invite'] };
  assert.deepEqual(['reply', 'rebase', 'refire', 'hold', 'answer', 'rollback', 'settle'].map((a) => may(eng, a)), [false, false, false, false, false, false, true]);
  assert.deepEqual(['reply', 'rebase', 'refire', 'hold', 'answer', 'rollback'].map((a) => may(dep, a)), [true, true, false, false, false, false]);
  assert.ok(['reply', 'refire', 'rollback', 'answer'].every((a) => may({ role: 'lead', perms: [] }, a)));
  assert.equal(may(eng, 'launch'), false, 'an action Your team does not know is refused');
  assert.equal(may(null, 'settle'), false);
});

test('the thresholds are the brief’s defaults', () => {
  assert.deepEqual(RULES, { escalateMin: 15, failRuns: 3, failLeadRuns: 6, stuckMin: 20, waitMin: 15, waitLeadMin: 30, bigLines: 800, bigFiles: 30, bigLeadMin: 30, quietMin: 10 });
});

// ---- The screens ----
const page = (team: TeamInput | null, more: { picked?: string[]; fold?: string[]; fit?: { w: number; h: number } } = {}) => renderApp({ board: { tickets: [], runsChecked: false }, link: () => 'x', status: { ok: true, at: NOW, ms: 1 }, origin: 'https://t3.example', team, ...more });

test('Your team draws The Pass’s calls, the rail card, the quiet line and a reader for each', () => {
  const html = page({ view: viewL(), now: NOWL });
  assert.equal((html.match(/class="tile call-tile mail team-tile"/g) || []).length, 6);
  assert.equal((html.match(/<article class="plate team-plate"/g) || []).length, 6);
  assert.match(html, /<div class="folder" data-folder="team">/);
  assert.match(html, /<span class="n tpn">6<\/span>/);
  assert.match(html, /aria-label="Your team"><div class="idrow">/);
  for (const [word, n] of [['In The Pass', 6], ['Fixing an alarm', 1], ['Not reporting', 1], ['On track', 6]]) assert.match(html, new RegExp(`<span>${word}</span><span class="n">${n}</span>`));
  assert.match(html, /Nothing else needs you\. Lee is not reporting since [0-9:]+\. Ben is fixing an alarm on #436\. 6 people are on track\./);
  assert.match(html, /id="yc-team">\{"name":"Platform","below":14,"mode":"open"\}/);
  // Each call says its word in its colour, and what Yes Chef suggests.
  assert.match(html, /<span class="chip c-red">Main broken<\/span><span class="lb tsg">Suggested: <b>Roll back #431<\/b>/);
  assert.match(html, /<span class="chip c-red">Overlap<\/span><span class="lb tsg">Suggested: <b>Ask Jon to rebase<\/b>/);
  // Seen sits in the bar, after the people, and names only who has not seen it (Dan, 2026-11-12: one place).
  assert.match(html, /<span class="mdl">Kai and Jon<\/span><span class="tsn no">Not seen by Jon<\/span>/);
  assert.match(html, /<span class="mdl">Lee<\/span><span class="tsn no">Not seen<\/span>/);
  assert.match(html, /<span class="mdl">Ravi<\/span><span class="tsn">Seen [0-9:]+<\/span>/);
  // No Suggested box in the reader: the call's tile says it, and the blue button does it.
  assert.doesNotMatch(html, /class="tsug"|class="tseen"/);
  assert.match(html, /<b>Not reporting since [0-9:]+\.<\/b>/);
  // Main broken: the team's merges today, the break in red; Overlap: the shared lines boxed.
  assert.match(html, /<div class="ribbon">(<i title="[^"]*"><\/i>){4}<i class="r" title="#431/);
  assert.match(html, /Lines 120 to 168, both/);
});

/** A call's reader, the part under its title, found by the word on its plate. */
const plateWith = (html: string, word: string): string => nth(html.split('<article class="plate team-plate"').slice(1).filter((p) => p.includes(`</i>${word}</span>`)));
const readerOf = (html: string, word: string): string => grab(plateWith(html, word), /<section class="msg tv">([^]*?)<\/section><\/div><aside class="dock/, 1);
/** Too big's diff panel, the plate's last part, after its resize edge. */
const panelOf = (html: string, word: string): string => grab(plateWith(html, word), /<section class="dp" id="p-[0-9a-f]{12}-dp" aria-label="Changes in #440" data-diff="\/diff\?repo=acme%2Ffernpay&amp;n=440&amp;v=\d+\.\d+\.\d+"><div class="dp-rz" role="separator" aria-orientation="vertical" aria-label="Resize the diff panel"><\/div>([^]*?)<\/section><\/article>$/, 1);

test('the readers (Dan, 2026-11-12, 1A 2A 3A): fixes tried, the last message, no Waiting table, T3 Code’s diff panel', () => {
  const html = page({ view: viewL(), now: NOWL });
  // Failing: the red runs, newest first, each with its commit's title, short sha and time.
  const fail = readerOf(html, 'Failing');
  assert.match(fail, /<div class="vl"><span>Fixes tried<\/span><\/div><ul class="truns">/);
  assert.deepEqual([...fail.matchAll(/<span>(run \d+)<\/span><code>(c0ffee\d)<\/code><time>\d\d:\d\d<\/time>/g)].map((m) => `${m[1]} ${m[2]}`),
    ['run 10 c0ffee9', 'run 9 c0ffee8', 'run 8 c0ffee7', 'run 7 c0ffee6', 'run 6 c0ffee5', 'run 5 c0ffee4']);
  // Stuck: the agent's last message, and no time it cannot know.
  assert.match(readerOf(html, 'Stuck'), /<div class="tvis"><div class="vl"><span>Last message<\/span><\/div><p class="tmsg">Running the expiry migration/);
  // Waiting: the question is the reader; no facts table.
  assert.doesNotMatch(readerOf(html, 'Waiting'), /tvis/);
  // Too big (Dan, 2026-11-12): the title says the size and links the PR; the reader has no body, and the bar's toggle,
  // T3 Code's PanelRight icon, opens the diff panel beside it.
  const big = plateWith(html, 'Too big');
  assert.doesNotMatch(big, /class="msg tv"|dpo|data-dp-open|prc/);
  assert.match(big, /<h2 class="plate-t" id="p-[0-9a-f]{12}-t"><a class="prl" href="https:\/\/github\.com\/acme\/fernpay\/pull\/440" target="_blank" rel="noopener">#440<\/a> changes /);
  assert.match(big, /<span class="tsn( no)?">[^<]*<\/span><button type="button" class="dp-t" data-dp-toggle aria-controls="(p-[0-9a-f]{12})-dp" aria-pressed="false" title="Toggle diff panel" aria-label="Toggle diff panel"><svg[^>]*><rect width="18" height="18" x="3" y="3" rx="2"\/><path d="M15 3v18"\/><\/svg><\/button><button type="button" class="close"/);
  assert.equal(big.match(/aria-controls="(p-[0-9a-f]{12})-dp"/)?.[1], big.match(/<section class="dp" id="(p-[0-9a-f]{12})-dp"/)?.[1]);
  // T3 Code's right panel: Changes vs the base, the full diff on GitHub, and a row per file in git's order, removed
  // lines first, the lockfile faded.
  const dp = panelOf(html, 'Too big');
  assert.match(dp, /^<header class="dp-h"><b>Changes<\/b><span class="vs">vs<\/span><span class="base" title="main">main<\/span><span class="dst"/);
  // The list takes focus, so the keys scroll it (PR-Agent r2 on #64).
  assert.match(dp, /<div class="dp-l" tabindex="0">/);
  assert.match(dp, /<a class="dp-i" href="https:\/\/github\.com\/acme\/fernpay\/pull\/440\/files" target="_blank" rel="noopener" title="Open the full diff on GitHub"/);
  assert.doesNotMatch(dp, /data-dp-close|role="dialog"/, 'the panel sits beside the reader, so the bar\'s toggle closes it');
  assert.deepEqual([...dp.matchAll(/<span class="dir">([^<]*)<\/span><span class="fn">([^<]+)<\/span>/g)].map((m) => `${m[1]}${m[2]}`),
    ['apps/web/src/export/c.ts', 'packages/contracts/src/d.ts', 'packages/export/src/markdown/b.ts', 'packages/export/src/tables/a.ts', 'pnpm-lock.yaml']);
  assert.match(dp, /<div class="dpr" title="packages\/export\/src\/tables\/a\.ts">[^]*?<span class="dst" role="group" aria-label="598 additions, 42 deletions"><span class="d" aria-hidden="true">-42<\/span><span class="a" aria-hidden="true">\+598<\/span>/);
  // A count of 0 is left out, as T3 Code's panel rows leave it out.
  assert.match(dp, /<div class="dpr x" title="pnpm-lock\.yaml">[^]*?<span class="dst" role="group" aria-label="2104 additions, 0 deletions"><span class="a" aria-hidden="true">\+2\.1k<\/span><\/span><\/div>/);
  // Only Main broken keeps a facts table, and only what the bar, title, lead and ribbon do not say: the thread and size.
  assert.equal((html.match(/class="kvs"/g) || []).length, 1);
  assert.deepEqual([...readerOf(html, 'Main broken').matchAll(/<div class="kv"><span>([^<]+)<\/span>/g)].map((m) => m[1]), ['Thread', 'Size']);
});

test('the readers say Not checked for what a summary does not say, and draw only real red runs', () => {
  const v = viewL();
  const runs = ticket(v, 'nina').prs[0].checks.runs;
  runs[9].title = null; runs[9].sha = 'not-a-sha'; runs[8].sha = 'ABCDEF1234';
  ticket(v, 'nina').prs[0].checks.redRuns = 8; // more than the red runs sent: the passing ones are left out
  ticket(v, 'omar').last = null;
  const iris = who(v, 'iris').summary.tickets[0];
  iris.changes.more = 3;
  iris.changes.files[0].p = 'packages/export/src/tables/<i>x.ts';
  iris.changes.files[1].a = null;
  let html = page({ view: v, now: NOWL });
  const fail = readerOf(html, 'Failing');
  assert.equal((fail.match(/<li>/g) || []).length, 6);
  assert.match(fail, /<li><svg[^]*?<\/svg><span class="nc">Not checked<\/span><code><\/code><time>/);
  assert.match(fail, /<code>abcdef1<\/code>/);
  assert.match(readerOf(html, 'Stuck'), /<p class="tmsg nc">Not checked<\/p>/);
  const dp = panelOf(html, 'Too big');
  assert.match(dp, /<a class="dpm" href="https:\/\/github\.com\/acme\/fernpay\/pull\/440\/files" target="_blank" rel="noopener">3 more files in the full diff<\/a>/);
  assert.match(dp, /<div class="dpr" title="packages\/export\/src\/tables\/&lt;i&gt;x\.ts">[^]*?<span class="fn">&lt;i&gt;x\.ts<\/span>/);
  assert.match(dp, /<span class="fn">b\.ts<\/span><\/span><\/div>/, 'a file with no count shows none');
  // Files the Mac did not read: the title keeps the PR's size, and the panel says Not checked.
  iris.changes.state = 'reading';
  html = page({ view: v, now: NOWL });
  assert.match(plateWith(html, 'Too big'), /<\/a> changes [0-9,]+ lines in 41 files<\/h2>/);
  assert.match(plateWith(html, 'Too big'), /data-dp-toggle/);
  assert.match(panelOf(html, 'Too big'), /<div class="dp-l" tabindex="0"><p class="dpn">Not checked<\/p><\/div>$/);
  // A PR whose base the summary does not name shows no "vs".
  iris.changes.state = 'checked';
  who(v, 'iris').summary.tickets[0].prs[0].base = null;
  assert.match(panelOf(page({ view: v, now: NOWL }), 'Too big'), /<header class="dp-h"><b>Changes<\/b><span class="dst"/);
});

test('team actions show by role and never send: a see-only Engineer gets Settle and a line, no note', () => {
  const lead = page({ view: view(), now: NOW });
  assert.match(lead, /<form class="act team-act" method="post" action="\/act" data-plate="p-[0-9a-f]{12}">/);
  // No nonce and no thread: the server could not take a team form even if one were sent.
  for (const f of lead.match(/<form class="act team-act"[^]*?<\/form>/g) ?? []) assert.doesNotMatch(f, /name="(nonce|thread)"/);
  assert.match(lead, /value="rollback" class="ab fill primary"/);
  const v = view(); v.me = { id: 'me', name: 'Dana', role: 'engineer', perms: ['see'] };
  const eng = page({ view: v, now: NOW });
  const forms = eng.match(/<form class="act team-act"[^]*?<\/form>/g) ?? [];
  assert.equal(forms.length, 6);
  for (const f of forms) {
    assert.doesNotMatch(f, /value="(rollback|rebase|reply|refire|answer|hold)"/);
    assert.match(f, /value="settle"/);
    assert.match(f, /Your role can see this call\./);
    assert.doesNotMatch(f, /<textarea/);
    assert.doesNotMatch(f, /<fieldset/);
  }
  // A Deputy (reply, no merge) gets Reply and Rebase, not Roll back or Hold.
  v.me = { id: 'me', name: 'Dana', role: 'deputy', perms: ['see', 'reply', 'projects', 'invite'] };
  const dep = page({ view: v, now: NOW });
  assert.doesNotMatch(dep, /value="(rollback|hold|refire|answer)"/);
  assert.match(dep, /value="rebase" class="ab fill primary"/);
  assert.match(dep, /value="reply" class="ab"/);
});

test('a teammate’s words are escaped, and only a GitHub PR address opens', () => {
  const v = view();
  who(v, 'ravi').name = '<img src=x onerror=alert(1)>';
  ticket(v, 'iris').title = '<b>x</b>';
  ticket(v, 'iris').prs[0].url = 'javascript:alert(1)';
  const html = page({ view: v, now: NOW });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /href="https:\/\/github\.com\/acme\/fernpay\/pull\/440"/);
});

test('without a team reading Your team says Not checked; a reading that cannot be had says why', () => {
  const none = page({ name: 'Platform', below: 6, mode: 'open' });
  assert.match(none, /class="clear team-pass"/);
  assert.doesNotMatch(none, /team-card|team-tile|data-folder="team"/);
  const off = page({ view: { ...view(), link: 'offline', linkAt: ago(20) }, now: NOW });
  assert.match(off, /<b>Not checked<\/b><\/p><p class="muted">Yes Chef’s team connection is down since [0-9:]+\. Your team’s calls show once it is back\./);
  assert.match(off, /<span>Not checked<\/span><span class="n">–<\/span>/);
  assert.doesNotMatch(off, /team-tile/);
  // No reports: no switch, and nothing of Your team at all.
  assert.doesNotMatch(page(null), /yc-team|team-pass/);
});

test('a malformed summary from a teammate reads as empty, never as a crash', () => {
  const now = Date.UTC(2026, 10, 10, 14, 3);
  const v: Wire = fixtureView(now);
  const bad = [null, 7, 'x', { tickets: 'no' }, { tickets: [null, 3, { prs: 'x', changes: { state: 'checked', files: 'x' } }], bases: {} },
    { tickets: [{ working: 1, place: 'In progress', changes: { state: 'checked', repo: 'o/r', base: 'main', files: [{ p: 'a.ts', r: [['x'], [1, 2]] }] }, prs: [{ state: 'open', checks: { runs: 'x' } }], ask: 'x' }] }];
  for (const s of bad) {
    v.people[2] = { ...v.people[2], summary: s };
    const k = openKitchen(v, { now });
    assert.equal(k.status, 'live');
  }
  v.people = 'x';
  assert.doesNotThrow(() => openKitchen(v, { now }));
});

test('a page with odd strings in a teammate’s summary still draws', () => {
  const v = view();
  const k = ticket(v, 'ravi');
  k.title = 42; v.people[0].name = null;
  assert.doesNotThrow(() => page({ view: v, now: NOW }));
});

test('review r1: a bad PR number never reaches the page; bad ranges drop; Stuck waits for Seen; near ranges say so', () => {
  let v = view();
  ticket(v, 'ravi').prs[0].n = '"><img src=x onerror=alert(1)>';
  let k = read(v);
  assert.equal(find(k.pass, 'main').facts.cause, null, 'the PR with a bad number drops, and no other is blamed');
  assert.ok(!page({ view: v, now: NOW }).includes('<img src=x'));
  v = view();
  const jon = who(v, 'jon').summary.tickets[0].changes.files.find((f: Wire) => f.p === 'contracts/src/orchestration.ts');
  jon.r = [null, ...jon.r];
  const ov = find(read(v).pass, 'overlap');
  assert.ok(nth(ov.facts.files).b.every((r) => Array.isArray(r)));
  assert.doesNotThrow(() => page({ view: v, now: NOW }));
  assert.equal(ov.facts.near, false, 'one merge base: exact');
  v = view();
  who(v, 'jon').summary.tickets[0].changes.mergeBase = 'b9';
  assert.equal(find(read(v).pass, 'overlap').facts.near, true);
  assert.match(page({ view: v, now: NOW }), /About lines 120 to 168/);
  // Stuck rises at 20 min quiet and reaches the lead 15 min later, unseen.
  v = view(); ticket(v, 'omar').updatedAt = new Date(ago(25)).toISOString();
  assert.ok(read(v).held.some((c) => c.kind === 'stuck'), 'quiet 25 min: risen 5 min ago, still the dev’s');
  ticket(v, 'omar').updatedAt = new Date(ago(36)).toISOString();
  assert.ok(read(v).pass.some((c) => c.kind === 'stuck'), 'risen 16 min ago, unseen: the lead’s');
  // Failing needs a Mac online now.
  v = view();
  Object.assign(who(v, 'nina'), { online: false, lastSeen: ago(3) });
  assert.ok(!read(v).pass.some((c) => c.kind === 'failing' && c.who[0] === 'nina'));
});

test('review r2: pathless files, merges to another branch, a quiet Mac’s merges, and Too big with no time', () => {
  // Files with no path never match.
  let v = view();
  for (const id of ['kai', 'jon']) ticket(v, id).changes.files.push({ r: [[1, 400]] });
  assert.doesNotThrow(() => page({ view: v, now: NOW }));
  assert.equal(read(v).pass.filter((c) => c.kind === 'overlap').length, 1);
  // A merge to another branch is never main's cause, and its open PRs do not wait on main.
  v = view();
  ticket(v, 'ravi').prs[0].base = 'release';
  const m = find(read(v).pass, 'main');
  assert.notEqual(m.facts.cause?.pr.n, 431);
  v = view(); ticket(v, 'iris').prs[0].base = undefined;
  assert.ok(!find(read(v).pass, 'main').facts.waiting.some((w) => w.n === 440));
  // Ravi's Mac goes quiet: his merge still dates the break (Maya reads the base now).
  v = view();
  who(v, 'maya').summary.bases = [{ ...who(v, 'ravi').summary.bases[0], at: ago(1) }];
  Object.assign(who(v, 'ravi'), { online: false, lastSeen: ago(60), at: ago(60) });
  assert.equal(find(read(v).pass, 'main').facts.cause?.pr.n, 431);
  // Too big with no overAt: its age is not checked, so time never sends it to the lead.
  v = view(); delete ticket(v, 'iris').prs[0].size.overAt;
  const big = find(read(v).held, 'big');
  assert.equal(big.since, null);
});

test('review r3: odd times read as not checked; two PRs with one number in two repos are two calls', () => {
  let v = view();
  ticket(v, 'omar').updatedAt = { toString: null };
  ticket(v, 'kai').startedAt = [1];
  assert.doesNotThrow(() => page({ view: v, now: NOW }));
  v = view();
  const k = ticket(v, 'nina');
  k.prs.push({ ...k.prs[0], repo: 'acme/other', url: 'https://github.com/acme/other/pull/428' });
  const ids = [...read(v).pass, ...read(v).held].filter((c) => c.kind === 'failing' && c.who[0] === 'nina').map((c) => c.id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test('review r4: any odd value at any place in a summary still draws the page', () => {
  const evil = [{ toString: null }, [1], 7, null, true, '<b>x</b>'];
  const base = view();
  const paths: (string | number)[][] = [];
  const walk = (o: Wire, path: (string | number)[]): void => {
    if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], [...path, k]);
    else paths.push(path);
  };
  base.people.forEach((p: Wire, i: number) => walk(p, ['people', i]));
  assert.ok(paths.length > 300, `walked ${paths.length} leaves`);
  for (const path of paths) for (const bad of evil) {
    const v = view();
    let o = v; for (const k of path.slice(0, -1)) o = o[k];
    o[nth(path, path.length - 1)] = bad;
    let html = '';
    assert.doesNotThrow(() => { html = page({ view: v, now: NOW }); }, `${path.join('.')} = ${JSON.stringify(bad)}`);
    assert.ok(!html.includes('<b>x</b>'), path.join('.'));
  }
}, 30000); // About 4,000 whole pages: a busy machine takes past the 5 s default.

test('review r4: a picked project narrows the team’s calls; a red base with no cause names its repo', () => {
  const v = view();
  const html = renderApp({ board: { tickets: [], runsChecked: false }, picked: ['Quillo'], link: () => 'x', status: { ok: true, at: NOW, ms: 1 }, origin: 'https://t3.example', team: { view: v, now: NOW } });
  const tiles = html.match(/class="tile call-tile mail team-tile"/g) || [];
  assert.equal(tiles.length, 2, 'Nina’s Failing and Lee’s Waiting');
  who(v, 'ravi').summary.bases[0].redSha = 'd001';
  const m = find(read(v).pass, 'main');
  assert.equal(m.project, 'Fernpay', 'the team’s work on that base names the project');
  assert.match(page({ view: v, now: NOW }), /main is red in acme\/fernpay/);
});

test('review r5: done work is not an Overlap; the rebase target is the PR in the diff’s repo; @ in a branch; partial sizes', () => {
  let v = view(); ticket(v, 'kai').place = 'Verified';
  assert.ok(!read(v).pass.some((c) => c.kind === 'overlap'));
  v = view(); ticket(v, 'kai').place = 'toString';
  assert.ok(!read(v).pass.some((c) => c.kind === 'overlap'));
  v = view();
  const kai = ticket(v, 'kai');
  kai.prs.unshift({ ...kai.prs[0], repo: 'acme/other', n: 10, url: 'https://github.com/acme/other/pull/10' });
  const ov = find(read(v).pass, 'overlap');
  assert.equal(ov.facts.keeper.pr?.n, 412);
  assert.deepEqual(ov.prs.map((p) => p.n), [412, 415]);
  assert.match(page({ view: v, now: NOW }), /data-what="Rebase: Jon’s agent rebases on #412"/);
  v = view();
  const b = who(v, 'ravi').summary.bases[0];
  b.branch = 'release@v2';
  for (const p of v.people) for (const k of p.summary?.tickets || []) for (const pr of k.prs) pr.base = 'release@v2';
  assert.equal(find(read(v).pass, 'main').facts.cause?.pr.n, 431);
  v = view(); delete ticket(v, 'ravi').prs[0].size.added;
  assert.doesNotMatch(page({ view: v, now: NOW }), /5 files, \+0/);
});

test('review r6: a summary that is not an object with tickets is not checked, never On track', () => {
  for (const bad of [7, 'x', { tickets: 'no' }, []]) {
    let v = view(); who(v, 'maya').summary = bad;
    assert.equal(one(read(v).people, (p) => p.id === 'maya', 'maya').state, 'unknown');
    v = view(); for (const p of v.people) if (p.id !== 'me') p.summary = bad;
    assert.equal(read(v).status, 'not-checked');
  }
});

// ---- PR B: Your team, expanded ----
/** The expanded team board at 14:03 local, or the test fails: the made-up team is live. */
const board = (v: TeamView, want: ReadonlySet<string> | null = null) => {
  const b = kitchenBoard(openKitchen(v, { now: NOWL }), { now: NOWL, want });
  assert.ok(b, 'the team reading is live');
  return b;
};
/** A person's merged today on their row, and whether it is a floor (at least). */
const mergedOf = (B: NonNullable<ReturnType<typeof kitchenBoard>>, id: string) => {
  const r = one(B.rows.people, (x) => x.person === id, id);
  return [r.merged, r.floor] as const;
};
const hmOf = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

test('expanded: the board is the rows alone, beside the team’s Pass (Dan, 2026-11-12, "1. B-ish")', () => {
  const B = board(viewL());
  assert.deepEqual(Object.keys(B), ['rows']);
  // The day's five merges, each on the row of the person whose copy says merged.
  assert.equal(B.rows.people.reduce((n, r) => n + (r.merged ?? 0), 0), 5);
  const html = page({ view: viewL(), now: NOWL });
  const tb = grab(html, /<section class="tboard"[^]*?<\/section><\/div><\/section>/);
  // No instruments, no files list, no title over the chart: the header picker names what it shows.
  assert.doesNotMatch(tb, /class="inst"|class="ins"|Files two live threads|<h3/);
  assert.match(tb, /^<section class="tboard" aria-labelledby="tb-t"><header class="you-h">[^]*?<\/header><div class="you-b"><section class="pnl ok-p" aria-label="Who’s on what"><div class="fx-wrap ok-box">/);
  // The key sits at the foot, under the rows, with no line that explains how to read them.
  assert.match(tb, /<\/div><footer class="ok-foot"><p class="lg okk">[^]*?<\/p><p class="lg okl">Agents by lab: not checked<\/p><\/footer><\/section><\/div><\/section>$/);
  assert.doesNotMatch(tb, /Hover for|Click a team|darker with more/);
});

test('expanded: Who’s on what is one row per person: their live agents, a quiet Mac, the Overlap link', () => {
  const R = board(viewL()).rows;
  assert.equal(R.people.length, 14, 'everyone, whatever they do');
  const kai = one(R.people, (r) => r.person === 'kai', 'kai');
  assert.deepEqual(kai.agents.map((a) => [a.title, a.working, a.call?.kind ?? null, a.call?.mine ?? null, a.areas]), [['Pin threads to the sidebar', true, 'overlap', true, ['contracts', 'web']]]);
  // A merged thread is not an agent at work: Ravi's merged picker leaves only the Nightly icon.
  assert.deepEqual(one(R.people, (r) => r.person === 'ravi', 'ravi').agents.map((a) => a.title), ['Nightly icon']);
  assert.equal(one(R.people, (r) => r.person === 'ben', 'ben').agents[0]?.call?.mine, false, 'Ben holds their own alarm');
  const lee = one(R.people, (r) => r.person === 'lee', 'lee');
  assert.deepEqual([lee.quiet?.since, lee.agents.length], [agoL(122), 0], 'a quiet Mac draws no agents: what it runs now is not known');
  // A thread that sent no file list has no areas, so it lights no column.
  assert.equal(one(R.people, (r) => r.person === 'tom', 'tom').agents[0]?.areas, null);
  assert.deepEqual(R.columns.map((c) => `${c.project}:${c.area}`), ['Fernpay:apps/web', 'Fernpay:packages/contracts', 'Fernpay:packages/export', 'Fernpay:root', 'Loopline:contracts', 'Loopline:web']);
  assert.deepEqual(R.links.map((l) => [l.a, l.b, l.project, l.area, l.path]), [['kai', 'jon', 'Loopline', 'contracts', 'contracts/src/orchestration.ts']]);
  assert.equal(R.labs, null, 'no summary names the model, so Agents by lab is not checked');
  assert.deepEqual(R.pods, []);
});

test('a code area is the top folder, or the package under a workspace folder; a file at the root is root', () => {
  assert.equal(areaOf('contracts/src/orchestration.ts'), 'contracts');
  assert.equal(areaOf('packages/export/src/table.ts'), 'packages/export');
  assert.equal(areaOf('apps/web/src/a.tsx'), 'apps/web');
  assert.equal(areaOf('packages/README.md'), 'packages');
  assert.equal(areaOf('pnpm-lock.yaml'), 'root');
  assert.equal(areaOf('/web/x.ts'), 'web');
});

test('expanded: the rows draw a square per agent, cells per area, and no line but the Overlap (Dan, 2026-11-12)', () => {
  const html = page({ view: viewL(), now: NOWL });
  const svg = grab(html, /<svg class="fx okr"[^]*?<\/svg>/);
  assert.equal((svg.match(/<rect class="ag /g) || []).length, 13, 'one square per live agent; Lee is quiet');
  assert.equal((svg.match(/<rect class="ag red"/g) || []).length, 2, 'Kai and Jon: the Overlap');
  assert.equal((svg.match(/<rect class="ag amber"/g) || []).length, 4, 'Ben, Iris, Nina, Omar');
  assert.equal((svg.match(/<rect class="ag idle"/g) || []).length, 1, 'Tom');
  // The only lines: the project rules over their columns, and the Overlap with its halo.
  const lines = [...svg.matchAll(/<line class="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(lines, ['pjrule', 'pjrule', 'olink halo', 'olink']);
  assert.match(svg, /Not reporting since \d\d:\d\d/);
  // Red only where the shared file is: Kai's and Jon's contracts cells; Kai's web cell stays gray.
  assert.equal((svg.match(/<rect class="cell red"/g) || []).length, 2);
  assert.match(svg, /<rect class="cell n1" data-k="c:kai:5 /);
  // A square whose call is in The Pass opens that call, as its card does, and lights it: both carry its plate.
  const opens = [...svg.matchAll(/<rect class="ag [^"]*" data-team-open="([^"]+)"[^>]*? data-k="([^"]+)"/g)];
  assert.equal(opens.length, 5, 'Kai, Jon, Iris, Nina, Omar: the calls in The Pass');
  for (const [, id, k] of opens) {
    assert.ok(k!.split(' ').includes(`p:${id}`));
    assert.ok(html.includes(`<div class="xc" role="listitem" data-team-open="${id}">`), id);
  }
  assert.ok(html.includes('<p class="lg okl">Agents by lab: not checked</p>'));
});

test('expanded: a sub-lead’s team folds into one row, and the rows keep their places', () => {
  const v = viewL();
  // Kai leads Jon and Ada; everyone else reports to me.
  for (const p of v.people) p.under = p.id === 'jon' || p.id === 'ada' ? 'kai' : v.me.id;
  const R = board(v).rows;
  assert.deepEqual(R.pods, [{ lead: 'kai', members: ['kai', 'ada', 'jon'] }]);
  const open = page({ view: v, now: NOWL }), shut = page({ view: v, now: NOWL }, { fold: ['kai'] });
  const svgOf = (h: string) => grab(h, /<svg class="fx okr"[^]*?<\/svg>/);
  assert.match(svgOf(open), /data-fold="kai" aria-expanded="true"/);
  assert.match(svgOf(open), />3 agents · <tspan class="need">1 needs you<\/tspan></, 'Kai and Jon share one Overlap: one call waits on you');
  assert.match(svgOf(shut), /data-fold="kai" aria-expanded="false"/);
  const names = (h: string) => [...svgOf(h).matchAll(/<text class="rowname[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1]);
  // The team sits where its lead's name sorts: the lead first, then the rest by name, each indented.
  const at = names(open).indexOf('▾ Kai’s team');
  assert.deepEqual(names(open).slice(at - 1, at + 5), ['Iris', '▾ Kai’s team', 'Kai', 'Ada', 'Jon', 'Lee']);
  assert.ok(!names(shut).includes('Ada') && !names(shut).includes('Jon'), 'folded: the team is one row');
  // The Overlap is inside the folded team: one row, so no line.
  assert.ok(!svgOf(shut).includes('class="olink'));
});

test('expanded: what no summary says stays not checked, never a guess', () => {
  // A thread with no start time is counted, not drawn; work merged before today is not drawn at all.
  let v = viewL();
  delete ticket(v, 'tom').startedAt;
  assert.equal(one(board(v).rows.people, (r) => r.person === 'tom', 'tom').agents.length, 1, 'an agent needs no start time');
  v = viewL();
  who(v, 'maya').summary.tickets[1].prs[0].mergedAt = new Date(NOWL - 30 * 60 * MIN).toISOString();
  assert.equal(one(board(v).rows.people, (r) => r.person === 'maya', 'maya').merged, 0, 'merged yesterday is not merged today');
  assert.equal(kitchenBoard(openKitchen({ ...viewL(), link: 'offline' }, { now: NOWL }), { now: NOWL }), null);
});

test('expanded: a picked project narrows the board', () => {
  const B = board(viewL(), new Set(['Quillo']));
  // Rows never move: everyone stays; work outside the project is drawn dashed and lights no column.
  assert.equal(B.rows.people.length, 14);
  assert.deepEqual(B.rows.people.flatMap((r) => r.agents.filter((a) => !a.out).map(() => r.person)).sort(), ['elena', 'nina', 'tom']);
  assert.deepEqual(B.rows.columns, []);
  assert.ok(page({ view: viewL(), now: NOWL }, { picked: ['Quillo'] }).includes('Other projects'));
  assert.equal(B.rows.people.reduce((n, r) => n + (r.merged ?? 0), 0), 0, 'the day’s merges are all in Fernpay');
});

test('expanded: the header is the picker, with the skillet and no count line (Dan, 2026-11-11)', () => {
  const html = page({ view: viewL(), now: NOWL });
  const top = (html.match(/<section class="tboard" aria-labelledby="tb-t"><header class="you-h">[\s\S]*?<\/header>/) || [''])[0];
  assert.match(top, /<h2 id="tb-t" class="vh">Open kitchen, All projects<\/h2><details class="pmenu vmenu vhead"><summary><span class="vi" title="Team, Open kitchen"><svg class="ic who"/);
  assert.match(top, /<span class="vp">All projects<\/span>/);
  // The same menu as the chip's: All projects, the projects, then the toggle.
  assert.match(top, /class="pk all" role="checkbox"[\s\S]*?data-scope="you"[\s\S]*?data-scope="team"/);
  // No count line: people, live threads and the time it was read are gone.
  assert.doesNotMatch(top, /you-sub|people|live thread|<time/);
});

test('expanded: with no team reading the waiting panel keeps the header picker (PR-Agent, #46)', () => {
  const html = page({ name: 'Platform', below: 6, mode: 'open' });
  const wait = (html.match(/<section class="team-wait"[\s\S]*?<\/section>/) || [""])[0];
  assert.match(wait, /^<section class="team-wait" aria-label="Your team"><header class="you-h"><details class="pmenu vmenu vhead"><summary><span class="vi" title="Team, Open kitchen">/);
  assert.match(wait, /data-scope="you"[\s\S]*?data-scope="team"/);
  assert.match(wait, /<div class="tw-b"><p><b>Platform<\/b><\/p><p class="muted">Not checked\./);
});

test('expanded: the page draws the board and The Pass as a column; each opens a call that is in the page', () => {
  const html = page({ view: viewL(), now: NOWL });
  assert.match(html, /<section class="tboard"/);
  assert.ok(!html.includes('class="team-wait"'), 'the board replaces the waiting panel');
  assert.equal((html.match(/class="xc"/g) || []).length, 6);
  const opens = [...html.matchAll(/data-team-open="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(opens.length > 12);
  for (const id of new Set(opens)) assert.ok(html.includes(`<article class="plate team-plate" id="${id}"`), id);
  // Every colour carries a word: the legend says what red and amber mean.
  for (const w of ['Working', 'Idle', 'Act now', 'Decide soon', 'Not reporting', 'Merged today']) assert.ok(html.includes(w), w);
  assert.ok(html.includes(`Not reporting since ${hmOf(agoL(122))}`));
  assert.ok(html.includes('6 need you, most urgent first.'));
  // The suggestion button is the call's first action, and only for a role that may take it.
  assert.match(html, /data-team-act="rollback">Roll back #431</);
  const v = viewL(); v.me = { ...v.me, role: 'engineer', perms: ['see'] };
  assert.ok(!page({ view: v, now: NOWL }).includes('data-team-act='), 'See only: Open, never the suggestion');
});

// ---- PR B, PR-Agent round 1 ----

test('r1: a merged PR with no time makes the count a floor, never dropped', () => {
  const v = viewL();
  const [n] = mergedOf(board(v), 'kai');
  ticket(v, 'kai').prs[0].state = 'merged';
  ticket(v, 'kai').prs[0].mergedAt = null;
  assert.deepEqual(mergedOf(board(v), 'kai'), [n, true]);
  assert.match(grab(page({ view: v, now: NOWL }), /<svg class="fx okr"[^]*?<\/svg>/), /data-f="d:kai" data-tip="[^"]*not checked merged today/, 'a floor of 0 says nothing');
});

// ---- PR B, PR-Agent round 2 ----

test('r2: a Mac quiet since an earlier day says the day, never an hour that reads as today', () => {
  const v = viewL();
  const lee = who(v, 'lee');
  lee.lastSeen = NOWL - 20 * 60 * MIN;
  lee.at = lee.lastSeen;
  assert.ok(page({ view: v, now: NOWL }).includes(`Not reporting since ${new Date(NOWL - 20 * 60 * MIN).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`));
});

// ---- PR B, PR-Agent round 5 ----
test('r5: a merged thread with one PR of no merge time has no known end, so it is not counted as merged today', () => {
  const v = viewL();
  const maya = who(v, 'maya').summary.tickets.find((k: Wire) => k.place === 'Merged');
  assert.equal(one(board(v).rows.people, (r) => r.person === 'maya', 'maya').merged, 1);
  maya.prs.push({ ...maya.prs[0], n: 999, mergedAt: null });
  const maya2 = one(board(v).rows.people, (r) => r.person === 'maya', 'maya');
  assert.deepEqual([maya2.merged, maya2.floor], [1, true], 'the timed merge counts; the untimed one makes it at least (PR-Agent r3 on #53)');
  assert.match(grab(page({ view: v, now: NOWL }), /<svg class="fx okr"[^]*?<\/svg>/), />at least 1</);
});

// ---- PR B, PR-Agent round 6 ----

test('r6: a merge with a known time in any copy is never counted as having no time', () => {
  const v = viewL();
  const merged = who(v, 'maya').summary.tickets.find((k: Wire) => k.place === 'Merged');
  // Kai's thread holds a copy of Maya's PR with no time; Maya's copy has one.
  ticket(v, 'kai').prs.push({ ...merged.prs[0], mergedAt: null });
  const floors = () => board(v).rows.people.filter((r) => r.floor).map((r) => r.person);
  assert.deepEqual(floors(), ['lee'], 'only the quiet Mac’s count is a floor');
  // Moved before today, the known copy still settles it: not today's, and not untimed.
  merged.prs[0].mergedAt = new Date(NOWL - 30 * 60 * MIN).toISOString();
  assert.deepEqual(floors(), ['lee']);
  assert.deepEqual(mergedOf(board(v), 'maya'), [0, false]);
});

// ---- PR B, PR-Agent round 7 ----
test('r7: in a picked project, a merge whose time is in another project’s copy is counted with that time', () => {
  const v = viewL();
  const merged = who(v, 'maya').summary.tickets.find((k: Wire) => k.place === 'Merged');
  // Tom's Quillo thread holds a copy of Maya's Fernpay PR with no time; Maya's own copy (Fernpay) has today's time.
  who(v, 'tom').summary.tickets[0].prs = [{ ...merged.prs[0], mergedAt: null }];
  assert.deepEqual(mergedOf(board(v, new Set(['Quillo'])), 'maya'), [1, false]);
});

// ---- PR B, PR-Agent round 8 ----

test('r8: the rows chart scrolls across inside its panel and keeps the scroll over a refresh', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  assert.ok(css.includes('.ok-box{position:relative}.ok-wrap{overflow-x:auto;'));
  assert.ok(readFileSync(new URL('./page.ts', import.meta.url), 'utf8').includes("swapAny('.tboard', fresh, '.head', '.you-b, .ok-wrap')"));
});

// ---- PR B, PR-Agent round 9 ----
test('r9: in a picked project, a PR whose copy there says open is counted as merged when another copy says so', () => {
  const v = viewL();
  const merged = who(v, 'maya').summary.tickets.find((k: Wire) => k.place === 'Merged');
  who(v, 'tom').summary.tickets[0].prs = [{ ...merged.prs[0], state: 'open', mergedAt: null }];
  assert.deepEqual(mergedOf(board(v, new Set(['Quillo'])), 'maya'), [1, false]);
});

// ---- PR B, PR-Agent round 13 ----
test('r13: a merge is credited to the person whose copy says merged, not the first that mentions it', () => {
  const v = viewL();
  const before = [mergedOf(board(v), 'ravi'), mergedOf(board(v), 'kai')];
  const pr431 = who(v, 'ravi').summary.tickets.find((k: Wire) => k.prs.some((pr: Wire) => pr.n === 431)).prs.find((pr: Wire) => pr.n === 431);
  who(v, 'kai').summary.tickets[0].prs.push({ ...pr431, state: 'open', mergedAt: null });
  const i = v.people.findIndex((p: Wire) => p.id === 'kai');
  v.people.splice(1, 0, ...v.people.splice(i, 1));
  assert.deepEqual([mergedOf(board(v), 'ravi'), mergedOf(board(v), 'kai')], before, '#431 stays Ravi’s');
});

test('a click on a sub-lead’s team folds it: the page keeps the fold in the address and draws again', async () => {
  const vm = await import('node:vm');
  const { pageScript } = await import('./test/served.ts');
  const src = pageScript();
  assert.match(src, /closest\s*(?:<Element>)?\s*\('\.tboard \[data-fold\]'\);\s*if \(fo\) \{ toggleFold\(fo\.getAttribute\('data-fold'\) \|\| ''\); return; \}/);
  const fn = grab(src, /function toggleFold[\s\S]*?\n {2}\}/);
  const calls: string[] = [];
  const ctx = vm.createContext({ URLSearchParams, location: { pathname: '/', search: '?p=Fernpay&fold=ben' }, history: { state: null, replaceState: (_s: unknown, _t: string, u: string) => { calls.push(u); ctx.location.search = u.slice(1); } }, wake: () => calls.push('wake'), flowFocus: () => {} });
  vm.runInContext(fn, ctx);
  vm.runInContext("toggleFold('kai')", ctx);
  vm.runInContext("toggleFold('ben')", ctx);
  vm.runInContext("toggleFold('')", ctx);
  assert.deepEqual(calls, ['/?p=Fernpay&fold=ben&fold=kai', 'wake', '/?p=Fernpay&fold=kai', 'wake']);
});

// ---- Open kitchen rows, PR-Agent round 1 (#53) ----
test('rows r1: a Mac Yes Chef cannot read shows Not checked for agents and merges, never 0', () => {
  const v = viewL();
  Object.assign(who(v, 'sam'), { summary: null, at: null, lastSeen: null });
  const sam = one(board(v).rows.people, (r) => r.person === 'sam', 'sam');
  assert.deepEqual([sam.known, sam.agents.length, sam.merged], [false, 0, null]);
  const svg = grab(page({ view: v, now: NOWL }), /<svg class="fx okr"[^]*?<\/svg>/);
  assert.match(svg, /Agents and merges not checked/);
  assert.ok(!svg.includes('0 of 0 agents'));
});

test('rows r1: a square that opens its call is a button a keyboard reaches', () => {
  const svg = grab(page({ view: viewL(), now: NOWL }), /<svg class="fx okr"[^]*?<\/svg>/);
  const btns = [...svg.matchAll(/<rect class="ag [^"]*" data-team-open="[^"]+" tabindex="0" role="button" aria-label="Open the call: ([^"]+)"/g)].map((m) => m[1]);
  assert.equal(btns.length, 5);
  assert.ok(btns.includes('Group threads by parent, Overlap'));
});

test('rows r1: an Overlap side that waits keeps its cell, so the link has both ends', () => {
  const v = viewL();
  ticket(v, 'jon').working = 0;
  const svg = grab(page({ view: v, now: NOWL }), /<svg class="fx okr"[^]*?<\/svg>/);
  assert.match(svg, /<rect class="cell red" data-k="c:jon:4 /);
  assert.equal((svg.match(/<line class="olink"/g) || []).length, 1);
});

test('rows r1: a folded team keeps its people’s calls, and shades a cell as a person’s cell would', () => {
  const v = viewL();
  // Kai leads Jon and Iris: Iris's Too big is in The Pass, and folding must not lose it.
  for (const p of v.people) p.under = p.id === 'jon' || p.id === 'iris' ? 'kai' : v.me.id;
  const svg = grab(page({ view: v, now: NOWL }, { fold: ['kai'] }), /<svg class="fx okr"[^]*?<\/svg>/);
  const k = grab(svg, /<text class="rowname strong" role="button" tabindex="0" data-fold="kai"[^>]*>/);
  assert.equal((k.match(/p:p-[0-9a-f]{12}/g) || []).length, 2, 'the Overlap and the Too big');
  // Two of the team's agents in Loopline contracts: n2, as two agents of one person would be.
  assert.match(svg, /<rect class="cell red" data-k="pc:kai:4 /);
  const v2 = viewL();
  for (const p of v2.people) p.under = p.id === 'ada' ? 'kai' : v2.me.id;
  const svg2 = grab(page({ view: v2, now: NOWL }, { fold: ['kai'] }), /<svg class="fx okr"[^]*?<\/svg>/);
  assert.match(svg2, /<rect class="cell n2" data-k="pc:kai:5 /, 'Kai and Ada both in Loopline web');
});

test('rows r1: the tip counts the rows’ sideways scroll', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./page.ts', import.meta.url), 'utf8');
  assert.match(src, /box\.style\.left = \(x - r\.left \+ wrap\.scrollLeft\) \+ 'px';/);
  assert.match(src, /box\.style\.top = \(y - r\.top \+ wrap\.scrollTop\) \+ 'px';/);
});

// ---- Open kitchen rows, PR-Agent round 2 (#53) ----
test('rows r2: a quiet Mac’s merges are a floor: at least n, and a 0 is not checked', () => {
  const v = viewL();
  const R = board(v).rows;
  const lee = one(R.people, (r) => r.person === 'lee', 'lee');
  assert.deepEqual([lee.merged, lee.floor], [0, true]);
  const svg = grab(page({ view: v, now: NOWL }), /<svg class="fx okr"[^]*?<\/svg>/);
  assert.match(svg, /<text class="rowname"[^>]*data-tip="[^"]*Lee[^"]*not checked merged today/);
  const sam = who(v, 'sam'); Object.assign(sam, { online: false, lastSeen: agoL(60), at: agoL(60) });
  const svg2 = grab(page({ view: v, now: NOWL }), /<svg class="fx okr"[^]*?<\/svg>/);
  assert.match(svg2, />at least 2</);
});

test('rows r2: a call with no agent at work lights its person’s name: Ravi’s merge broke main', () => {
  const v = viewL();
  const ravi = one(board(v).rows.people, (r) => r.person === 'ravi', 'ravi');
  assert.deepEqual(ravi.calls.map((c) => c.kind), ['main']);
  const html = page({ view: v, now: NOWL });
  const svg = grab(html, /<svg class="fx okr"[^]*?<\/svg>/);
  const name = grab(svg, /<text class="rowname" tabindex="0" data-k="d:ravi [^"]*"/);
  const plate = grab(name, /p:(p-[0-9a-f]{12})/).slice(2);
  assert.ok(html.includes(`<div class="xc" role="listitem" data-team-open="${plate}">`));
});

test('rows r2: a pick keeps the folds; the rows’ tip sits outside their scroller', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const { pageScript } = await import('./test/served.ts');
  const fn = grab(pageScript(), /function withPicked[\s\S]*?\n {2}\}/);
  const ctx = vm.createContext({ URLSearchParams, location: { search: '?p=A&fold=kai&fx=860x600' } });
  vm.runInContext(fn, ctx);
  assert.equal(vm.runInContext("withPicked(['B', 'C d'])", ctx), '?p=B&p=C%20d&fold=kai&fx=860x600');
  assert.equal(vm.runInContext('withPicked(null)', ctx), '?fold=kai&fx=860x600');
  ctx.location.search = '?p=A';
  assert.equal(vm.runInContext('withPicked(null)', ctx), '');
  const src = readFileSync(new URL('./page.ts', import.meta.url), 'utf8');
  assert.equal((src.match(/withPicked\(/g) || []).length, 3, 'defined once, used by the menu and the chart click');
  assert.match(page({ view: viewL(), now: NOWL }), /<div class="fx-wrap ok-box"><div class="ok-wrap"><div class="fx-view"><svg[^]*?<\/svg><\/div><\/div><div class="fx-tip" hidden><\/div><\/div>/);
});

// ---- Open kitchen rows, PR-Agent round 3 (#53) ----
test('rows r3: a team with a member not checked counts at least; the longest merged label stays on the chart', () => {
  const v = viewL();
  for (const p of v.people) p.under = p.id === 'sam' ? 'kai' : v.me.id;
  Object.assign(who(v, 'sam'), { summary: null, at: null, lastSeen: null });
  const svg = grab(page({ view: v, now: NOWL }), /<svg class="fx okr"[^]*?<\/svg>/);
  assert.match(svg, />at least 1 agent · <tspan class="need">1 needs you<\/tspan></);
  assert.match(svg, /working, and a Mac not checked/);
  // A quiet Mac with the most merges: its bar leaves room for "at least 2" inside the 860 view.
  const w = viewL();
  Object.assign(who(w, 'sam'), { online: false, lastSeen: agoL(60), at: agoL(60) });
  const s2 = grab(page({ view: w, now: NOWL }), /<svg class="fx okr"[^]*?<\/svg>/);
  const x = Number(grab(s2, /<text class="mnum" x="([0-9.]+)"[^>]*>at least 2</).match(/x="([0-9.]+)"/)![1]);
  assert.ok(x + 'at least 2'.length * 6.2 <= 860, `label ends at ${x + 62}`);
});

// ---- Rows alone (Dan, 2026-11-12, "1. B-ish") ----
test('the rows fill the size the page sends, up to a cap, and keep their own height without one', () => {
  const svgOf = (h: string) => grab(h, /<svg class="fx okr"[^>]*>/);
  const H = (h: string) => Number(/viewBox="0 0 860 (\d+)"/.exec(svgOf(h))?.[1]);
  const rowsAt = (h: string) => [...grab(h, /<svg class="fx okr"[^]*?<\/svg>/).matchAll(/<text class="rowname[^"]*"[^>]*? y="([\d.]+)"/g)].map((m) => Number(m[1]));
  const own = page({ view: viewL(), now: NOWL });
  assert.doesNotMatch(svgOf(own), /data-fit/);
  const pitch = (h: string) => { const ys = rowsAt(h); return ys[1]! - ys[0]!; };
  assert.equal(pitch(own), 48, 'no size sent: each row keeps its own height');
  // 14 rows in a tall column: each grows to share it, and the chart reaches the column's foot.
  const tall = page({ view: viewL(), now: NOWL }, { fit: { w: 860, h: 1000 } });
  assert.match(svgOf(tall), /data-fit="860x1000"/);
  assert.equal(H(tall), 1000);
  assert.ok(pitch(tall) > 48 && pitch(tall) <= 72, String(pitch(tall)));
  // A column too short for 48 a row: the rows shrink to share it, so the chart and the key under it stay in view.
  const snug = page({ view: viewL(), now: NOWL }, { fit: { w: 860, h: 560 } });
  assert.ok(pitch(snug) >= 28 && pitch(snug) < 48, String(pitch(snug)));
  assert.equal(H(snug), 560);
  // Shorter still: rows stop at 28 and the column scrolls.
  const short = page({ view: viewL(), now: NOWL }, { fit: { w: 860, h: 300 } });
  assert.equal(pitch(short), 28);
  assert.ok(H(short) > 300);
  // Far more room than the rows need: they stop at the cap and the dotted field runs to the foot.
  const v = viewL();
  v.people = v.people.slice(0, 3);
  const roomy = page({ view: v, now: NOWL }, { fit: { w: 860, h: 1200 } });
  assert.equal(pitch(roomy), 72);
  assert.equal(H(roomy), 1200);
  assert.match(roomy, /fill="url\(#okdots\)"/);
});

test('a project’s name opens that project, as in You, expanded; with one open, the back button sits beside the picker', () => {
  const all = page({ view: viewL(), now: NOWL });
  assert.match(all, /<text class="pjname" data-drill="Fernpay" tabindex="0" role="button" aria-label="Open Fernpay"/);
  assert.doesNotMatch(grab(all, /<section class="tboard"[^]*?<\/header>/), /data-unpick/);
  const one1 = page({ view: viewL(), now: NOWL }, { picked: ['Fernpay'] });
  assert.doesNotMatch(one1, /class="pjname" data-drill/);
  assert.match(grab(one1, /<section class="tboard"[^]*?<\/header>/), /<\/details><button type="button" class="fx-back" data-unpick aria-label="Back to all projects"/);
});

test('the page measures the rows’ column from its parts, so a panel that already fills it can still grow', async () => {
  const { pageScript } = await import('./test/served.ts');
  const src = pageScript();
  const fn = grab(src, /function fitRows[\s\S]*?\n {2}\}/);
  assert.match(fn, /\.ok-foot/);
  assert.doesNotMatch(fn, /box\.getBoundingClientRect\(\)\.height/, 'the panel stretches, so its own height says nothing');
  assert.match(grab(src, /function fitFlow[\s\S]*?\n {2}\}/), /if \(fitRows\(\)\) return;/);
  assert.match(grab(src, /function watchFlow[\s\S]*?\n {2}\}/), /flowRO\.observe\(tb\)/);
});

test("a teammate's reviewers reach the lead's copy cleaned; a PR whose summary has none reads not checked", () => {
  const v = view();
  const k = who(v, 'maya').summary.tickets.find((t: Wire) => t.prs?.length);
  k.prs[0].reviewers = [{ who: 'ada', team: false, state: 'approved', at: NOW - 60000 }, { who: '<img src=x>', state: 'approved' }, { who: 'jon', state: 'lgtm' }];
  const ok = read(v);
  const mine = ok.tickets.find((t) => t.k.thread === k.thread)!;
  assert.deepEqual(mine.k.prs[0]!.reviewers, [{ who: 'ada', team: false, state: 'approved', at: NOW - 60000 }]);
  delete k.prs[0].reviewers;
  assert.equal(read(v).tickets.find((t) => t.k.thread === k.thread)!.k.prs[0]!.reviewers, null);
});
