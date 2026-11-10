// Open kitchen, the Your team view (step 4). Run: node --test client/open-kitchen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openKitchen, callId, below, reporting, reach, sortCalls, may, RULES } from './open-kitchen.mjs';
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

test('the made-up team gives the approved mock’s Pass: red first, then amber by age', () => {
  const ok = read(view());
  assert.equal(ok.status, 'live');
  assert.deepEqual(kinds(ok.pass), ['main:ravi', 'overlap:kai+jon', 'failing:nina', 'waiting:lee', 'big:iris', 'stuck:omar']);
  assert.deepEqual(ok.pass.map((c) => c.reach.why), ['red', 'red', 'runs', 'quiet', 'unseen', 'unseen']);
  // Ben marked his own alarm Seen, so it stays his.
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
  const html = page({ view: view(), now: NOW });
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
