// What step 4's Failing, Waiting on review, Main broken and Too big calls read from GitHub beyond a PR's size
// (client/github.ts): a PR's check result per pushed commit, when it was marked ready for review, its merge commit,
// and the first red commit of a base branch's current run of red. Read only, through the `get` the caller passes
// (github.ts ghGet), so every read is a GET through gh's own sign-in. Missing data is null: "not checked", never a
// guess. 3b PR 4b (docs/team-relay-v0_1.md, "What step 4's calls read").

export type Get = (path: string, opts: { host: string }) => Promise<unknown>;
/** One commit's checks as one word. 'pending' and 'none' never count as a run. */
export type Result = 'passing' | 'failing' | 'neutral' | 'pending' | 'none';
export type Run = { at: number; sha: string; title: string; result: 'passing' | 'failing' | 'neutral' };
export type Checks = { result: Result | null; redRuns: number; at: number; runs: Run[] };
export type PrRuns =
  | { state: 'checked'; at: number; host: string; repo: string; number: number; head: string | null; draft: boolean | null;
      readyAt: number | null; mergeSha: string | null; checks: Checks | null }
  | { state: 'not-checked'; why: string; at: number };
export type BaseRed = { redSha: string | null; redSince: number | null };
type Memo = Map<string, { result: Result; done: boolean; at: number }>;
/** A commit's checks as one word, and whether every one of them finished. */
export type CommitChecks = { result: Result; done: boolean };

export const RUNS_MAX = 10;
const COMMITS_MAX = 250; // GitHub lists at most 250 commits of a pull request
const EVENT_PAGES = 3, BASE_COMMITS = 50, MEMO_MAX = 2000;
// A finished commit's checks change only when someone runs them again: kept this long, then read again.
export const RERUN_MS = 30 * 60000;
const runMemo: Memo = new Map();
const mergeMemo = new Map<string, string>(); // host/repo#number -> merge commit: it never changes once merged

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const time = (x: unknown): number | null => {
  const t = typeof x === 'string' ? Date.parse(x) : NaN;
  return Number.isFinite(t) ? t : null;
};
const SHA = /^[0-9a-f]{40}$/;
const sha = (x: unknown): string | null => (typeof x === 'string' && SHA.test(x) ? x : null);

/** One check run or status in four words, as GitHub counts a required check: not complete is pending; cancelled,
 *  timed out and the like fail. */
function runWord(run: Record<string, unknown>): Result {
  if (run.status !== 'completed') return 'pending';
  if (run.conclusion === 'success') return 'passing';
  if (run.conclusion === 'neutral' || run.conclusion === 'skipped') return 'neutral';
  return 'failing';
}
const statusWord = (s: Record<string, unknown>): Result => (s.state === 'success' ? 'passing' : s.state === 'pending' ? 'pending' : 'failing');
/** Many as one: failing beats pending beats passing; only neutral is neutral; nothing at all is 'none'. */
export function combine(words: Result[]): Result {
  const w = words.filter((x) => x !== 'none');
  if (!w.length) return 'none';
  if (w.includes('failing')) return 'failing';
  if (w.includes('pending')) return 'pending';
  return w.includes('passing') ? 'passing' : 'neutral';
}

type CommitOpts = { names?: string[] | null; memo?: Memo; head?: boolean; now?: () => number };
/** One commit's checks: its check runs (the latest of each) and its commit statuses (the latest per context). With
 *  `names`, only those checks count (a base's required checks), and one of them not reported yet is pending (PR-Agent
 *  r1 on #28). `done`: every check finished, so one red check among running ones is failing but not done (PR-Agent
 *  r2 on #28). Null when GitHub gave more than one page.
 *  Kept, under a key that holds the names: behind the head, a finished result or none for 30 minutes, then read again
 *  (checks can be run again, or start late). The head is always read: its CI may not have started, or may be
 *  running again (PR-Agent r1 and r2 on #28). */
export async function commitChecks(get: Get, host: string, repo: string, commit: string,
  { names = null, memo = runMemo, head = false, now = Date.now }: CommitOpts = {}): Promise<CommitChecks | null> {
  // The selector is tagged, so no check's name can stand for "all checks" (PR-Agent r3 on #28).
  const key = `${host}/${repo}@${commit}:${names ? `names:${JSON.stringify(names)}` : 'all'}`;
  const kept = head ? null : memo.get(key);
  if (kept && now() - kept.at < RERUN_MS) return { result: kept.result, done: kept.done };
  const runs = obj(await get(`repos/${repo}/commits/${commit}/check-runs?per_page=100`, { host }));
  const status = obj(await get(`repos/${repo}/commits/${commit}/status?per_page=100`, { host }));
  const checkRuns = list(runs.check_runs).map(obj), statuses = list(status.statuses).map(obj);
  if (Number(runs.total_count) > checkRuns.length || Number(status.total_count) > statuses.length) return null;
  const want = (name: unknown) => !names || (typeof name === 'string' && names.includes(name));
  const words = [...checkRuns.filter((r) => want(r.name)).map(runWord), ...statuses.filter((s) => want(s.context)).map(statusWord)];
  const reported = new Set([...checkRuns.map((r) => r.name), ...statuses.map((s) => s.context)]);
  if (names?.some((n) => !reported.has(n))) words.push('pending');
  const result = combine(words), done = !words.includes('pending');
  memo.delete(key);
  if (!head && done) {
    memo.set(key, { result, done, at: now() });
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
  }
  return { result, done };
}
/** The same as one word. */
export async function commitResult(get: Get, host: string, repo: string, commit: string, opts: CommitOpts = {}): Promise<Result | null> {
  return (await commitChecks(get, host, repo, commit, opts))?.result ?? null;
}

/** The PR's last runs, oldest first: the commits whose checks finished (passing, failing or neutral), at most 10.
 *  A commit with no checks (an inner commit of a push) or still pending is not a run. The commits are read back a
 *  page at a time until 10 runs or the PR's first commit, so a long push never hides the runs before it (PR-Agent r1
 *  on #28). redRuns: how many of the last runs failed in a row. Null when the list cannot reach the PR's head. */
async function prChecks(get: Get, host: string, repo: string, number: number, pr: Record<string, unknown>, at: number, memo: Memo, now: () => number): Promise<Checks | null> {
  const head = sha(obj(pr.head).sha), count = Number(pr.commits);
  if (!head || !Number.isInteger(count) || count < 1 || count > COMMITS_MAX) return null;
  const runs: Run[] = [];
  let result: Result | null = null;
  for (let page = Math.ceil(count / 100); page >= 1 && runs.length < RUNS_MAX; page--) {
    const commits = list(await get(`repos/${repo}/pulls/${number}/commits?per_page=100&page=${page}`, { host })).map(obj);
    // A push between the reads: the list ends elsewhere, and the next read sees it whole.
    if (page === Math.ceil(count / 100) && sha(commits.at(-1)?.sha) !== head) return null;
    for (const c of commits.reverse()) {
      const id = sha(c.sha);
      if (!id) return null;
      const c2 = await commitChecks(get, host, repo, id, { memo, head: id === head, now });
      if (c2 === null) return null;
      const r = c2.result;
      if (id === head) result = r;
      // Only a commit whose checks all finished is a run (PR-Agent r2 on #28).
      if (!c2.done || r === 'pending' || r === 'none') continue;
      const commit = obj(c.commit);
      const when = time(obj(commit.committer).date) ?? time(obj(commit.author).date);
      if (when === null) return null;
      runs.unshift({ at: when, sha: id, title: String(commit.message ?? '').split('\n')[0]!.slice(0, 120), result: r });
      if (runs.length === RUNS_MAX) break;
    }
  }
  let redRuns = 0;
  for (let i = runs.length - 1; i >= 0 && runs[i]!.result === 'failing'; i--) redRuns++;
  return { result, redRuns, at, runs };
}

/** When the PR was last marked ready for review; a PR opened ready, when it was opened. Null for a draft, and when
 *  its events run past the pages read. */
async function readyAt(get: Get, host: string, repo: string, number: number, pr: Record<string, unknown>): Promise<number | null> {
  if (pr.draft !== false) return null;
  let ready: number | null = null;
  for (let page = 1; page <= EVENT_PAGES; page++) {
    const events = list(await get(`repos/${repo}/issues/${number}/events?per_page=100&page=${page}`, { host })).map(obj);
    for (const e of events) if (e.event === 'ready_for_review') ready = time(e.created_at) ?? ready;
    if (events.length < 100) return ready ?? time(pr.created_at);
  }
  return null;
}

/** One pull request's runs, ready time and merge commit. `get` is ghGet; a failed read is "not checked" with
 *  `why(ex)`'s reason. */
export async function readPrRuns(
  { host = 'github.com', repo, number }: { host?: string; repo: string; number: number },
  { get, why = (ex: unknown) => String((ex as Error)?.message ?? ex).slice(0, 160), now = Date.now, memo = runMemo, merges = mergeMemo }:
    { get: Get; why?: (ex: unknown) => string; now?: () => number; memo?: Memo; merges?: Map<string, string> },
): Promise<PrRuns> {
  const at = now();
  const key = `${host.toLowerCase()}/${repo}#${number}`;
  const kept = merges.get(key);
  if (kept) return { state: 'checked', at, host, repo, number, head: null, draft: false, readyAt: null, mergeSha: kept, checks: null };
  try {
    const pr = obj(await get(`repos/${repo}/pulls/${number}`, { host }));
    const merged = pr.merged === true;
    const mergeSha = merged ? sha(pr.merge_commit_sha) : null;
    if (mergeSha) {
      merges.set(key, mergeSha);
      while (merges.size > MEMO_MAX) merges.delete(merges.keys().next().value as string);
    }
    return {
      state: 'checked', at, host, repo, number, head: sha(obj(pr.head).sha), draft: typeof pr.draft === 'boolean' ? pr.draft : null,
      readyAt: pr.state === 'open' ? await readyAt(get, host, repo, number, pr) : null,
      mergeSha,
      checks: pr.state === 'open' ? await prChecks(get, host, repo, number, pr, at, memo, now) : null,
    };
  } catch (ex) { return { state: 'not-checked', why: why(ex), at }; }
}

/** The first red commit of a base branch's current run of red, and its commit time, walking first parents back from
 *  `head` (the commit readBaseChecks read). Commits whose checks are pending or absent are passed over. Both null
 *  when the head is not red, or when the red runs past the commits read (not checked). `names`: the base's
 *  required checks, so the run matches Main broken's own test. */
export async function readBaseRed(
  { host = 'github.com', repo, branch, head, names = null }: { host?: string; repo: string; branch: string; head: string; names?: string[] | null },
  { get, memo = runMemo }: { get: Get; memo?: Memo },
): Promise<BaseRed> {
  const none: BaseRed = { redSha: null, redSince: null };
  // Every character outside ghGet's safe set is percent-encoded, parentheses and the like too (PR-Agent r2 on #28).
  const ref = encodeURIComponent(branch).replace(/[^A-Za-z0-9._%-]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  const commits = list(await get(`repos/${repo}/commits?sha=${ref}&per_page=${BASE_COMMITS}`, { host })).map(obj);
  const bySha = new Map(commits.map((c) => [sha(c.sha), c] as const));
  let red: Record<string, unknown> | null = null;
  for (let c = bySha.get(head); c; ) {
    const id = sha(c.sha)!;
    const r = await commitResult(get, host, repo, id, { names, memo, head: id === head });
    if (r === null) return none;
    if (r === 'failing') red = c;
    else if (r === 'passing' || r === 'neutral') break;
    c = bySha.get(sha(obj(list(c.parents)[0]).sha));
    if (!c) return none; // past the commits read, or the first commit: where the red began is not checked
  }
  if (!red) return none;
  const commit = obj(red.commit);
  return { redSha: sha(red.sha), redSince: time(obj(commit.committer).date) ?? time(obj(commit.author).date) };
}
