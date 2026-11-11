// T3 Code's thread shells, from the live stream, as the rows the board already reads.
// The board was built on `t3_thread_list` over MCP. That tool makes each row from the same shell the stream sends,
// with listItemFromShell, threadSettlement, threadSnooze and threadPullRequests (apps/server/src/mcp/
// OrchestratorMcpService.ts), isSnoozed (orchestration-v2/ThreadSettlementService.ts) and visibleThreadPullRequests
// (packages/shared/src/threadPullRequests.ts) in T3 Code v0.1.7, MIT, T3 Tools Inc. These are ports of them,
// so a board built from the stream matches one built from MCP.
import type { ChangesRead, ChangesTarget } from './changes.ts';
import type { Project, ThreadRow } from './contracts.ts';
import type { BaseTarget } from './github.ts';

/** A pull request link on a shell: T3 Code's ThreadPullRequestLink, with GitHub's state as T3 last read it. */
export interface ShellPullRequest {
  host?: string | null | undefined;
  repository: string;
  number: number;
  url?: string | undefined;
  source?: string | undefined;
  snapshot?: { state?: string | null | undefined; baseBranch?: unknown; isDraft?: unknown; mergedAt?: unknown } | null | undefined;
}

/** The fields of a live-stream thread shell that Yes Chef reads (orchestrationV2 in T3 Code v0.1.7). Typed, not
 *  checked: T3 Code may leave out any optional one. */
export interface Shell {
  id: string;
  projectId?: string | undefined;
  title?: string | undefined;
  createdBy?: string | undefined;
  creationSource?: string | undefined;
  status: string;
  activityRunStatus?: string | null | undefined;
  latestRunId?: string | null | undefined;
  latestRunCompletedAt?: string | null | undefined;
  modelSelection?: { instanceId?: string | undefined; model?: string | undefined } | null | undefined;
  runtimeMode?: string | undefined;
  interactionMode?: string | undefined;
  linkedPullRequest?: unknown;
  pullRequests?: ShellPullRequest[] | null | undefined;
  settledOverride?: string | null | undefined;
  settledAt?: string | null | undefined;
  snoozedUntil?: string | null | undefined;
  snoozedAt?: string | null | undefined;
  pendingRuntimeRequest?: unknown;
  pendingGuestMessageCount?: number | null | undefined;
  lineage?: { parentThreadId?: string | null | undefined; relationshipToParent?: string | null | undefined; sideChat?: boolean | undefined } | null | undefined;
  visibleItemCount?: number | undefined;
  worktreePath?: string | null | undefined;
  createdAt?: string | undefined;
  updatedAt: string;
}

/** Makes a thread's address from its id. */
export type LinkFor = (threadId: string) => string | null;

const ms = (iso: unknown): number | null => { if (iso == null) return null; const t = Date.parse(iso as string); return Number.isFinite(t) ? t : null; };

/** T3 Code's isSnoozed: the client's effective snooze, so the board and T3's sidebar agree. */
export function isSnoozed(thread: Shell, nowMs: number): boolean {
  const until = ms(thread.snoozedUntil);
  if (until === null || until <= nowMs) return false;
  if (thread.pendingRuntimeRequest != null) return false;
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return false;
  const snoozedAt = ms(thread.snoozedAt), completedAt = ms(thread.latestRunCompletedAt);
  const wokeOnError = thread.status === 'failed' && (snoozedAt === null || (completedAt !== null && completedAt > snoozedAt));
  return !wokeOnError;
}

// T3 Code's normalizeThreadPullRequestKey keeps the host lowercased; a link without one is on github.com.
const hostOf = (link: ShellPullRequest): string => String(link.host || 'github.com').toLowerCase();

/** One row per shell, as `t3_thread_list` returns it. `link` makes the thread's address. */
export function threadRow(shell: Shell, { now = Date.now(), link = () => null }: { now?: number | undefined; link?: LinkFor | undefined } = {}): ThreadRow {
  const settled = shell.settledOverride === 'settled';
  const snoozed = isSnoozed(shell, now);
  return {
    threadId: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    link: link(shell.id),
    createdBy: shell.createdBy,
    creationSource: shell.creationSource,
    status: shell.activityRunStatus ?? shell.status,
    latestRunId: shell.latestRunId ?? null,
    providerInstanceId: shell.modelSelection?.instanceId,
    model: shell.modelSelection?.model,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    linkedPullRequest: shell.linkedPullRequest ?? null,
    pullRequests: (shell.pullRequests || []).filter((l) => l.source !== 'stack-dismissed').map((l) => ({
      host: hostOf(l), repository: l.repository, number: l.number, url: l.url, source: l.source, state: l.snapshot?.state ?? null,
      // T3's PR snapshot (ThreadPullRequestSnapshot): the target branch, draft, and when it merged. The team summary
      // sends them (3b PR 4); a value T3 leaves out stays null.
      base: typeof l.snapshot?.baseBranch === 'string' ? l.snapshot.baseBranch : null,
      draft: typeof l.snapshot?.isDraft === 'boolean' ? l.snapshot.isDraft : null,
      mergedAt: typeof l.snapshot?.mergedAt === 'string' ? l.snapshot.mergedAt : null,
    })),
    settled,
    settledAt: settled && shell.settledAt != null ? shell.settledAt : null,
    snoozed,
    snoozedUntil: snoozed && shell.snoozedUntil != null ? shell.snoozedUntil : null,
    parentThreadId: shell.lineage?.parentThreadId ?? null,
    relationshipToParent: shell.lineage?.relationshipToParent ?? null,
    itemCount: shell.visibleItemCount,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
  };
}

/** The threads the board reads, as the old poll chose them: every listed thread (subagents included, side chats
 *  left out, as `t3_thread_list` does) that is not settled, every settled one updated in the last two weeks, and
 *  every ancestor of those that the stream has. Returns the rows and the ancestors the stream does not have. */
export function boardThreads(shells: Shell[], { now = Date.now(), link, days = 14 }: { now?: number; link?: LinkFor | undefined; days?: number } = {}): { threads: ThreadRow[]; missing: string[] } {
  const since = now - days * 86400000;
  const byId = new Map(shells.map((s) => [s.id, s]));
  const listed = shells.filter((s) => s.lineage?.sideChat !== true);
  const rows = new Map<string, ThreadRow>();
  for (const s of listed) {
    const r = threadRow(s, { now, link });
    if (!r.settled || (ms(r.updatedAt) ?? 0) >= since) rows.set(r.threadId, r);
  }
  const missing = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of [...rows.values()]) {
      const p = r.parentThreadId;
      if (!p || rows.has(p) || missing.has(p)) continue;
      const shell = byId.get(p);
      if (shell) { rows.set(p, threadRow(shell, { now, link })); changed = true; } else missing.add(p);
    }
  }
  const sorted = [...rows.values()].sort((a, b) => (ms(b.updatedAt) ?? 0) - (ms(a.updatedAt) ?? 0) || String(b.threadId).localeCompare(String(a.threadId)));
  return { threads: sorted, missing: [...missing] };
}

/** The folder a thread works in, as T3 Code picks it: its worktree, or else its project's root (T3 Code's
 *  Orchestrator.ts: `thread.worktreePath ?? project.workspaceRoot`). */
export const threadFolder = (shell: Shell | null | undefined, project: Pick<Project, 'workspaceRoot'> | null | undefined): string | null => shell?.worktreePath ?? project?.workspaceRoot ?? null;

/** The base branch an open pull request of the thread names, or null. */
export function prBase(shell: Shell | null | undefined): string | null {
  const open = (shell?.pullRequests || []).find((l) => l.source !== 'stack-dismissed' && l.snapshot?.state === 'open');
  return (open?.snapshot?.baseBranch as string | null | undefined) ?? null;
}

/** The board threads whose changed files Yes Chef follows: every one not settled, and any with an open pull request,
 *  as [{ id, folder, branch, stamp }] for createChanges().want (client/changes.ts). A thread the stream does not
 *  carry is left out, so its changes read "not checked". */
export function changeTargets(rows: ThreadRow[], shells: Map<string, Shell>, project: (id: string | undefined) => Pick<Project, 'workspaceRoot'> | null | undefined = () => null): ChangesTarget[] {
  return rows.filter((t) => !t.settled || (t.pullRequests || []).some((p) => p.state === 'open')).flatMap((t): ChangesTarget[] => {
    const s = shells.get(t.threadId);
    return s ? [{ id: t.threadId, folder: threadFolder(s, project(s.projectId)), branch: prBase(s), stamp: s.updatedAt ?? null }] : [];
  });
}

const openLinks = (shell: Shell | null | undefined): ShellPullRequest[] => (shell?.pullRequests || []).filter((l) => l.source !== 'stack-dismissed' && l.snapshot?.state === 'open');
const mergedLinks = (shell: Shell | null | undefined): ShellPullRequest[] => (shell?.pullRequests || []).filter((l) => l.source !== 'stack-dismissed' && l.snapshot?.state === 'merged');

/** What GitHub is asked about the followed threads (client/github.ts), read only.
 *  base: per thread, the repo and base branch of its open pull request, or else the repo and base its local read
 *  found (client/changes.ts `remote` and `base.branch`), as [{ id, host, repo, branch }] or [{ id, why }].
 *  prs: every open pull request of those threads, once each, [{ host, repo, number, stamp }], stamped with the
 *  thread's last move; and every merged one, with merged: true, for its merge commit (3b PR 4b). */
/** One pull request to read, as githubTargets gives it. */
export interface PrToRead { host: string; repo: string; number: number; stamp: string | null; merged: boolean }
export function githubTargets(targets: { id: string }[], shells: Map<string, Shell>, local: (id: string) => ChangesRead | null | undefined = () => null): { base: BaseTarget[]; prs: PrToRead[] } {
  const base: BaseTarget[] = [], prs = new Map<string, PrToRead>();
  for (const { id } of targets) {
    const s = shells.get(id);
    const links = openLinks(s);
    for (const [l, merged] of [...links.map((l) => [l, false] as const), ...mergedLinks(s).map((l) => [l, true] as const)]) {
      if (!l.repository || !Number.isInteger(l.number)) continue;
      const k = `${hostOf(l)}/${l.repository}#${l.number}`;
      const stamp = s!.updatedAt ?? null;
      // Open in any thread wins: the PR's size and runs are still read.
      if (prs.has(k) && prs.get(k)!.merged === false && merged) continue;
      if (!prs.has(k) || (prs.get(k)!.merged && !merged) || String(stamp ?? '') > String(prs.get(k)!.stamp ?? '')) {
        prs.set(k, { host: hostOf(l), repo: l.repository, number: l.number, stamp, merged });
      }
    }
    const pr = links.find((l) => l.repository && l.snapshot?.baseBranch);
    if (pr) { base.push({ id, host: hostOf(pr), repo: pr.repository, branch: pr.snapshot!.baseBranch as string }); continue; }
    const r = local(id);
    if (r?.state === 'checked' && r.remote && r.base?.branch) base.push({ id, host: r.remote.host, repo: r.remote.repo, branch: r.base.branch });
    else base.push({ id, why: r?.state === 'checked' ? 'the folder has no remote named origin' : `its folder is not checked: ${(r as { why?: string } | null | undefined)?.why || 'not read yet'}` });
  }
  return { base, prs: [...prs.values()] };
}
