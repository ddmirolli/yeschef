// Open kitchen, the Your team view (step 4). Run: node --test client/open-kitchen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openKitchen, kitchenBoard, callId, below, reporting, reach, sortCalls, may, RULES } from './open-kitchen.mjs';
import { fixtureView } from './open-kitchen.fixture.mjs';
import { renderApp } from './board.mjs';

const NOW = Date.UTC(2026, 10, 10, 14, 3);
const MIN = 60000;
const ago = (m) => NOW - m * MIN;
const view = () => fixtureView(NOW);
const who = (v, id) => v.people.find((p) => p.id === id);
const ticket = (v, id) => who(v, id).summary.tickets[0];
const read = (v) => openKitchen(v, { now: NOW });
const kinds = (calls) => calls.map((c) => `${c.kind}:${c.who.join('+')}`);
// Today's merges count from local midnight, so a test of them anchors the made-up team at 14:03 local time, on any TZ.
const NOWL = new Date(2026, 10, 10, 14, 3).getTime();
const agoL = (m) => NOWL - m * MIN;
const viewL = () => fixtureView(NOWL);

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
  const main = read(view()).pass[0];
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
  const p = (more) => ({ online: false, at: ago(11), summary: { tickets: [{ working: 1 }] }, ...more });
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
  const main = read(v).pass[0];
  assert.equal(main.facts.cause.pr.n, 431);
  assert.equal(main.facts.clean, true);
  assert.equal(main.holds, 4);
  assert.deepEqual(main.facts.waiting.map((w) => w.n).sort(), [436, 440, 444, 445]);
  // A commit after the first red one makes a roll back unclean, whoever pushed it.
  who(v, 'ravi').summary.bases[0].sha = 'f999';
  assert.equal(read(v).pass[0].facts.cause.pr.n, 431);
  assert.equal(read(v).pass[0].facts.clean, false);
  // The first red commit is no team merge (a direct push): no cause is named, even with older merges before it.
  v = view();
  who(v, 'ravi').summary.bases[0].redSha = 'd001';
  const none = read(v).pass[0];
  assert.equal(none.facts.cause, null);
  assert.deepEqual(none.who, []);
  // A later merge moves the head's time, never the break: the cause stays #431, and the roll back is no longer clean.
  v = view();
  const base = who(v, 'ravi').summary.bases[0];
  who(v, 'priya').summary.tickets[1].prs[0].mergedAt = base.committedAt = new Date(ago(100)).toISOString();
  Object.assign(who(v, 'priya').summary.tickets[1].prs[0], { mergeSha: 'f500' });
  base.sha = 'f500';
  const later = read(v).pass[0];
  assert.equal(later.facts.cause.pr.n, 431);
  assert.equal(later.facts.clean, false);
  assert.equal(later.id, read(view()).pass[0].id, 'the call keeps its id, so Seen still matches');
  // No first red commit: the cause is not checked.
  v = view();
  delete who(v, 'ravi').summary.bases[0].redSha;
  assert.equal(read(v).pass[0].facts.cause, null);
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
  const ov = read(view()).pass[1];
  assert.equal(ov.facts.files[0].path, 'contracts/src/orchestration.ts');
  assert.deepEqual(ov.facts.files[0].shared, [[120, 168]]);
  assert.equal(ov.facts.rebaser.person, 'jon', 'In progress rebases on In review');
  // Ada and Kai change web/src/sidebar.tsx on different lines: no call.
  assert.equal(read(view()).pass.filter((c) => c.kind === 'overlap').length, 1);
  const off = (edit) => { const v = view(); edit(v); return read(v).pass.some((c) => c.kind === 'overlap'); };
  assert.equal(off((v) => { ticket(v, 'jon').changes.files[0].r = null; }), false, 'ranges not read: not checked');
  assert.equal(off((v) => { ticket(v, 'jon').changes.files[0].x = 1; }), false, 'generated or lockfile');
  assert.equal(off((v) => { ticket(v, 'jon').changes.base = 'release'; }), false, 'another base');
  assert.equal(off((v) => { ticket(v, 'jon').changes.state = 'not-checked'; }), false);
  // A pure insertion [n + 1, n] is the point n + 1.
  assert.equal(off((v) => { ticket(v, 'jon').changes.files[0].r = [[171, 170]]; }), false);
  assert.equal(off((v) => { ticket(v, 'jon').changes.files[0].r = [[170, 169]]; }), true);
  // Same stage: the later start rebases.
  const v = view(); ticket(v, 'kai').place = 'In progress';
  assert.equal(read(v).pass.find((c) => c.kind === 'overlap').facts.rebaser.person, 'jon');
  ticket(v, 'jon').startedAt = new Date(ago(500)).toISOString();
  assert.equal(read(v).pass.find((c) => c.kind === 'overlap').facts.rebaser.person, 'kai');
});

test('Failing rises at 3 red runs, reaches the lead after 15 minutes unseen, and at 6 runs whatever is seen', () => {
  const ben = () => read(view()).held.find((c) => c.who[0] === 'ben');
  assert.equal(ben().facts.redRuns, 3);
  assert.equal(ben().since, ago(30));
  // Unseen, its wait starts at the third red run, not the first.
  let v = view(); who(v, 'ben').summary.seen = {};
  assert.ok(read(v).held.some((c) => c.who[0] === 'ben'), 'the third run was 2 min ago');
  for (const r of ticket(v, 'ben').prs[0].checks.runs) r.at -= 20 * MIN;
  assert.deepEqual(read(v).pass.find((c) => c.who[0] === 'ben').reach, { lead: true, why: 'unseen', min: 15 });
  v = view(); ticket(v, 'ben').prs[0].checks.redRuns = 2;
  assert.ok(![...read(v).pass, ...read(v).held].some((c) => c.who[0] === 'ben'));
  const call = { kind: 'failing', who: ['x'], since: ago(1), facts: { redRuns: 6 } };
  assert.deepEqual(reach(call, { seen: { x: ago(1) }, now: NOW }), { lead: true, why: 'runs', runs: 6 });
});

test('Stuck needs a running thread and a reporting Mac; Waiting still rises while the dev is away', () => {
  let v = view(); ticket(v, 'omar').working = 0;
  assert.ok(!read(v).pass.some((c) => c.kind === 'stuck'));
  v = view(); Object.assign(who(v, 'omar'), { online: false, at: ago(30) });
  const ok = read(v);
  assert.ok(!ok.pass.some((c) => c.kind === 'stuck'), 'a quiet Mac makes every thread look quiet');
  assert.equal(ok.people.find((p) => p.id === 'omar').state, 'quiet');
  // Lee is away: the question reaches the lead at once.
  assert.equal(read(view()).pass.find((c) => c.kind === 'waiting').reach.why, 'quiet');
  // Back online: under 30 minutes it stays Lee's; at 30 it reaches the lead.
  v = view(); Object.assign(who(v, 'lee'), { online: true }); ticket(v, 'lee').ask.at = ago(20);
  assert.ok(read(v).held.some((c) => c.kind === 'waiting'));
  ticket(v, 'lee').ask.at = ago(31);
  assert.equal(read(v).pass.find((c) => c.kind === 'waiting').reach.why, 'time');
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
  const c = (id, kind, holds, since) => ({ id, kind, holds, since, who: [] });
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
const page = (team) => renderApp({ board: { tickets: [], runsChecked: false }, link: () => 'x', status: { ok: true, at: NOW, ms: 1 }, origin: 'https://t3.example', team });

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
  // Seen, and why it reached you.
  assert.match(html, /<b class="ok">Seen<\/b> by Kai at [0-9:]+\. Jon has not seen it\. Red calls reach you at once\./);
  assert.match(html, /<b class="no">Not seen<\/b> by Lee\. Lee is not reporting, so it reached you at once\./);
  assert.match(html, /<b>Not reporting since [0-9:]+\.<\/b>/);
  // Main broken: the team's merges today, the break in red; Overlap: the shared lines boxed.
  assert.match(html, /<div class="ribbon">(<i title="[^"]*"><\/i>){4}<i class="r" title="#431/);
  assert.match(html, /Lines 120 to 168, both/);
});

test('team actions show by role and never send: a see-only Engineer gets Settle and a line, no note', () => {
  const lead = page({ view: view(), now: NOW });
  assert.match(lead, /<form class="act team-act" method="post" action="\/act" data-plate="p-[0-9a-f]{12}">/);
  // No nonce and no thread: the server could not take a team form even if one were sent.
  for (const f of lead.match(/<form class="act team-act"[^]*?<\/form>/g)) assert.doesNotMatch(f, /name="(nonce|thread)"/);
  assert.match(lead, /value="rollback" class="ab fill primary"/);
  const v = view(); v.me = { id: 'me', name: 'Dana', role: 'engineer', perms: ['see'] };
  const eng = page({ view: v, now: NOW });
  const forms = eng.match(/<form class="act team-act"[^]*?<\/form>/g);
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
  const v = fixtureView(now);
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
  assert.equal(k.pass.find((c) => c.kind === 'main').facts.cause, null, 'the PR with a bad number drops, and no other is blamed');
  assert.ok(!page({ view: v, now: NOW }).includes('<img src=x'));
  v = view();
  const jon = who(v, 'jon').summary.tickets[0].changes.files.find((f) => f.p === 'contracts/src/orchestration.ts');
  jon.r = [null, ...jon.r];
  const ov = read(v).pass.find((c) => c.kind === 'overlap');
  assert.ok(ov.facts.files[0].b.every((r) => Array.isArray(r)));
  assert.doesNotThrow(() => page({ view: v, now: NOW }));
  assert.equal(ov.facts.near, false, 'one merge base: exact');
  v = view();
  who(v, 'jon').summary.tickets[0].changes.mergeBase = 'b9';
  assert.equal(read(v).pass.find((c) => c.kind === 'overlap').facts.near, true);
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
  const m = read(v).pass.find((c) => c.kind === 'main');
  assert.notEqual(m.facts.cause?.pr.n, 431);
  v = view(); ticket(v, 'iris').prs[0].base = undefined;
  assert.ok(!read(v).pass.find((c) => c.kind === 'main').facts.waiting.some((w) => w.n === 440));
  // Ravi's Mac goes quiet: his merge still dates the break (Maya reads the base now).
  v = view();
  who(v, 'maya').summary.bases = [{ ...who(v, 'ravi').summary.bases[0], at: ago(1) }];
  Object.assign(who(v, 'ravi'), { online: false, lastSeen: ago(60), at: ago(60) });
  assert.equal(read(v).pass.find((c) => c.kind === 'main').facts.cause.pr.n, 431);
  // Too big with no overAt: its age is not checked, so time never sends it to the lead.
  v = view(); delete ticket(v, 'iris').prs[0].size.overAt;
  const big = read(v).held.find((c) => c.kind === 'big');
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
  const paths = [];
  const walk = (o, path) => {
    if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], [...path, k]);
    else paths.push(path);
  };
  base.people.forEach((p, i) => walk(p, ['people', i]));
  assert.ok(paths.length > 300, `walked ${paths.length} leaves`);
  for (const path of paths) for (const bad of evil) {
    const v = view();
    let o = v; for (const k of path.slice(0, -1)) o = o[k];
    o[path.at(-1)] = bad;
    let html;
    assert.doesNotThrow(() => { html = page({ view: v, now: NOW }); }, `${path.join('.')} = ${JSON.stringify(bad)}`);
    assert.ok(!html.includes('<b>x</b>'), path.join('.'));
  }
});

test('review r4: a picked project narrows the team’s calls; a red base with no cause names its repo', () => {
  const v = view();
  const html = renderApp({ board: { tickets: [], runsChecked: false }, picked: ['Quillo'], link: () => 'x', status: { ok: true, at: NOW, ms: 1 }, origin: 'https://t3.example', team: { view: v, now: NOW } });
  const tiles = html.match(/class="tile call-tile mail team-tile"/g) || [];
  assert.equal(tiles.length, 2, 'Nina’s Failing and Lee’s Waiting');
  who(v, 'ravi').summary.bases[0].redSha = 'd001';
  const m = read(v).pass.find((c) => c.kind === 'main');
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
  const ov = read(v).pass.find((c) => c.kind === 'overlap');
  assert.equal(ov.facts.keeper.pr.n, 412);
  assert.deepEqual(ov.prs.map((p) => p.n), [412, 415]);
  assert.match(page({ view: v, now: NOW }), /rebase on #412/);
  v = view();
  const b = who(v, 'ravi').summary.bases[0];
  b.branch = 'release@v2';
  for (const p of v.people) for (const k of p.summary?.tickets || []) for (const pr of k.prs) pr.base = 'release@v2';
  assert.equal(read(v).pass.find((c) => c.kind === 'main').facts.cause.pr.n, 431);
  v = view(); delete ticket(v, 'ravi').prs[0].size.added;
  assert.doesNotMatch(page({ view: v, now: NOW }), /5 files, \+0/);
});

test('review r6: a summary that is not an object with tickets is not checked, never On track', () => {
  for (const bad of [7, 'x', { tickets: 'no' }, []]) {
    let v = view(); who(v, 'maya').summary = bad;
    assert.equal(read(v).people.find((p) => p.id === 'maya').state, 'unknown');
    v = view(); for (const p of v.people) if (p.id !== 'me') p.summary = bad;
    assert.equal(read(v).status, 'not-checked');
  }
});

// ---- PR B: Your team, expanded ----
const board = (v, want = null) => kitchenBoard(openKitchen(v, { now: NOWL }), { now: NOWL, want });
const hmOf = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

test('expanded: the instruments from the made-up team', () => {
  const B = board(viewL());
  assert.equal(B.people, 14);
  assert.equal(B.base.state, 'red');
  assert.equal(B.base.since, agoL(141));
  assert.deepEqual(B.base.merges.map((m) => `${m.n}:${m.tone}`), ['425:merged', '427:merged', '429:merged', '430:merged', '431:red']);
  // One mark per merge it counts, so the base and Merged today agree (brief, departure 1).
  assert.equal(B.merged.count, B.base.merges.length);
  assert.equal(B.merged.byHour.reduce((a, n) => a + n, 0), 5);
  assert.equal(B.merged.usual, null, 'no merge history is sent, so usual by now is not checked');
  assert.deepEqual(B.review, { count: 3, gap: { away: 1, capped: 0 }, ages: [236, 128, 44].map((m) => m * MIN) });
  // Lee is not reporting, so their thread's agent is not counted as running now; Tom's planned thread runs none.
  assert.deepEqual(B.agents, { count: 20, threads: 12, gap: { away: 1, capped: 0 } });
});

test('expanded: Who’s on what puts In The Pass first, links the Overlap, and hatches a quiet Mac', () => {
  const B = board(viewL());
  const T = B.timeline;
  assert.deepEqual(T.rows.map((r) => r.state).filter((s, i, a) => a.indexOf(s) === i), ['pass', 'alarm', 'quiet', 'track']);
  const lee = T.rows.find((r) => r.person === 'lee');
  assert.equal(lee.quiet.since, agoL(122));
  assert.equal(lee.bars[0].end, agoL(122), 'a quiet dev’s bar stops at their last report');
  assert.equal(lee.bars[0].call.kind, 'waiting');
  const ravi = T.rows.find((r) => r.person === 'ravi');
  assert.deepEqual(ravi.bars.map((b) => [b.title, b.call?.kind || null, b.merged !== null]), [['Updater channel picker', 'main', true], ['Nightly icon', null, false]]);
  assert.equal(T.rows.find((r) => r.person === 'ben').bars[0].call.mine, false, 'Ben holds their own alarm');
  assert.deepEqual(T.links.map((l) => [l.a, l.b, l.file]), [['kai', 'jon', 'contracts/src/orchestration.ts']]);
  assert.ok(T.rows.every((r) => r.bars.every((b) => b.start >= T.from && b.end <= T.to && b.start <= b.end)));
});

test('expanded: files two live threads change, same lines first', () => {
  const F = board(viewL()).files;
  assert.deepEqual(F.rows.map((f) => [f.path, f.state, f.people.join('+')]), [['contracts/src/orchestration.ts', 'same', 'kai+jon'], ['web/src/sidebar.tsx', 'different', 'kai+ada']]);
  assert.ok(F.rows[0].call.mine);
  assert.equal(F.at, agoL(1));
});

test('expanded: what no summary says stays not checked, never a guess', () => {
  let v = viewL();
  delete ticket(v, 'kai').prs[0].readyAt;
  assert.equal(board(v).review.ages, null, 'one PR with no ready time leaves the ages not checked');
  v = viewL();
  who(v, 'ravi').summary.bases = [];
  assert.equal(board(v).base.state, null);
  v = viewL();
  delete ticket(v, 'ada').changes.files[0].r;
  const F = board(v).files;
  assert.equal(F.rows.find((f) => f.path === 'web/src/sidebar.tsx').state, 'nc');
  v = viewL();
  delete ticket(v, 'kai').changes.at;
  assert.equal(board(v).files.at, null);
  // A thread with no start time is counted, not drawn; work merged before today is not drawn at all.
  v = viewL();
  delete ticket(v, 'tom').startedAt;
  const tom = board(v).timeline.rows.find((r) => r.person === 'tom');
  assert.deepEqual([tom.bars.length, tom.untimed], [0, 1]);
  v = viewL();
  who(v, 'maya').summary.tickets[1].prs[0].mergedAt = new Date(NOWL - 30 * 60 * MIN).toISOString();
  assert.equal(board(v).timeline.rows.find((r) => r.person === 'maya').bars.length, 1);
  assert.equal(kitchenBoard(openKitchen({ ...viewL(), link: 'offline' }, { now: NOWL }), { now: NOWL }), null);
});

test('expanded: a picked project narrows the board', () => {
  const B = board(viewL(), new Set(['Quillo']));
  assert.deepEqual(B.timeline.rows.map((r) => r.person).sort(), ['elena', 'lee', 'nina', 'tom']);
  assert.equal(B.base.state, null, 'the red base is in another project’s repo');
  assert.equal(B.merged.count, 0);
  assert.equal(B.files.rows.length, 0);
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
  for (const w of ['working', 'merged', 'red: act now', 'amber: decide soon', 'not reporting']) assert.ok(html.includes(w), w);
  // Lee's Mac is not reporting, so Merged today may be low: it says at least, and why.
  assert.ok(html.includes('<b>5</b><span>at least</span>'));
  assert.ok(html.includes(`Mac quiet since ${hmOf(agoL(122))}`));
  assert.ok(html.includes('6 need you, most urgent first.'));
  // The suggestion button is the call's first action, and only for a role that may take it.
  assert.match(html, /data-team-act="rollback">Roll back #431</);
  const v = viewL(); v.me = { ...v.me, role: 'engineer', perms: ['see'] };
  assert.ok(!page({ view: v, now: NOWL }).includes('data-team-act='), 'See only: Open, never the suggestion');
});

// ---- PR B, PR-Agent round 1 ----
test('r1: a merge is red only in the base’s current run of red; no merge is ever called green', () => {
  let v = viewL();
  who(v, 'ravi').summary.bases[0].requiredResult = 'passing';
  assert.ok(board(v).base.merges.every((m) => m.tone === 'merged'), 'a green base now says nothing about earlier merges');
  v = viewL();
  who(v, 'ravi').summary.bases[0].redSince = null;
  assert.deepEqual(board(v).base.merges.map((m) => m.tone), ['merged', 'merged', 'merged', 'merged', 'red'], 'the red commit itself is still red');
  const html = page({ view: viewL(), now: NOWL });
  assert.ok(!html.includes('merged while green'));
});

test('r1: lines from two merge bases are not checked, never Different lines. Fine', () => {
  const v = viewL();
  ticket(v, 'ada').changes.mergeBase = 'b1';
  const f = board(v).files.rows.find((r) => r.path === 'web/src/sidebar.tsx');
  assert.deepEqual([f.state, f.near], ['nc', true]);
  assert.ok(page({ view: v, now: NOWL }).includes('Lines not checked: two merge bases'));
});

test('r1: live threads whose files were not sent are counted, so an empty list is never an all clear', () => {
  const v = viewL();
  const F0 = board(v).files;
  const before = F0.unread;
  delete ticket(v, 'ada').changes;
  const F = board(v).files;
  assert.equal(F.unread, before + 1);
  assert.equal(F.compared, F0.compared - 1);
  assert.match(page({ view: v, now: NOWL }), new RegExp(`${F.unread} live threads? not checked`));
});

test('r1: a merged PR with no time makes the count a floor, never dropped', () => {
  const v = viewL();
  const n = board(v).merged.count;
  ticket(v, 'kai').prs[0].state = 'merged';
  ticket(v, 'kai').prs[0].mergedAt = null;
  const M = board(v).merged;
  assert.deepEqual([M.count, M.untimed], [n, 1]);
  assert.ok(page({ view: v, now: NOWL }).includes('Not counted: 1 merge with no time, 1 Mac not reporting'));
});

test('r1: a call’s word is inside its bar, so a click on the word opens the call', () => {
  const html = page({ view: viewL(), now: NOWL });
  const tags = (html.match(/<span class="tltag /g) || []).length;
  const inBar = /<(button|span) (?:type="button" )?class="tlb[^"]*"[^>]*>(?:<span class="tlt">[^<]*<\/span>)?<span class="tltag [^>]*>[^<]*<\/span><\/\1>/g;
  const inButton = [...html.matchAll(inBar)].filter((m) => m[1] === 'button').length;
  assert.ok(tags > 0);
  assert.equal([...html.matchAll(inBar)].length, tags, 'every tag is inside its bar');
  assert.ok(inButton > 0, 'a call in The Pass: the bar and its word are one button');
});

// ---- PR B, PR-Agent round 2 ----
test('r2: a thread that sent only part of its files is counted, so a clear list says so', () => {
  const v = viewL();
  ticket(v, 'ada').changes.more = 12;
  const F = board(v).files;
  assert.equal(F.partial, 1);
  assert.ok(page({ view: v, now: NOWL }).includes('1 thread sent only part of its files.'));
  assert.equal(board(viewL()).files.partial, 0);
});

test('r2: a Mac that is not reporting makes Waiting for review and Agents running say so, never a bare 0', () => {
  const html = page({ view: viewL(), now: NOWL });
  assert.equal((html.match(/<span class="cap"><span>Not counted: 1 Mac not reporting<\/span><\/span>/g) || []).length, 3, 'under Merged today, Waiting for review and Agents running');
  // With no live PR in review and a Mac out, the count is not checked.
  const v = viewL();
  for (const id of ['kai', 'nina', 'iris']) ticket(v, id).place = 'In progress';
  const B = board(v);
  assert.deepEqual([B.review.count, B.review.gap.away], [0, 1]);
  assert.match(page({ view: v, now: NOWL }), /<b class="nc">Not checked<\/b><span>1 Mac not reporting<\/span>/);
  // A picked project counts only the Macs out that may have work in it.
  assert.equal(board(viewL(), new Set(['Fernpay'])).review.gap.away, 0);
  assert.equal(board(viewL(), new Set(['Quillo'])).review.gap.away, 1);
});

test('r2: a Mac quiet since before the window draws from the window’s edge and keeps its real time', () => {
  const v = viewL();
  const lee = who(v, 'lee');
  lee.lastSeen = NOWL - 20 * 60 * MIN;
  lee.at = lee.lastSeen;
  const T = board(v).timeline;
  assert.ok(T.rows.find((r) => r.person === 'lee').quiet.since < T.from);
  const html = page({ view: v, now: NOWL });
  const band = html.match(/<span class="tlb off clip" style="[^"]*left:([0-9.]+)%[^"]*">Mac quiet since ([^<]+)</);
  assert.ok(band, 'the band is clipped at the window');
  assert.equal(Number(band[1]), 0);
  assert.equal(band[2], new Date(NOWL - 20 * 60 * MIN).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
});

// ---- PR B, PR-Agent round 3 ----
test('r3: a summary that left threads out makes every team count say so', () => {
  const v = viewL();
  who(v, 'kai').summary.more = 4;
  const B = board(v);
  for (const g of [B.merged.gap, B.review.gap, B.agents.gap]) assert.deepEqual(g, { away: 1, capped: 1 });
  assert.equal((page({ view: v, now: NOWL }).match(/Not counted: 1 Mac not reporting, 1 Mac that sent part of its threads/g) || []).length, 3);
  // Lee alone, with no capped summary and Lee back: no caption, and Merged today is a plain count.
  const w = viewL();
  Object.assign(who(w, 'lee'), { online: true, lastSeen: null, at: agoL(1) });
  const html = page({ view: w, now: NOWL });
  assert.ok(!html.includes('Not counted:'));
  assert.ok(html.includes('usual by now: not checked'));
});

test('r3: a PR any summary reports merged never waits for review', () => {
  const v = viewL();
  const n = board(v).review.count;
  // Ravi's thread also holds Kai's #412, and reports it merged; Kai's copy still says open.
  who(v, 'ravi').summary.tickets[0].prs.push({ ...ticket(v, 'kai').prs[0], state: 'merged', mergedAt: new Date(agoL(5)).toISOString() });
  assert.equal(board(v).review.count, n - 1);
});

// ---- PR B, PR-Agent round 4 ----
test('r4: a Mac whose summary left threads out qualifies the shared files list too', () => {
  const v = viewL();
  who(v, 'kai').summary.more = 4;
  assert.equal(board(v).files.capped, 1);
  assert.ok(page({ view: v, now: NOWL }).includes('1 Mac sent only part of its threads.'));
  assert.equal(board(viewL()).files.capped, 0);
});

// ---- PR B, PR-Agent round 5 ----
test('r5: a merged thread with one PR of no merge time has no known end, so it is not drawn as merged early', () => {
  const v = viewL();
  const maya = who(v, 'maya').summary.tickets.find((k) => k.place === 'Merged');
  const first = board(v).timeline.rows.find((r) => r.person === 'maya').bars.find((b) => b.thread === maya.thread);
  assert.ok(first && first.merged !== null);
  maya.prs.push({ ...maya.prs[0], n: 999, mergedAt: null });
  assert.equal(board(v).timeline.rows.find((r) => r.person === 'maya').bars.find((b) => b.thread === maya.thread), undefined);
});

test('r5: checked changes with no repo are not checked, never counted as read', () => {
  const v = viewL();
  const B0 = board(v).files;
  ticket(v, 'ada').changes.repo = null;
  const F = board(v).files;
  assert.deepEqual([F.compared, F.unread], [B0.compared - 1, B0.unread + 1]);
  assert.ok(!F.rows.some((f) => f.path === 'web/src/sidebar.tsx'));
});

// ---- PR B, PR-Agent round 6 ----
test('r6: in a picked project, a Mac out whose summary left threads out still counts as not counted', () => {
  const v = viewL();
  assert.equal(board(v, new Set(['Fernpay'])).review.gap.away, 0, 'Lee works in Quillo only');
  who(v, 'lee').summary.more = 3;
  assert.equal(board(v, new Set(['Fernpay'])).review.gap.away, 1);
});

test('r6: a merge with a known time in any copy is never counted as having no time', () => {
  const v = viewL();
  const merged = who(v, 'maya').summary.tickets.find((k) => k.place === 'Merged');
  // Kai's thread holds a copy of Maya's PR with no time; Maya's copy has one.
  ticket(v, 'kai').prs.push({ ...merged.prs[0], mergedAt: null });
  assert.equal(board(v).merged.untimed, 0);
  // Moved before today, the known copy still settles it: not today's, and not untimed.
  merged.prs[0].mergedAt = new Date(NOWL - 30 * 60 * MIN).toISOString();
  assert.equal(board(v).merged.untimed, 0);
});

// ---- PR B, PR-Agent round 7 ----
test('r7: in a picked project, a merge whose time is in another project’s copy is counted with that time', () => {
  const v = viewL();
  const merged = who(v, 'maya').summary.tickets.find((k) => k.place === 'Merged');
  // Tom's Quillo thread holds a copy of Maya's Fernpay PR with no time; Maya's own copy (Fernpay) has today's time.
  who(v, 'tom').summary.tickets[0].prs = [{ ...merged.prs[0], mergedAt: null }];
  const M = board(v, new Set(['Quillo'])).merged;
  assert.deepEqual([M.count, M.untimed], [1, 0]);
});

// ---- PR B, PR-Agent round 8 ----
test('r8: one repo with two base branches reads as one repo and two branches, never 2 repos', () => {
  const v = viewL();
  const base = who(v, 'ravi').summary.bases[0];
  Object.assign(base, { result: 'passing', requiredResult: 'passing', redSha: null, redSince: null, failing: [] });
  who(v, 'ravi').summary.bases.push({ ...base, branch: 'release', sha: 'r1' });
  const html = page({ view: v, now: NOWL });
  assert.ok(html.includes('<b class="green">Green</b><span>fernpay, 2 branches</span>'));
  assert.ok(!html.includes('2 repos'));
  // Both red: each named by its branch, once.
  for (const b of who(v, 'ravi').summary.bases) Object.assign(b, { result: 'failing', requiredResult: 'failing', redSince: new Date(agoL(60)).toISOString() });
  assert.match(page({ view: v, now: NOWL }), /<b class="red">Red<\/b><span>since [0-9:]+, fernpay main and fernpay release<\/span>/);
});

test('r8: a call’s word may shorten, and never leaves its bar', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.ok(css.includes('.tlb:has(.tltag){display:flex;padding-right:0;overflow:hidden}'));
  assert.ok(css.includes('.tlb .tltag{position:static;flex:0 1 auto;min-width:0;'));
});

// ---- PR B, PR-Agent round 9 ----
test('r9: in a picked project, a PR whose copy there says open is counted as merged when another copy says so', () => {
  const v = viewL();
  const merged = who(v, 'maya').summary.tickets.find((k) => k.place === 'Merged');
  who(v, 'tom').summary.tickets[0].prs = [{ ...merged.prs[0], state: 'open', mergedAt: null }];
  const M = board(v, new Set(['Quillo'])).merged;
  assert.deepEqual([M.count, M.untimed], [1, 0]);
});

test('r9: a missing merge base is not checked, never said to be two merge bases', () => {
  const v = viewL();
  delete ticket(v, 'ada').changes.mergeBase;
  const f = board(v).files.rows.find((r) => r.path === 'web/src/sidebar.tsx');
  assert.deepEqual([f.state, f.near], ['nc', false]);
  const html = page({ view: v, now: NOWL });
  assert.ok(!html.includes('two merge bases'));
  assert.ok(html.includes('Lines not checked'));
});

// ---- PR B, PR-Agent round 10 ----
test('r10: a merge’s branch and commit come from whichever copy gives them, so the ribbon still marks the break', () => {
  const v = viewL();
  const ravi = who(v, 'ravi').summary.tickets.find((k) => k.prs.some((pr) => pr.n === 431));
  const pr431 = ravi.prs.find((pr) => pr.n === 431);
  // An earlier copy (Kai's thread, read first) says #431 is open and names no base.
  who(v, 'kai').summary.tickets[0].prs.push({ ...pr431, state: 'open', mergedAt: null, base: null, mergeSha: null });
  const i = v.people.findIndex((p) => p.id === 'kai');
  v.people.splice(1, 0, ...v.people.splice(i, 1));
  assert.equal(v.people[1].id, 'kai', 'Kai is read before Ravi');
  const m = board(v).base.merges.find((x) => x.n === 431);
  assert.equal(m.tone, 'red', 'the merged copy names main, so the break is marked');
});

// ---- PR B, PR-Agent round 11 ----
test('r11: checked changes with no base branch are not checked, never counted as read', () => {
  const v = viewL();
  const F0 = board(v).files;
  ticket(v, 'ada').changes.base = null;
  const F = board(v).files;
  assert.deepEqual([F.compared, F.unread], [F0.compared - 1, F0.unread + 1]);
  assert.ok(!F.rows.some((f) => f.path === 'web/src/sidebar.tsx'));
});

test('the axis drops an hour label that would run into now, and keeps its grid line', () => {
  const at = new Date(2026, 10, 10, 16, 6).getTime();
  const html = page({ view: fixtureView(at), now: at });
  const axis = html.match(/<div class="tlax">[^]*?<\/div><\/div>/)[0];
  assert.ok(!axis.includes('>16:00<'), 'six minutes before now: no label');
  assert.ok(axis.includes('>15:00<'));
});

// ---- PR B, PR-Agent round 13 ----
test('r13: a merge is credited to the person whose copy says merged, not the first that mentions it', () => {
  const v = viewL();
  const pr431 = who(v, 'ravi').summary.tickets.find((k) => k.prs.some((pr) => pr.n === 431)).prs.find((pr) => pr.n === 431);
  who(v, 'kai').summary.tickets[0].prs.push({ ...pr431, state: 'open', mergedAt: null });
  const i = v.people.findIndex((p) => p.id === 'kai');
  v.people.splice(1, 0, ...v.people.splice(i, 1));
  assert.equal(board(v).base.merges.find((m) => m.n === 431).person, 'ravi');
});
