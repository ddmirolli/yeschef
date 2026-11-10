// T3 Code's thread shells, from the live stream, as the rows the board already reads.
// The board was built on `t3_thread_list` over MCP. That tool makes each row from the same shell the stream sends,
// with listItemFromShell, threadSettlement, threadSnooze and threadPullRequests (apps/server/src/mcp/
// OrchestratorMcpService.ts), isSnoozed (orchestration-v2/ThreadSettlementService.ts) and visibleThreadPullRequests
// (packages/shared/src/threadPullRequests.ts) in T3 Code v0.1.7, MIT, T3 Tools Inc. These are ports of them,
// so a board built from the stream matches one built from MCP.

const ms = (iso) => { if (iso == null) return null; const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

/** T3 Code's isSnoozed: the client's effective snooze, so the board and T3's sidebar agree. */
export function isSnoozed(thread, nowMs) {
  const until = ms(thread.snoozedUntil);
  if (until === null || until <= nowMs) return false;
  if (thread.pendingRuntimeRequest != null) return false;
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return false;
  const snoozedAt = ms(thread.snoozedAt), completedAt = ms(thread.latestRunCompletedAt);
  const wokeOnError = thread.status === 'failed' && (snoozedAt === null || (completedAt !== null && completedAt > snoozedAt));
  return !wokeOnError;
}

// T3 Code's normalizeThreadPullRequestKey keeps the host lowercased; a link without one is on github.com.
const hostOf = (link) => String(link.host || 'github.com').toLowerCase();

/** One row per shell, as `t3_thread_list` returns it. `link` makes the thread's address. */
export function threadRow(shell, { now = Date.now(), link = () => null } = {}) {
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
export function boardThreads(shells, { now = Date.now(), link, days = 14 } = {}) {
  const since = now - days * 86400000;
  const byId = new Map(shells.map((s) => [s.id, s]));
  const listed = shells.filter((s) => s.lineage?.sideChat !== true);
  const rows = new Map();
  for (const s of listed) {
    const r = threadRow(s, { now, link });
    if (!r.settled || (ms(r.updatedAt) ?? 0) >= since) rows.set(r.threadId, r);
  }
  const missing = new Set();
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
