// Open kitchen, the Your team view (step 4): the calls each Mac derives from its teammates' sealed summaries, who they
// reach, and in what order. No I/O: the screens (client/board.mjs) draw what this returns.
//
// Input: the team as client/team.mjs Team.view() gives it (3b). The summary fields this reads beyond 3b's v1
// (bases, seen, and per ticket startedAt, last, ask, changes, prs[].mergedAt/size/checks/draft) are PROPOSED: agreed
// with 3b and landing in its PR 4. Every one is optional. Whatever a summary lacks is "Not checked": no call is raised
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

const ms = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// A teammate's summary is outside data: a list that is not one reads as empty, and an entry that is not an object drops.
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
// A PR from a teammate's summary counts only with a whole number and an owner/name repo: both reach the page's markup.
const okPr = (pr) => Number.isInteger(pr.n) && pr.n > 0 && typeof pr.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(pr.repo);
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
export function reporting(p, { now, link, rules = RULES }) {
  if (link !== 'online' || !p.summary) return null;
  if (p.online) return true;
  const last = num(p.lastSeen) ?? num(p.at);
  if (last === null) return null;
  const live = arr(p.summary.tickets).some((k) => k.working > 0);
  return !(live && now - last >= rules.quietMin * MIN);
}

// ---- The detectors. Each returns calls: { id, kind, tone, subject, since, who: [person ids], thread, project,
// prs, holds, facts }. `facts` is what the reader shows; numbers stay numbers, and the screens format them. ----

/** Main broken: a required check fails on a base branch (3a's requiredResult; null is not checked). The break is
 *  `redSince`, the commit time of the first red commit in the current run of red (proposed: the dev's Mac keeps it
 *  from read to read). The head's own `committedAt` moves with every merge, so it never names a cause. The cause is
 *  the PR merged last before the break; it is a clean roll back when nothing merged after it. With no `redSince`, the
 *  cause is not checked. Bases come only from Macs online now (another dev's merge can turn a base red or green while
 *  a Mac is away), deduplicated by the newest read. */
function mainBroken(people, tickets) {
  const bases = new Map();
  for (const p of people) for (const b of p.reporting && p.online === true ? arr(p.summary?.bases) : []) {
    if (!b?.repo || !b.branch) continue;
    const key = `${String(b.repo).toLowerCase()}@${b.branch}`, have = bases.get(key);
    if (!have || (num(b.at) ?? 0) > (num(have.at) ?? 0)) bases.set(key, b);
  }
  const out = [];
  for (const [key, b] of bases) {
    if (b.requiredResult !== 'failing') continue; // null is not checked, never a guess
    const red = ms(b.redSince);
    const repo = key.slice(0, key.lastIndexOf('@'));
    const inRepo = tickets.flatMap(({ k, p }) => arr(k.prs).map((pr) => ({ pr, k, p }))).filter(({ pr }) => String(pr.repo).toLowerCase() === repo);
    const merged = inRepo.filter(({ pr }) => pr.state === 'merged' && ms(pr.mergedAt) !== null).sort((a, z) => ms(a.pr.mergedAt) - ms(z.pr.mergedAt));
    const cause = red === null ? null : [...merged].reverse().find(({ pr }) => ms(pr.mergedAt) <= red + MIN) || null;
    const after = cause ? merged.filter(({ pr }) => ms(pr.mergedAt) > ms(cause.pr.mergedAt)) : [];
    const open = new Map();
    for (const x of inRepo) if (x.pr.state === 'open' && !open.has(prKey(x.pr.repo, x.pr.n))) open.set(prKey(x.pr.repo, x.pr.n), x);
    const waiting = [...open.values()];
    out.push({
      id: callId('main', key, red), kind: 'main', subject: key, since: red,
      who: cause ? [cause.p.id] : [], thread: cause?.k.thread || null, project: cause?.k.project || null,
      prs: cause ? [cause.pr] : [], holds: waiting.length,
      facts: { repo: b.repo, branch: b.branch, sha: b.sha || null, title: b.title || null, failing: (Array.isArray(b.failing) ? b.failing : []).filter((x) => typeof x === 'string').slice(0, 5),
        cause: cause ? { pr: cause.pr, ticket: cause.k, person: cause.p.id } : null, clean: !!cause && !after.length,
        mergedToday: merged.map(({ pr, p }) => ({ n: pr.n, at: ms(pr.mergedAt), person: p.id })),
        waiting: waiting.map(({ pr, p }) => ({ n: pr.n, person: p.id })) },
    });
  }
  return out;
}

const overlaps = (a, b) => a[0] <= b[1] && b[0] <= a[1];
// A range from 3a: [start, end] on the base side; a pure insertion is [n + 1, n], read as the point n + 1.
const span = (r) => [r[0], Math.max(r[0], r[1])];
const rng = (r) => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]);

/** Overlap: two live threads change the same lines of one file in one repo and base. Different lines are not a
 *  call (they show in the shared files list). A file with no ranges read (`r: null`) is not checked, never "different".
 *  Lockfiles and generated files (`x`) are left out of calls. */
function overlap(tickets) {
  const live = tickets.filter(({ k, live: on }) => on && k.changes?.state === 'checked' && k.place !== 'Merged' && Array.isArray(k.changes.files));
  const out = [];
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const A = live[i], B = live[j], ca = A.k.changes, cb = B.k.changes;
    if (!ca.repo || String(ca.repo).toLowerCase() !== String(cb.repo).toLowerCase() || ca.base !== cb.base) continue;
    const files = [];
    for (const fa of arr(ca.files)) {
      if (fa.x || !Array.isArray(fa.r)) continue;
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
    const [first, second] = [A, B].sort((x, y) => String(x.k.thread).localeCompare(String(y.k.thread)));
    out.push({
      id: callId('overlap', `${first.k.thread}+${second.k.thread}`, since), kind: 'overlap', subject: `${first.k.thread}+${second.k.thread}`, since,
      who: [...new Set([A.p.id, B.p.id])], thread: rebaser.k.thread, project: A.k.project,
      prs: [...arr(keeper.k.prs), ...arr(rebaser.k.prs)].filter((pr) => pr.state === 'open').slice(0, 2), holds: 2,
      // Ranges are base-side lines; from two different merge bases they are near, not exact (lines merged between move them).
      facts: { near: !ca.mergeBase || ca.mergeBase !== cb.mergeBase, files, sides: [A, B].map(({ k, p }) => ({ person: p.id, ticket: k })), rebaser: { person: rebaser.p.id, ticket: rebaser.k }, keeper: { person: keeper.p.id, ticket: keeper.k } },
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
    out.push({ id: callId('failing', `${k.thread}#${pr.n}`, since), kind: 'failing', subject: k.thread, since, who: [p.id], thread: k.thread, project: k.project,
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
    out.push({ id: callId('stuck', k.thread, last), kind: 'stuck', subject: k.thread, since: last, who: [p.id], thread: k.thread, project: k.project,
      prs: arr(k.prs).filter((pr) => pr.state === 'open').slice(0, 1), holds: 1, facts: { last: k.last || null, quietSince: last, ticket: k } });
  }
  return out;
}

/** Waiting: an agent asked its dev a question 15 minutes ago or more. */
function waiting(tickets, now, rules) {
  const out = [];
  for (const { k, p } of tickets) {
    const at = k.ask && typeof k.ask === 'object' ? ms(k.ask.at) : null;
    if (at === null || now - at < rules.waitMin * MIN) continue;
    out.push({ id: callId('waiting', k.thread, at), kind: 'waiting', subject: k.thread, since: at, who: [p.id], thread: k.thread, project: k.project,
      prs: arr(k.prs).filter((pr) => pr.state === 'open').slice(0, 1), holds: 1, facts: { ask: k.ask, ticket: k } });
  }
  return out;
}

/** Too big: an open PR over 800 changed lines or 30 files, lockfiles and generated files left out. A size GitHub only
 *  gave in part (`size: null`) is not checked. since: the thread's start, until a summary says when the call rose. */
function tooBig(tickets, rules) {
  const out = [];
  for (const { k, p, live } of tickets) for (const pr of live ? arr(k.prs) : []) {
    const s = pr.size;
    if (pr.state !== 'open' || !s || num(s.added) === null || num(s.removed) === null || num(s.files) === null) continue;
    const lines = s.added + s.removed;
    if (lines <= rules.bigLines && s.files <= rules.bigFiles) continue;
    const since = ms(k.startedAt);
    out.push({ id: callId('big', `${k.thread}#${pr.n}`, since), kind: 'big', subject: k.thread, since, who: [p.id], thread: k.thread, project: k.project,
      prs: [pr], holds: 1, facts: { lines, size: s, pr, ticket: k, changes: k.changes?.state === 'checked' ? k.changes : null } });
  }
  return out;
}

/** Does this call reach the lead's Pass, and why. Open kitchen: a call goes first to its dev, and reaches the lead
 *  when it is red; when nobody marks it Seen within its time; or when its own rule says so. seen: { person id: at }. */
export function reach(call, { seen = {}, quiet = new Set(), now, rules = RULES }) {
  // A Stuck call rises 20 minutes after its last activity, so its wait for Seen starts then, not at the activity.
  const from = call.since === null ? null : call.kind === 'stuck' ? call.since + rules.stuckMin * MIN : call.since;
  const age = from === null ? 0 : Math.max(0, (now - from) / MIN);
  const anySeen = call.who.some((id) => seen[id]);
  if (KINDS[call.kind].tone === 'red') return { lead: true, why: 'red' };
  if (call.kind === 'waiting') {
    if (call.who.some((id) => quiet.has(id))) return { lead: true, why: 'quiet' };
    return age >= rules.waitLeadMin ? { lead: true, why: 'time', min: rules.waitLeadMin } : { lead: false };
  }
  if (call.kind === 'failing' && call.facts.redRuns >= rules.failLeadRuns) return { lead: true, why: 'runs', runs: call.facts.redRuns };
  const limit = call.kind === 'stuck' ? rules.escalateMin : call.kind === 'big' ? rules.bigLeadMin : rules.escalateMin;
  if (!anySeen && age >= limit) return { lead: true, why: 'unseen', min: limit };
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
  if (view?.link !== 'online') return { status: 'not-checked', why: 'offline', linkAt: num(view?.linkAt), people: team.map((p) => ({ ...p, state: 'unknown', reporting: null })), pass: [], held: [] };
  const people = team.map((p) => ({ ...p, reporting: reporting(p, { now, link: view.link, rules }) }));
  if (!people.some((p) => p.summary)) return { status: 'not-checked', why: 'no-summaries', people: people.map((p) => ({ ...p, state: 'unknown' })), pass: [], held: [] };
  const quiet = new Set(people.filter((p) => p.reporting === false).map((p) => p.id));
  const tickets = people.flatMap((p) => arr(p.summary?.tickets).map((k) => ({ k: { ...k, prs: arr(k.prs).filter(okPr) }, p, live: p.reporting === true })));
  // Only a reporting dev's data raises a call: a quiet Mac's is old. Waiting is the exception: a question still waits
  // while its dev is away, and that is when it reaches the lead.
  const calls = [...mainBroken(people, tickets.filter((t) => t.live)), ...overlap(tickets), ...failing(tickets, rules), ...stuck(tickets, now, rules), ...waiting(tickets, now, rules), ...tooBig(tickets, rules)];
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
    p.state = !p.summary || p.reporting === null ? 'unknown' : quiet.has(p.id) ? 'quiet' : inPass.has(p.id) ? 'pass' : holding.has(p.id) ? 'alarm' : 'track';
  }
  return { status: 'live', people, pass, held };
}
