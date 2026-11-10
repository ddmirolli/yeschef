// Open kitchen, the Your team view (step 4): the calls each Mac derives from its teammates' sealed summaries, who they
// reach, and in what order. No I/O: the screens (client/board.mjs) draw what this returns.
//
// Input: the team as client/team.mjs Team.view() gives it (3b). The summary fields this reads beyond 3b's v1
// (bases, seen, and per ticket startedAt, last, ask, changes, prs[].mergedAt/size/checks/draft) are PROPOSED: agreed
// with 3b and landing in its PR 4. The board (PR B) proposes two more: prs[].readyAt (when a PR was marked ready for
// review) and changes.at (when its changed files were read). Every one is optional. Whatever a summary lacks is "Not checked": no call is raised
// from a guess, and nothing old is shown as live.
//
// The words are the locked ones (docs/pass-definitions-v1_0.md): The Pass, Seen, Overlap. The thresholds are the
// proposed defaults; Rules will set them per project.

export const RULES = {
  escalateMin: 15, // an amber call reaches the lead when nobody marks it Seen within this time
  failRuns: 3, failLeadRuns: 6, // Failing: raised at 3 red runs in a row, reaches the lead at 6 whatever is seen
  stuckMin: 20, // Stuck: a running thread with no message, commit or check for this long
  waitMin: 15, waitLeadMin: 30, // Waiting: raised after 15 min, reaches the lead after 30 (or at once if Not reporting)
  bigLines: 800, bigFiles: 30, bigLeadMin: 30, // Too big: lockfiles and generated files left out
  quietMin: 10, // Not reporting: nothing from the dev's Mac for this long while it had live threads
};

/** Each call's word and colour. Red: act now. Amber: decide soon. A colour never shows without its word. */
export const KINDS = {
  main: { word: 'Main broken', tone: 'red' },
  overlap: { word: 'Overlap', tone: 'red' },
  waiting: { word: 'Waiting', tone: 'amber' },
  failing: { word: 'Failing', tone: 'amber' },
  stuck: { word: 'Stuck', tone: 'amber' },
  big: { word: 'Too big', tone: 'amber' },
};
const TONE_RANK = { red: 0, blue: 1, amber: 2 };
const STAGE_RANK = { Backlog: 0, Planned: 1, 'In progress': 2, 'In review': 3, 'Ready to merge': 4, Merged: 5 };
const MIN = 60000;

/** A call's id: `kind:subject:since`. Every Mac derives the same id from the same summary, so a dev's Seen (kept by
 *  their own Yes Chef and sent in their summary) matches the lead's call. subject: the thread, or repo@branch for main. */
export function callId(kind, subject, since) {
  return `${kind}:${subject}:${Number.isFinite(since) ? since : 0}`;
}

// A time from a teammate's summary: a number or a date string; anything else is not checked.
const ms = (v) => { const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// A teammate's summary is outside data: a list that is not one reads as empty, and an entry that is not an object drops.
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
// A PR from a teammate's summary counts only with a whole number and an owner/name repo: both reach the page's markup.
const okPr = (pr) => Number.isInteger(pr.n) && pr.n > 0 && typeof pr.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(pr.repo);
const str = (v) => (typeof v === 'string' ? v : null);
// Every field the calls and the screens read from a teammate's summary, as its own type or null (not checked). The
// detectors and the readers read only this copy, so an odd value in a summary can never throw or reach the markup.
function cleanTicket(k) {
  const pr = (x) => ({ repo: x.repo, n: x.n, state: str(x.state), url: str(x.url), base: str(x.base), draft: x.draft === true,
    mergedAt: ms(x.mergedAt), mergeSha: str(x.mergeSha), readyAt: ms(x.readyAt),
    size: x.size && typeof x.size === 'object' ? { files: num(x.size.files), added: num(x.size.added), removed: num(x.size.removed), overAt: ms(x.size.overAt) } : null,
    checks: x.checks && typeof x.checks === 'object' ? { result: str(x.checks.result), redRuns: num(x.checks.redRuns), runs: arr(x.checks.runs).map((r) => ({ at: ms(r.at), result: str(r.result) })) } : null });
  const c = k.changes && typeof k.changes === 'object' ? k.changes : null;
  const a = k.ask && typeof k.ask === 'object' ? k.ask : null;
  return {
    thread: str(k.thread), title: str(k.title), project: str(k.project), place: str(k.place), working: num(k.working) ?? 0,
    startedAt: ms(k.startedAt), updatedAt: ms(k.updatedAt), last: str(k.last),
    prs: arr(k.prs).filter(okPr).map(pr),
    ask: a ? { at: ms(a.at), q: str(a.q), rec: str(a.rec), options: arr(a.options).map((o) => ({ k: str(o.k), t: str(o.t) })) } : null,
    changes: c ? { state: str(c.state), at: ms(c.at), repo: str(c.repo), base: str(c.base), mergeBase: str(c.mergeBase), headAt: ms(c.headAt), more: num(c.more),
      files: arr(c.files).map((f) => ({ p: str(f.p), r: Array.isArray(f.r) ? f.r.filter(rng) : null, a: num(f.a), d: num(f.d), x: !!f.x })) } : null,
  };
}
const cleanBase = (b) => ({ repo: str(b.repo), branch: str(b.branch), sha: str(b.sha), title: str(b.title), requiredResult: str(b.requiredResult),
  redSha: str(b.redSha), redSince: ms(b.redSince), at: num(b.at), failing: (Array.isArray(b.failing) ? b.failing : []).filter((x) => typeof x === 'string').slice(0, 5) });
const prKey = (repo, n) => `${String(repo).toLowerCase()}#${n}`;

/** Who is below me. Until 3b's chart carries `under`, a lead has everyone on the roster below them and nobody else
 *  has anyone (the rule 3b and step 4 agreed). With `under`, it is everyone below me, at every level. */
export function below(view) {
  const me = view?.me?.id, people = arr(view?.people);
  if (!me) return [];
  if (!people.some((p) => p.under)) return view?.lead ? people.filter((p) => p.id !== me) : [];
  const out = [], seen = new Set([me]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of people) if (!seen.has(p.id) && seen.has(p.under)) { seen.add(p.id); out.push(p); grew = true; }
  }
  return out;
}

/** Is the dev's Mac reporting? true, false, or null when Yes Chef cannot say (no summary yet, or this Mac is
 *  offline: then nobody reads as reporting). lastSeen: the relay's time their socket last closed (proposed), else the
 *  summary's own signed time. */
// A summary counts as a report only when it is an object with a list of tickets; anything else is not checked.
const okSummary = (s) => !!s && typeof s === 'object' && Array.isArray(s.tickets);
export function reporting(p, { now, link, rules = RULES }) {
  if (link !== 'online' || !okSummary(p.summary)) return null;
  if (p.online) return true;
  const last = num(p.lastSeen) ?? num(p.at);
  if (last === null) return null;
  const live = arr(p.summary.tickets).some((k) => num(k.working) > 0);
  return !(live && now - last >= rules.quietMin * MIN);
}

// ---- The detectors. Each returns calls: { id, kind, tone, subject, since, who: [person ids], thread, project,
// prs, holds, facts }. `facts` is what the reader shows; numbers stay numbers, and the screens format them. ----

/** Main broken: a required check fails on a base branch (3a's requiredResult; null is not checked). The break is the
 *  first red commit in the current run of red: `redSha` and its time `redSince` (proposed: the dev's Mac keeps them
 *  from read to read). The head's own `committedAt` moves with every merge, so it never names a cause. The cause is
 *  the team's PR whose merge commit is that first red commit (proposed `pr.mergeSha`); a direct push, or a merge no
 *  summary carries, names no cause. The roll back is clean only while that commit is still the head. Bases come only from Macs online now (another dev's merge can turn a base red or green while
 *  a Mac is away), deduplicated by the newest read. */
function liveBases(people) {
  const bases = new Map();
  for (const p of people) for (const b of p.reporting && p.online === true ? arr(p.summary?.bases).map(cleanBase) : []) {
    if (!b.repo || !b.branch) continue;
    const key = `${b.repo.toLowerCase()}@${b.branch}`, have = bases.get(key);
    if (!have || (num(b.at) ?? 0) > (num(have.at) ?? 0)) bases.set(key, b);
  }
  return bases;
}
function mainBroken(people, tickets, bases) {
  const out = [];
  for (const [key, b] of bases) {
    if (b.requiredResult !== 'failing') continue; // null is not checked, never a guess
    const red = b.redSince;
    const repo = b.repo.toLowerCase(); // a branch name may hold an @, so never split the key
    // A PR counts against this base only when it targets this branch (proposed `pr.base`); a PR with no base is left out.
    const inRepo = tickets.flatMap(({ k, p, live }) => arr(k.prs).map((pr) => ({ pr, k, p, live })))
      .filter(({ pr }) => pr.repo.toLowerCase() === repo && pr.base === b.branch);
    const merged = inRepo.filter(({ pr }) => pr.state === 'merged' && ms(pr.mergedAt) !== null).sort((a, z) => ms(a.pr.mergedAt) - ms(z.pr.mergedAt));
    const redSha = b.redSha || null;
    const cause = redSha ? merged.find(({ pr }) => pr.mergeSha === redSha) || null : null;
    const open = new Map();
    for (const x of inRepo) if (x.live && x.pr.state === 'open' && !open.has(prKey(x.pr.repo, x.pr.n))) open.set(prKey(x.pr.repo, x.pr.n), x);
    const waiting = [...open.values()];
    out.push({
      id: callId('main', key, red), kind: 'main', subject: key, since: red,
      // With no cause, the project is the one the team's work on this base belongs to, so a picked project still finds it.
      who: cause ? [cause.p.id] : [], thread: cause?.k.thread || null, project: cause?.k.project || inRepo.find((x) => x.k.project)?.k.project || null,
      prs: cause ? [cause.pr] : [], holds: waiting.length,
      facts: { repo: b.repo, branch: b.branch, sha: b.sha, title: b.title, failing: b.failing,
        cause: cause ? { pr: cause.pr, ticket: cause.k, person: cause.p.id } : null, clean: !!cause && b.sha === redSha,
        mergedToday: merged.map(({ pr, p }) => ({ n: pr.n, at: ms(pr.mergedAt), person: p.id })),
        waiting: waiting.map(({ pr, p }) => ({ n: pr.n, person: p.id })) },
    });
  }
  return out;
}

// A thread whose changed files are compared: live, read, and still before its merge (Merged, Verified and the held
// places, Stopped, Failed and Snoozed, are not).
const comparable = (k, on) => on && k.changes?.state === 'checked' && Object.hasOwn(STAGE_RANK, k.place ?? '') && k.place !== 'Merged';
const overlaps = (a, b) => a[0] <= b[1] && b[0] <= a[1];
// A range from 3a: [start, end] on the base side; a pure insertion is [n + 1, n], read as the point n + 1.
const span = (r) => [r[0], Math.max(r[0], r[1])];
const rng = (r) => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]);

/** Overlap: two live threads change the same lines of one file in one repo and base. Different lines are not a
 *  call (they show in the shared files list). A file with no ranges read (`r: null`) is not checked, never "different".
 *  Lockfiles and generated files (`x`) are left out of calls. */
function overlap(tickets) {
  // Only work still before its merge: Merged, Verified and the held places (Stopped, Failed, Snoozed) are not compared.
  const live = tickets.filter(({ k, live: on }) => comparable(k, on));
  const out = [];
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const A = live[i], B = live[j], ca = A.k.changes, cb = B.k.changes;
    if (!ca.repo || !cb.repo || ca.repo.toLowerCase() !== cb.repo.toLowerCase() || ca.base !== cb.base) continue;
    const files = [];
    for (const fa of arr(ca.files)) {
      if (fa.x || !Array.isArray(fa.r) || typeof fa.p !== 'string' || !fa.p) continue;
      const fb = arr(cb.files).find((f) => f.p === fa.p);
      if (!fb || fb.x || !Array.isArray(fb.r)) continue;
      const shared = [];
      for (const ra of fa.r.filter(rng)) for (const rb of fb.r.filter(rng)) {
        const x = span(ra), y = span(rb);
        if (overlaps(x, y)) shared.push([Math.max(x[0], y[0]), Math.min(x[1], y[1])]);
      }
      if (shared.length) files.push({ path: fa.p, a: fa.r.filter(rng), b: fb.r.filter(rng), shared, lines: shared.reduce((n, s) => n + s[1] - s[0] + 1, 0) });
    }
    if (!files.length) continue;
    files.sort((x, y) => y.lines - x.lines || x.path.localeCompare(y.path));
    // The thread further from merging rebases on the other: the earlier stage, then the later start.
    const rank = (t) => [STAGE_RANK[t.k.place] ?? 0, -(ms(t.k.startedAt) ?? 0)];
    const [ra, rb] = [rank(A), rank(B)];
    const rebaser = ra[0] !== rb[0] ? (ra[0] < rb[0] ? A : B) : (ra[1] < rb[1] ? A : B);
    const keeper = rebaser === A ? B : A;
    const since = Math.max(ms(A.k.startedAt) ?? 0, ms(B.k.startedAt) ?? 0) || null;
    // Each side's PR is its open one in the diff's repo and base, never a PR of the same thread in another repo.
    const prOf = (t) => t.k.prs.find((pr) => pr.state === 'open' && pr.repo.toLowerCase() === ca.repo.toLowerCase() && pr.base === ca.base) || null;
    const [first, second] = [A, B].sort((x, y) => String(x.k.thread).localeCompare(String(y.k.thread)));
    out.push({
      id: callId('overlap', `${first.k.thread}+${second.k.thread}`, since), kind: 'overlap', subject: `${first.k.thread}+${second.k.thread}`, since,
      who: [...new Set([A.p.id, B.p.id])], thread: rebaser.k.thread, project: A.k.project,
      prs: [prOf(keeper), prOf(rebaser)].filter(Boolean), holds: 2,
      // Ranges are base-side lines; from two different merge bases they are near, not exact (lines merged between move them).
      facts: { near: !ca.mergeBase || ca.mergeBase !== cb.mergeBase, files, sides: [A, B].map((t) => ({ person: t.p.id, ticket: t.k, pr: prOf(t) })), rebaser: { person: rebaser.p.id, ticket: rebaser.k, pr: prOf(rebaser) }, keeper: { person: keeper.p.id, ticket: keeper.k, pr: prOf(keeper) } },
    });
  }
  return out;
}

/** Failing: an open PR's checks failed 3 runs in a row. since: the first red run of the streak. Only from a Mac online
 *  now: checks can be run again on GitHub while the dev's Mac is away. */
function failing(tickets, rules) {
  const out = [];
  for (const { k, p, live } of tickets) for (const pr of live && p.online === true ? arr(k.prs) : []) {
    const c = pr.checks, n = num(c?.redRuns);
    if (pr.state !== 'open' || n === null || n < rules.failRuns) continue;
    const runs = arr(c.runs);
    const streak = runs.slice(-n);
    const since = streak.length === n ? ms(streak[0].at) : null;
    // The call rose at the run that made the count: its wait for Seen starts there.
    const rose = streak.length === n ? ms(streak[rules.failRuns - 1].at) : null;
    out.push({ id: callId('failing', `${k.thread}:${prKey(pr.repo, pr.n)}`, since), kind: 'failing', subject: k.thread, since, rose, who: [p.id], thread: k.thread, project: k.project,
      prs: [pr], holds: 1, facts: { redRuns: n, runs, pr, ticket: k } });
  }
  return out;
}

/** Stuck: a running thread with no new message, commit or check for 20 minutes. Only from a dev who is reporting:
 *  a quiet Mac makes every thread look quiet. */
function stuck(tickets, now, rules) {
  const out = [];
  for (const { k, p, live } of tickets) {
    if (!live || !(k.working > 0)) continue;
    const marks = [ms(k.updatedAt), ms(k.changes?.headAt), ...arr(k.prs).flatMap((pr) => arr(pr.checks?.runs).map((r) => ms(r.at)))].filter((t) => t !== null);
    if (!marks.length) continue;
    const last = Math.max(...marks);
    if (now - last < rules.stuckMin * MIN) continue;
    out.push({ id: callId('stuck', k.thread, last), kind: 'stuck', subject: k.thread, since: last, rose: last + rules.stuckMin * MIN, who: [p.id], thread: k.thread, project: k.project,
      prs: arr(k.prs).filter((pr) => pr.state === 'open').slice(0, 1), holds: 1, facts: { last: k.last || null, quietSince: last, ticket: k } });
  }
  return out;
}

/** Waiting: an agent asked its dev a question 15 minutes ago or more. */
function waiting(tickets, now, rules) {
  const out = [];
  for (const { k, p } of tickets) {
    const at = k.ask ? k.ask.at : null;
    if (at === null || now - at < rules.waitMin * MIN) continue;
    out.push({ id: callId('waiting', k.thread, at), kind: 'waiting', subject: k.thread, since: at, who: [p.id], thread: k.thread, project: k.project,
      prs: arr(k.prs).filter((pr) => pr.state === 'open').slice(0, 1), holds: 1, facts: { ask: k.ask, ticket: k } });
  }
  return out;
}

/** Too big: an open PR over 800 changed lines or 30 files, lockfiles and generated files left out. A size GitHub only
 *  gave in part (`size: null`) is not checked. since: when the dev's Mac first saw the PR over the limit (proposed
 *  `size.overAt`); with none, the call's age is not checked and it never reaches the lead by time. */
function tooBig(tickets, rules) {
  const out = [];
  for (const { k, p, live } of tickets) for (const pr of live ? arr(k.prs) : []) {
    const s = pr.size;
    if (pr.state !== 'open' || !s || num(s.added) === null || num(s.removed) === null || num(s.files) === null) continue;
    const lines = s.added + s.removed;
    if (lines <= rules.bigLines && s.files <= rules.bigFiles) continue;
    const since = ms(s.overAt);
    out.push({ id: callId('big', `${k.thread}:${prKey(pr.repo, pr.n)}`, since), kind: 'big', subject: k.thread, since, who: [p.id], thread: k.thread, project: k.project,
      prs: [pr], holds: 1, facts: { lines, size: s, pr, ticket: k, changes: k.changes?.state === 'checked' ? k.changes : null } });
  }
  return out;
}

/** Does this call reach the lead's Pass, and why. Open kitchen: a call goes first to its dev, and reaches the lead
 *  when it is red; when nobody marks it Seen within its time; or when its own rule says so. seen: { person id: at }. */
export function reach(call, { seen = {}, quiet = new Set(), now, rules = RULES }) {
  // The wait for Seen starts when the call rose (`rose`: Stuck 20 minutes after its last activity, Failing at the run
  // that made the count), else at `since`. With neither, the age is not checked, and time never raises it.
  const from = call.rose !== undefined ? call.rose : call.since;
  const age = from === null ? null : Math.max(0, (now - from) / MIN);
  const anySeen = call.who.some((id) => seen[id]);
  if (KINDS[call.kind].tone === 'red') return { lead: true, why: 'red' };
  if (call.kind === 'waiting') {
    if (call.who.some((id) => quiet.has(id))) return { lead: true, why: 'quiet' };
    return age !== null && age >= rules.waitLeadMin ? { lead: true, why: 'time', min: rules.waitLeadMin } : { lead: false };
  }
  if (call.kind === 'failing' && call.facts.redRuns >= rules.failLeadRuns) return { lead: true, why: 'runs', runs: call.facts.redRuns };
  const limit = call.kind === 'stuck' ? rules.escalateMin : call.kind === 'big' ? rules.bigLeadMin : rules.escalateMin;
  if (!anySeen && age !== null && age >= limit) return { lead: true, why: 'unseen', min: limit };
  return { lead: false };
}

/** The Pass's order: red, then blue, then amber; within a colour the call that holds up the most work, then the
 *  oldest. A call with no known start sorts after the ones with one. */
export function sortCalls(calls) {
  return [...calls].sort((a, b) => (TONE_RANK[KINDS[a.kind].tone] - TONE_RANK[KINDS[b.kind].tone])
    || (b.holds - a.holds) || ((a.since ?? Infinity) - (b.since ?? Infinity)) || a.id.localeCompare(b.id));
}

// What a role may do from Your team, by its boxes (3b's client/roles.mjs NEEDS, which step 4 reads once that lands):
// Reply needs "reply"; Request changes, Hold, an answer and a roll back need "merge". Settle clears the call from your
// own Pass only, so every role that sees it may. An Engineer starts at See only (Dan, 2026-11-10).
const NEED = { reply: 'reply', rebase: 'reply', refire: 'merge', hold: 'merge', answer: 'merge', rollback: 'merge', settle: 'see' };
export function may(me, action) {
  const need = NEED[action];
  if (!need || !me) return false;
  if (me.role === 'lead') return true;
  return Array.isArray(me.perms) && (need === 'see' || me.perms.includes(need));
}

/** Everything Your team draws, for me (view.me) at `now`.
 *  status: 'live', or 'not-checked' with `why` when this Mac's team connection is down or no teammate has reported.
 *  people: below me, each with `state` (pass, alarm, quiet, track or unknown) and `reporting`.
 *  pass: the calls that reach me, in the Pass's order, each with `reach` and `seen` ({ person id: at }).
 *  held: the calls their devs hold (not yet mine). */
export function openKitchen(view, { now = Date.now(), rules = RULES } = {}) {
  const team = below(view);
  if (view?.link !== 'online') return { status: 'not-checked', why: 'offline', linkAt: num(view?.linkAt), people: team.map((p) => ({ ...p, state: 'unknown', reporting: null })), pass: [], held: [], tickets: [], bases: [] };
  const people = team.filter((p) => typeof p.id === 'string').map((p) => ({ ...p, name: str(p.name), reporting: reporting(p, { now, link: view.link, rules }) }));
  if (!people.some((p) => okSummary(p.summary))) return { status: 'not-checked', why: 'no-summaries', people: people.map((p) => ({ ...p, state: 'unknown' })), pass: [], held: [], tickets: [], bases: [] };
  const quiet = new Set(people.filter((p) => p.reporting === false).map((p) => p.id));
  const tickets = people.flatMap((p) => arr(p.summary?.tickets).map((k) => ({ k: cleanTicket(k), p, live: p.reporting === true }))).filter(({ k }) => k.thread);
  // Only a reporting dev's data raises a call: a quiet Mac's is old. Two exceptions: a question still waits while its
  // dev is away, and that is when it reaches the lead; and a merge that is done stays done, so Main broken reads every
  // dev's merges for its history (its open PRs and its base reads still need a live Mac).
  const bases = liveBases(people);
  const calls = [...mainBroken(people, tickets, bases), ...overlap(tickets), ...failing(tickets, rules), ...stuck(tickets, now, rules), ...waiting(tickets, now, rules), ...tooBig(tickets, rules)];
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const c of calls) {
    c.seen = Object.fromEntries(c.who.map((id) => [id, num(byId.get(id)?.summary?.seen?.[c.id])]).filter(([, at]) => at !== null));
    c.reach = reach(c, { seen: c.seen, quiet, now, rules });
    c.quiet = c.who.filter((id) => quiet.has(id)).map((id) => ({ person: id, since: num(byId.get(id).lastSeen) ?? num(byId.get(id).at) }));
  }
  const pass = sortCalls(calls.filter((c) => c.reach.lead));
  const held = sortCalls(calls.filter((c) => !c.reach.lead));
  const inPass = new Set(pass.flatMap((c) => c.who)), holding = new Set(held.flatMap((c) => c.who));
  // A dev counts once: Not reporting first (their data is old), then In The Pass, Fixing an alarm, On track.
  for (const p of people) {
    p.state = p.reporting === null ? 'unknown' : quiet.has(p.id) ? 'quiet' : inPass.has(p.id) ? 'pass' : holding.has(p.id) ? 'alarm' : 'track';
  }
  return { status: 'live', people, pass, held, tickets: tickets.map(({ k, p, live }) => ({ k, person: p.id, live })), bases: [...bases.values()] };
}

// ---- Your team, expanded (step 4 PR B): the board beside The Pass. ----

/** Local midnight on `now`'s day: "today" is the lead's own day. */
const dayStart = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const HOUR = 60 * MIN;
const ORDER = { pass: 0, alarm: 1, quiet: 2, track: 3, unknown: 4 };

/** The board for Your team, expanded (mock v2, approved 2026-11-10; the brief's Expanded parts): four instruments,
 *  Who's on what, and the files two live threads change. ok: what openKitchen returned. want: the picked projects as a
 *  Set, or null for All projects. What no summary says stays null ("Not checked"), never a guess: the mock's "usual by
 *  now" needs merge history and its ETAs need the agent's own estimate, and neither is sent yet. */
export function kitchenBoard(ok, { now, want = null }) {
  if (ok?.status !== 'live') return null;
  const d0 = dayStart(now);
  const inProj = (p) => !want || (p !== null && want.has(p));
  const all = ok.tickets.filter(({ k }) => inProj(k.project));
  const byPerson = new Map(ok.people.map((p) => [p.id, p]));
  const calls = [...ok.pass.map((c) => ({ c, mine: true })), ...ok.held.map((c) => ({ c, mine: false }))].filter(({ c }) => inProj(c.project));

  // Merges today, each PR once: a merge stays done, so a quiet dev's merges count too.
  // A merged PR with no time may or may not be today's: it is counted apart, never as today's or as not.
  const merges = [], seenPr = new Set(), untimed = new Set();
  for (const { k, person } of all) for (const pr of k.prs) {
    if (pr.state !== 'merged') continue;
    const key = prKey(pr.repo, pr.n);
    if (pr.mergedAt === null) { untimed.add(key); continue; }
    if (pr.mergedAt < d0 || pr.mergedAt > now || seenPr.has(key)) continue;
    seenPr.add(key);
    merges.push({ n: pr.n, repo: pr.repo, branch: pr.base, at: pr.mergedAt, sha: pr.mergeSha, person, thread: k.thread });
  }
  merges.sort((a, z) => a.at - z.at || a.n - z.n);
  // A PR is untimed only when no copy of it, in any summary, says when it merged (that copy may be from another day).
  for (const { k } of ok.tickets) for (const pr of k.prs) if (pr.state === 'merged' && pr.mergedAt !== null) untimed.delete(prKey(pr.repo, pr.n));

  // The base instrument: the bases Macs online now read, narrowed to the picked projects' repos.
  const repos = new Set(all.flatMap(({ k }) => [...k.prs.map((pr) => pr.repo), k.changes?.repo].filter(Boolean).map((r) => r.toLowerCase())));
  const bases = ok.bases.filter((b) => !want || repos.has(b.repo.toLowerCase()));
  const red = bases.filter((b) => b.requiredResult === 'failing');
  const baseOf = (m) => (m.branch ? bases.find((b) => b.repo.toLowerCase() === m.repo.toLowerCase() && b.branch === m.branch) || null : null);
  // Each merge's mark: red when it is in the base's current run of red (the first red commit, or a merge after it
  // while the base is still red). Anything else is a plain merge: the base's result now says nothing about how it
  // stood at an earlier merge, so no merge is ever called green.
  const tone = (m) => {
    const b = baseOf(m);
    if (!b || b.requiredResult !== 'failing') return 'merged';
    if (m.sha && m.sha === b.redSha) return 'red';
    return b.redSince !== null && m.at >= b.redSince ? 'red' : 'merged';
  };
  const base = {
    branches: [...new Set(bases.map((b) => b.branch))], count: bases.length, repos: bases.map((b) => b.repo),
    state: !bases.length ? null : red.length ? 'red' : bases.every((b) => b.requiredResult === 'passing') ? 'green' : null,
    red: red.map((b) => ({ repo: b.repo, branch: b.branch, since: b.redSince })),
    since: red.length && red.every((b) => b.redSince !== null) ? Math.min(...red.map((b) => b.redSince)) : null,
    merges: merges.map((m) => ({ n: m.n, repo: m.repo, at: m.at, person: m.person, tone: tone(m) })),
  };

  // What the team counts cannot see: Macs not reporting, and reporting Macs whose summary left threads out. In a picked
  // project, a Mac out counts when its old summary has work there, sent none, or left threads out (they may be there).
  const away = ok.people.filter((p) => p.reporting !== true && (!want || !okSummary(p.summary) || (num(p.summary?.more) ?? 0) > 0 || all.some((t) => t.person === p.id))).length;
  const capped = ok.people.filter((p) => p.reporting === true && (num(p.summary?.more) ?? 0) > 0).length;
  const gap = { away, capped };

  // Merged today, by hour: from the first merge's hour (or six hours back) to now.
  const hNow = new Date(now).getHours();
  const h0 = Math.max(0, Math.min(hNow - 5, ...merges.map((m) => new Date(m.at).getHours())));
  const hours = Array.from({ length: hNow - h0 + 1 }, (_, i) => h0 + i);
  const merged = { count: merges.length, untimed: untimed.size, gap, from: h0, byHour: hours.map((h) => merges.filter((m) => new Date(m.at).getHours() === h).length), usual: null };

  // Waiting for review: open PRs, not drafts, on live threads In review. Their age needs the time each was marked ready
  // (proposed `pr.readyAt`); with any one missing, the ages say not checked rather than a part of them.
  // A merge is final: a PR that any summary, live or old, reports merged never waits, whatever another copy says.
  const done = new Set(ok.tickets.flatMap(({ k }) => k.prs.filter((pr) => pr.state === 'merged').map((pr) => prKey(pr.repo, pr.n))));
  const rv = new Map();
  for (const { k, person, live } of all) if (live && k.place === 'In review') for (const pr of k.prs) {
    const key = prKey(pr.repo, pr.n);
    if (pr.state === 'open' && !pr.draft && !done.has(key) && !rv.has(key)) rv.set(key, { n: pr.n, repo: pr.repo, person, at: pr.readyAt });
  }
  const ready = [...rv.values()];
  const review = { count: ready.length, gap, ages: ready.length && ready.every((r) => r.at !== null) ? ready.map((r) => Math.max(0, now - r.at)).sort((a, z) => z - a) : null };

  // Agents running: from reporting Macs only, since a quiet Mac's count is old.
  const liveTickets = all.filter(({ k, live }) => live && Object.hasOwn(STAGE_RANK, k.place ?? '') && k.place !== 'Merged');
  const agents = { count: liveTickets.reduce((n, { k }) => n + k.working, 0), threads: liveTickets.filter(({ k }) => k.working > 0).length, gap };

  // Who's on what: one row per person, In The Pass first. Each thread is a bar from its start to its merge, or to now
  // (to the last report for a dev who is not reporting). A thread with no start time is counted, not drawn.
  const callOf = new Map();
  for (const { c, mine } of calls) {
    const threads = c.kind === 'overlap' ? c.facts.sides.map((s) => s.ticket.thread) : [c.thread];
    for (const t of threads) if (t && !callOf.has(t)) callOf.set(t, { id: c.id, kind: c.kind, mine });
  }
  // A thread is done at its last PR's merge: with any merged PR's time missing, when it was done is not known.
  const mergedAt = (k) => { const ts = k.prs.filter((pr) => pr.state === 'merged').map((pr) => pr.mergedAt); return ts.length && ts.every((t) => t !== null) ? Math.max(...ts) : null; };
  const rowsAll = [];
  for (const p of ok.people) {
    const quietAt = p.state === 'quiet' ? num(p.lastSeen) ?? num(p.at) : null;
    const mine = all.filter(({ person }) => person === p.id);
    let untimed = 0;
    const bars = [];
    for (const { k } of mine) {
      if (!Object.hasOwn(STAGE_RANK, k.place ?? '')) continue;
      const m = k.place === 'Merged' ? mergedAt(k) : null;
      if (k.place === 'Merged' && (m === null || m < d0)) continue; // merged before today, or with no time
      if (k.startedAt === null) { untimed++; continue; }
      const end = m ?? (quietAt !== null ? Math.min(now, Math.max(k.startedAt, quietAt)) : now);
      bars.push({ thread: k.thread, title: k.title, place: k.place, pr: k.prs.find((pr) => pr.state === 'open') || k.prs[0] || null,
        start: Math.min(k.startedAt, end), end, merged: m, call: callOf.get(k.thread) || null });
    }
    if (want && !bars.length && !untimed) continue; // a picked project's board shows only who works in it
    bars.sort((a, z) => a.start - z.start || String(a.thread).localeCompare(String(z.thread)));
    // Up to two lanes: each bar takes the first lane free at its start; the rest are counted.
    const lanes = [-Infinity, -Infinity];
    let more = 0;
    for (const b of bars) {
      const i = lanes.findIndex((end) => end <= b.start);
      if (i < 0) { b.lane = null; more++; continue; }
      b.lane = i; lanes[i] = b.end;
    }
    rowsAll.push({ person: p.id, state: p.state, bars: bars.filter((b) => b.lane !== null), more, untimed, quiet: quietAt !== null ? { since: quietAt } : null });
  }
  rowsAll.sort((a, z) => ORDER[a.state] - ORDER[z.state] || String(byPerson.get(a.person)?.name || '').localeCompare(String(byPerson.get(z.person)?.name || '')));
  // The window: from the hour of the earliest start today (never before midnight), at least two hours back.
  const starts = rowsAll.flatMap((r) => r.bars.map((b) => b.start));
  const from = Math.min(Math.floor((now - 2 * HOUR - d0) / HOUR) * HOUR + d0, ...starts.map((t) => d0 + Math.floor((Math.max(d0, t) - d0) / HOUR) * HOUR));
  const winFrom = Math.max(d0, from);
  for (const r of rowsAll) for (const b of r.bars) { b.clip = b.start < winFrom; b.start = Math.max(b.start, winFrom); b.end = Math.max(b.start, b.end); }
  // An Overlap joins the two people's rows at the time it rose, labeled with the file.
  const links = calls.filter(({ c }) => c.kind === 'overlap' && c.who.length === 2).map(({ c, mine }) => ({
    id: c.id, mine, a: c.who[0], b: c.who[1], at: Math.min(now, Math.max(winFrom, c.since ?? now)), file: c.facts.files[0].path,
  }));

  // Files two live threads change: one row per file, in one repo and base. Same lines is the Overlap call; different
  // lines are fine; a side with no ranges read is not checked.
  const readable = (k, live) => comparable(k, live) && !!k.changes.repo;
  const byFile = new Map();
  for (const { k, person, live } of all) {
    if (!readable(k, live)) continue;
    for (const f of k.changes.files) {
      if (f.x || typeof f.p !== 'string' || !f.p) continue;
      const key = `${k.changes.repo.toLowerCase()}\n${k.changes.base}\n${f.p}`;
      if (!byFile.has(key)) byFile.set(key, { path: f.p, repo: k.changes.repo, sides: [] });
      byFile.get(key).sides.push({ person, thread: k.thread, r: f.r, at: k.changes.at, mb: k.changes.mergeBase });
    }
  }
  const overlapCalls = calls.filter(({ c }) => c.kind === 'overlap');
  const files = [];
  for (const f of byFile.values()) {
    if (new Set(f.sides.map((s) => s.thread)).size < 2) continue;
    const call = overlapCalls.find(({ c }) => c.facts.files.some((x) => x.path === f.path) && c.facts.sides.every((s) => f.sides.some((x) => x.thread === s.ticket.thread)));
    // Lines compare only from one merge base: from two, "different lines" could be the same code moved.
    const oneBase = f.sides.every((s) => s.mb && s.mb === f.sides[0].mb);
    const read = oneBase && f.sides.every((s) => Array.isArray(s.r));
    let same = false;
    for (let i = 0; i < f.sides.length && read; i++) for (let j = i + 1; j < f.sides.length; j++) {
      if (f.sides[i].r.some((x) => f.sides[j].r.some((y) => overlaps(span(x), span(y))))) same = true;
    }
    const state = call || same ? 'same' : read ? 'different' : 'nc';
    files.push({ path: f.path, repo: f.repo, near: !oneBase, people: [...new Set(f.sides.map((s) => s.person))], state, call: call ? { id: call.c.id, mine: call.mine } : null,
      at: f.sides.every((s) => s.at !== null) ? Math.min(...f.sides.map((s) => s.at)) : null });
  }
  const RANKF = { same: 0, nc: 1, different: 2 };
  files.sort((a, z) => RANKF[a.state] - RANKF[z.state] || a.path.localeCompare(z.path));
  // When the list was read: the oldest read among the threads it compares.
  const reads = all.filter(({ k, live }) => readable(k, live)).map(({ k }) => k.changes.at);
  // Not checked: a live thread at work whose files were not sent, or were sent with no repo to compare them in.
  const unread = all.filter(({ k, live }) => live && Object.hasOwn(STAGE_RANK, k.place ?? '') && k.place !== 'Merged' && !readable(k, live)).length;
  const partial = all.filter(({ k, live }) => readable(k, live) && (k.changes.more ?? 0) > 0).length;
  const filesAt = reads.length && reads.every((t) => t !== null) ? Math.min(...reads) : null;

  return {
    people: rowsAll.length, threads: liveTickets.length,
    base, merged, review, agents,
    timeline: { from: winFrom, to: now, day: d0, rows: rowsAll, links },
    files: { rows: files, at: filesAt, compared: reads.length, unread, partial, capped: gap.capped },
  };
}
