// GitHub, read only: the checks on a base branch and the size of a pull request. Yes Chef holds no GitHub key. It
// asks through the GitHub CLI (`gh`) when this Mac already has it signed in, and every call is a GET. Without gh, or
// with gh signed out, everything here is "not checked", with the reason.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createFollower } from './follow.mjs';
import { LOCKFILE } from './changes.mjs';

export const GH_PATHS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
// Only paths under repos/ with plain characters reach gh, so nothing from T3 Code's data becomes a flag or a method.
const SAFE_PATH = /^repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._%-]+)*(\?[A-Za-z0-9._=&%-]+)?$/;
const HOST = /^[a-z0-9.-]+$/;

// No segment may climb out of the repo: "." or "..", plain or percent-encoded.
const noDots = (path) => path.split('?')[0].split('/').every((seg) => {
  try { const d = decodeURIComponent(seg); return d !== '.' && d !== '..'; } catch { return false; }
});
/** One GET through gh, as JSON. The app's PATH may lack Homebrew, so gh is looked for where Homebrew puts it. */
export function ghGet(path, { host = 'github.com', gh = process.env.YESCHEF_GH || GH_PATHS.find((p) => existsSync(p)) || 'gh', timeout = 20000 } = {}) {
  if (!SAFE_PATH.test(path) || !noDots(path)) return Promise.reject(new Error(`not a GitHub read: ${path.slice(0, 80)}`));
  if (!HOST.test(host)) return Promise.reject(new Error('not a GitHub host'));
  const args = ['api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '--hostname', host, path];
  // The host is always named, so GH_HOST cannot point the read elsewhere, and gh's debug output stays off.
  // gh sends an Enterprise token from the environment to any host that is not github.com, and the host here comes
  // from T3 Code's PR links or a repo's remote, which anyone can name. Only gh's own sign-in for that host is used
  // (PR-Agent r1 on #4).
  const { GH_HOST, GH_DEBUG, DEBUG, GH_ENTERPRISE_TOKEN, GITHUB_ENTERPRISE_TOKEN, ...rest } = process.env;
  const env = { ...rest, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1', GH_PAGER: 'cat' };
  return new Promise((done, fail) => {
    execFile(gh, args, { env, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) { err.stderr = String(errOut || '').trim(); return fail(err); }
      try { done(JSON.parse(out)); } catch { fail(new Error('GitHub sent something that is not JSON')); }
    });
  });
}

/** Why a GitHub read failed, in a few words. */
export function ghWhy(ex) {
  const text = String(ex?.stderr || ex?.message || '');
  if (ex?.code === 'ENOENT') return 'the GitHub CLI (gh) is not on this Mac';
  if (ex?.killed) return 'GitHub took longer than 20 s';
  if (/gh auth login|not logged in|authentication required/i.test(text)) return 'the GitHub CLI is not signed in';
  if (/rate limit/i.test(text)) return 'GitHub\'s rate limit for this account is spent';
  if (/HTTP 404/.test(text)) return 'GitHub has no such repo, branch or PR that this account can see';
  if (/HTTP 403/.test(text)) return 'GitHub refused the read (403)';
  return (text.split('\n').find(Boolean) || 'the GitHub read failed').replace(/^gh: /, '').slice(0, 160);
}

// One check's state in four words. A check that is not complete is pending; cancelled, timed out and the like fail,
// as GitHub counts them for a required check.
export function runState(run) {
  if (run.status !== 'completed') return 'pending';
  if (run.conclusion === 'success') return 'passing';
  if (['neutral', 'skipped'].includes(run.conclusion)) return 'neutral';
  return 'failing';
}
const statusState = (s) => (s.state === 'success' ? 'passing' : s.state === 'pending' ? 'pending' : 'failing');
/** Many checks as one: failing beats pending beats passing; none at all is 'none'. */
export function overall(states) {
  if (!states.length) return 'none';
  if (states.includes('failing')) return 'failing';
  if (states.includes('pending')) return 'pending';
  return 'passing';
}

// A branch name as one path segment. encodeURIComponent leaves ! ' ( ) * as they are; a branch may hold them
// (PR-Agent r1 on #81).
export const segment = (name) => encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// What a read can reuse, so an unchanged branch or PR costs one call: GitHub's rate limit is the account's, shared
// with every other gh use on this Mac. Kept small: the oldest entries go first.
const baseMemo = new Map(), sizeMemo = new Map();

// Every page of a list GitHub splits by 100 (a commit's check runs or statuses), up to `pages` pages. The first call
// is the path as given; `truncated` says the list is not known whole (PR-Agent r1 on #4). Pages are offsets, so a
// check added or moved while they are read shifts them: one entry shows twice and another not at all. So every page
// must give the same total, an entry seen twice (by `idOf`) counts once, and either one leaves the list not whole
// (PR-Agent r3 on #4).
async function allPages(get, host, path, key, idOf, pages = 10) {
  const first = await get(path, { host });
  const total = first?.total_count || 0, seen = new Set(), items = [];
  let moved = false;
  const add = (rows) => { for (const r of rows) { const id = idOf(r); if (seen.has(id)) moved = true; else { seen.add(id); items.push(r); } } };
  add(first?.[key] || []);
  for (let page = 2; page <= pages && items.length < total && !moved; page++) {
    const got = await get(`${path}&page=${page}`, { host });
    if ((got?.total_count || 0) !== total) moved = true;
    const rows = got?.[key] || [];
    if (!rows.length) break;
    add(rows);
  }
  return { ...first, total_count: total, [key]: items, truncated: moved || items.length !== total };
}
// Every page of a branch's rules, 100 a page (GitHub sends 30 unless asked), up to `pages` pages. The list carries no
// total: a short page is the last. More than the pages read is null, as unknown as a failed read (PR-Agent r2 on #4).
async function allRules(get, host, path, pages = 10) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const rows = await get(`${path}?per_page=100${page > 1 ? `&page=${page}` : ''}`, { host });
    if (!Array.isArray(rows)) return null;
    out.push(...rows);
    if (rows.length < 100) return out;
  }
  return null;
}
// Under the base follower's 6-minute limit: a reused read keeps the time its checks were read, so it is never shown
// as newer than it is (PR-Agent r2 on #81).
const REUSE_MS = 4 * 60 * 1000;
function remember(memo, key, value, max = 200) {
  memo.delete(key); memo.set(key, value);
  while (memo.size > max) memo.delete(memo.keys().next().value);
}

/** The checks that ran on a branch's newest commit, and which of them the branch requires (branch protection or
 *  rulesets). Required is null when GitHub does not say, never guessed. A required check gates pull requests, so
 *  one that only runs on them never reports on the branch: it is listed in `requiredNotRun` and judges nothing
 *  (read live on 2026-11-10: three repos' required checks had not run on their base branch's head).
 *  The commit's checks and the branch's rules are read again when the branch moved, a check was pending, no check
 *  had reported yet, or 4 minutes passed; otherwise the read costs the one branch call, and `at` stays the time the
 *  checks were read. A required check pinned to a GitHub App counts only that app's run of it; a commit status named
 *  like one leaves requiredResult and requiredNotRun null, since a status does not say which app sent it. Check runs,
 *  statuses and rules are read up to 1,000 each. Past that, for checks, `truncated` is true and result,
 *  requiredResult and requiredNotRun are null; for rules, the required checks are not known. */
export async function readBaseChecks({ host = 'github.com', repo, branch }, { get = ghGet, now = Date.now, memo = baseMemo } = {}) {
  const at = now();
  try {
    const ref = segment(branch);
    const b = await get(`repos/${repo}/branches/${ref}`, { host });
    const sha = b?.commit?.sha;
    if (!sha) return { state: 'not-checked', why: `GitHub gave no commit for ${branch}`, at };
    const memoKey = `${host}/${repo}@${ref}:${sha}`;
    const kept = memo.get(memoKey);
    const reuse = kept && at - kept.at < REUSE_MS;
    const [runs, status, rules] = reuse ? kept.reads : await Promise.all([
      allPages(get, host, `repos/${repo}/commits/${sha}/check-runs?per_page=100`, 'check_runs', (r) => `id ${r?.id ?? JSON.stringify(r)}`),
      // The combined status has one entry per context, and a context is case-insensitive: a context seen twice moved
      // between pages.
      allPages(get, host, `repos/${repo}/commits/${sha}/status?per_page=100`, 'statuses', (s) => `context ${String(s?.context).toLowerCase()}`),
      allRules(get, host, `repos/${repo}/rules/branches/${ref}`).catch(() => null),
    ]);
    // Required checks: classic protection and rulesets together. Known only when both were read; one alone could
    // miss a check the other requires (PR-Agent r1 on #81). An unprotected branch has no classic protection to read.
    // Each requirement is a name and, when pinned, the GitHub App that must report it (app_id in protection,
    // integration_id in a ruleset; null or -1 is any source). Check runs carry their app (PR-Agent r2 on #81). A commit
    // status does not say which app sent it, so a status named like a pinned requirement may or may not meet it: its
    // place is unknown, and so is what the required checks add up to (PR-Agent r2 on #4). A commit status's context is
    // case-insensitive (GitHub's REST docs, "Create a commit status"), so it meets a requirement whatever its case; a
    // check run's name is compared as given (PR-Agent r4 on #4).
    const req = (context, app) => ({ context, app: app == null || app === -1 ? null : app });
    const rsc = b.protection?.required_status_checks;
    const fromProtection = rsc ? [...(rsc.contexts || []).filter((c) => !(rsc.checks || []).some((k) => k.context === c)).map((c) => req(c, null)), ...(rsc.checks || []).map((c) => req(c.context, c.app_id))] : [];
    const fromRules = Array.isArray(rules) ? rules.filter((r) => r.type === 'required_status_checks').flatMap((r) => (r.parameters?.required_status_checks || []).map((c) => req(c.context, c.integration_id))) : [];
    const known = (b.protection !== undefined || b.protected === false) && Array.isArray(rules);
    const required = known ? [...fromProtection, ...fromRules] : null;
    const fromRuns = (runs?.check_runs || []).map((r) => ({ name: r.name, app: r.app?.id ?? null, state: runState(r), url: r.html_url || r.details_url || null, at: r.completed_at || r.started_at || null }));
    const fromStatuses = (status?.statuses || []).map((s) => ({ name: s.context, app: null, state: statusState(s), url: s.target_url || null, at: s.updated_at || null }));
    // true, false, or null when it cannot be told.
    const named = (c, q, isStatus) => (isStatus ? String(c.name).toLowerCase() === String(q.context).toLowerCase() : c.name === q.context);
    const meets = (c, q, isStatus) => (!named(c, q, isStatus) ? false : q.app === null ? true : isStatus ? null : c.app === q.app);
    const anyOf = (m) => (m.includes(true) ? true : m.includes(null) ? null : false);
    const place = (c, isStatus) => (required ? anyOf(required.map((q) => meets(c, q, isStatus))) : null);
    const reported = (q) => anyOf([...fromRuns.map((c) => meets(c, q, false)), ...fromStatuses.map((c) => meets(c, q, true))]);
    const checks = [...fromRuns.map((c) => ({ ...c, required: place(c, false) })), ...fromStatuses.map((c) => ({ ...c, required: place(c, true) }))];
    const unsure = !!required && (checks.some((c) => c.required === null) || required.some((q) => reported(q) === null));
    // More checks than the pages read: the list shows what was read, and nothing is judged from it, since the check
    // that decides could be on a page not read.
    const truncated = !!(runs?.truncated || status?.truncated);
    // Only a settled set is reused: whole, none pending, at least one reported (CI may not have started on a new
    // commit), and the rules read.
    const settled = !truncated && checks.length > 0 && !checks.some((c) => c.state === 'pending') && Array.isArray(rules);
    if (settled && !reuse) remember(memo, memoKey, { at, reads: [runs, status, rules] });
    else if (!settled) memo.delete(memoKey);
    const readAt = reuse ? kept.at : at;
    const commit = b.commit.commit || {};
    return {
      state: 'checked', at: readAt, host, repo, branch, sha,
      title: String(commit.message || '').split('\n')[0].slice(0, 200), committedAt: commit.committer?.date || commit.author?.date || null,
      checks, result: truncated ? null : overall(checks.map((c) => c.state)),
      requiredResult: required && !truncated && !unsure ? overall(checks.filter((c) => c.required).map((c) => c.state)) : null,
      requiredNotRun: required && !truncated && !unsure ? [...new Set(required.filter((q) => reported(q) === false).map((q) => q.context))] : null,
      truncated,
    };
  } catch (ex) { return { state: 'not-checked', why: ghWhy(ex), at }; }
}

/** A pull request's size from GitHub: its own totals, and the same with lockfiles left out (the Too big call).
 *  Generated files cannot be told apart remotely; the local read (client/changes.mjs) leaves them out too.
 *  The file list is read again only when the PR's head, base or totals changed. */
export async function readPrSize({ host = 'github.com', repo, number }, { get = ghGet, now = Date.now, pages = 10, memo = sizeMemo } = {}) {
  const at = now();
  try {
    const pr = await get(`repos/${repo}/pulls/${number}`, { host });
    const out = {
      state: 'checked', at, host, repo, number, url: pr.html_url || null, prState: pr.merged ? 'merged' : pr.state, draft: !!pr.draft,
      head: pr.head?.sha || null, base: pr.base?.ref || null,
      additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changed_files, size: null, lockfiles: null,
    };
    // Per file, to leave lockfiles out. A PR with more files than the pages read keeps its totals only.
    // The base's commit is in the key: a force-pushed base can change the diff with the same head and totals
    // (PR-Agent r2 on #81).
    const memoKey = `${host}/${repo}#${number}@${out.head}:${out.base}:${pr.base?.sha}:${pr.additions}/${pr.deletions}/${pr.changed_files}`;
    const kept = out.head ? memo.get(memoKey) : null;
    if (kept) Object.assign(out, kept);
    else if (pr.changed_files <= pages * 100) {
      const files = [];
      for (let page = 1; page <= pages && files.length < pr.changed_files; page++) {
        const got = await get(`repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, { host });
        if (!Array.isArray(got) || !got.length) break;
        files.push(...got);
      }
      // A push while the pages were read could make a partial list look whole: the PR is read again, and a list
      // from another head, base or total is not used (PR-Agent r1 on #81).
      const same = (x) => x?.head?.sha === pr.head?.sha && x?.base?.ref === pr.base?.ref && x?.base?.sha === pr.base?.sha
        && x?.additions === pr.additions && x?.deletions === pr.deletions && x?.changed_files === pr.changed_files;
      if (files.length >= pr.changed_files && same(await get(`repos/${repo}/pulls/${number}`, { host }))) {
        const locks = files.filter((f) => LOCKFILE.test(f.filename));
        const counted = files.filter((f) => !LOCKFILE.test(f.filename));
        out.lockfiles = locks.map((f) => f.filename);
        out.size = { files: counted.length, added: counted.reduce((n, f) => n + (f.additions || 0), 0), removed: counted.reduce((n, f) => n + (f.deletions || 0), 0) };
        if (out.head) remember(memo, memoKey, { size: out.size, lockfiles: out.lockfiles });
      }
    }
    return out;
  } catch (ex) { return { state: 'not-checked', why: ghWhy(ex), at }; }
}

const repoOk = (repo) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(repo || ''));

/** Base-branch checks per thread: want([{ id, host, repo, branch }]) (or { id, why }); read again every 2 minutes,
 *  "not checked" after 6. */
export function createBaseChecks({ read = readBaseChecks, ...opts } = {}) {
  const f = createFollower({ read: (a) => read(a), every: 120000, gap: 120000, maxAge: 360000, name: 'base checks', ...opts });
  return {
    ...f,
    want(targets) {
      f.want(targets.map((x) => {
        if (x.why) return { id: x.id, why: x.why };
        if (!repoOk(x.repo) || !x.branch) return { id: x.id, why: 'no GitHub repo and base branch for this thread' };
        const host = String(x.host || 'github.com').toLowerCase();
        return { id: x.id, key: `${host}/${x.repo}@${x.branch}`, args: { host, repo: x.repo, branch: x.branch } };
      }));
    },
  };
}

/** PR sizes, per PR: want([{ id, host, repo, number, stamp }]), where id names the PR (prKey). Read again when its
 *  thread moves (at most every 2 minutes) and every 5 minutes; "not checked" after 15. */
export const prKey = ({ host = 'github.com', repo, number }) => `${String(host).toLowerCase()}/${repo}#${number}`;
export function createPrSizes({ read = readPrSize, ...opts } = {}) {
  const f = createFollower({ read: (a) => read(a), every: 300000, gap: 120000, maxAge: 900000, name: 'PR sizes', ...opts });
  return {
    ...f,
    want(targets) {
      f.want(targets.filter((x) => repoOk(x.repo) && Number.isInteger(x.number)).map((x) => {
        const host = String(x.host || 'github.com').toLowerCase();
        return { id: prKey(x), key: prKey(x), args: { host, repo: x.repo, number: x.number }, stamp: x.stamp };
      }));
    },
  };
}
