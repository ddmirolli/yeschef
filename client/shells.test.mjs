// The stream's shells as the rows `t3_thread_list` gave the board (ports of T3 Code v0.1.7's own mapping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadRow, boardThreads, isSnoozed, changeTargets, threadFolder, prBase } from './shells.mjs';
import { buildBoard } from './board.mjs';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const iso = (h) => new Date(NOW + h * 3600000).toISOString();
const shell = (id, extra = {}) => ({
  id, projectId: 'p1', title: `Thread ${id}`, createdBy: 'user', creationSource: 'web',
  modelSelection: { instanceId: 'claude', model: 'claude-opus-5-5' }, runtimeMode: 'full-access', interactionMode: 'default',
  lineage: { parentThreadId: null, relationshipToParent: null }, status: 'idle', activityRunStatus: null, latestRunId: 'r1',
  pendingRuntimeRequest: null, settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null,
  latestRunCompletedAt: null, pullRequests: [], linkedPullRequest: null, itemCount: 40, visibleItemCount: 12,
  worktreePath: '/tmp/wt', branch: 't3/x', createdAt: iso(-5), updatedAt: iso(-1), ...extra,
});

test('a row: the fields t3_thread_list returns, from the shell', () => {
  const r = threadRow(shell('a', {
    activityRunStatus: 'running', status: 'completed',
    pullRequests: [
      { host: 'GitHub.com', repository: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', source: 'created', snapshot: { state: 'open' } },
      { repository: 'o/r', number: 8, url: 'https://github.com/o/r/pull/8', source: 'stack-dismissed', snapshot: { state: 'open' } },
      { repository: 'o/r', number: 9, url: 'https://github.com/o/r/pull/9', source: 'agent', snapshot: null },
    ],
  }), { now: NOW, link: (id) => `https://app.example/env/${id}` });
  assert.equal(r.threadId, 'a');
  assert.equal(r.status, 'running', 'the activity status wins, as in T3');
  assert.equal(r.itemCount, 12, 'visible items, as in T3');
  assert.equal(r.link, 'https://app.example/env/a');
  assert.equal(r.model, 'claude-opus-5-5');
  assert.deepEqual(r.pullRequests, [
    { host: 'github.com', repository: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', source: 'created', state: 'open' },
    { host: 'github.com', repository: 'o/r', number: 9, url: 'https://github.com/o/r/pull/9', source: 'agent', state: null },
  ]);
  assert.equal(r.settled, false);
  assert.equal(r.parentThreadId, null);
});

test('settled and snoozed, as T3 decides them', () => {
  assert.equal(threadRow(shell('a', { settledOverride: 'settled', settledAt: iso(-2) })).settledAt, iso(-2));
  assert.equal(threadRow(shell('a', { settledOverride: 'active', settledAt: iso(-2) })).settled, false);
  const snoozed = { snoozedUntil: iso(5), snoozedAt: iso(-1) };
  assert.equal(isSnoozed(shell('a', snoozed), NOW), true);
  assert.equal(isSnoozed(shell('a', { ...snoozed, snoozedUntil: iso(-0.5) }), NOW), false, 'expired');
  assert.equal(isSnoozed(shell('a', { ...snoozed, pendingRuntimeRequest: { id: 'q' } }), NOW), false, 'a question wakes it');
  assert.equal(isSnoozed(shell('a', { ...snoozed, pendingGuestMessageCount: 1 }), NOW), false, 'a guest message wakes it');
  assert.equal(isSnoozed(shell('a', { ...snoozed, status: 'failed', latestRunCompletedAt: iso(-0.5) }), NOW), false, 'a failure after the snooze wakes it');
  assert.equal(isSnoozed(shell('a', { ...snoozed, status: 'failed', latestRunCompletedAt: iso(-2) }), NOW), true, 'a failure before the snooze does not');
  const r = threadRow(shell('a', snoozed), { now: NOW });
  assert.equal(r.snoozed, true);
  assert.equal(r.snoozedUntil, iso(5));
});

test('the threads the board reads: open ones, settled in the last two weeks, and their ancestors', () => {
  const shells = [
    shell('open', { updatedAt: iso(-24 * 30) }),
    shell('recent', { settledOverride: 'settled', settledAt: iso(-3), updatedAt: iso(-3) }),
    shell('old', { settledOverride: 'settled', settledAt: iso(-24 * 20), updatedAt: iso(-24 * 20) }),
    shell('oldparent', { settledOverride: 'settled', settledAt: iso(-24 * 40), updatedAt: iso(-24 * 40) }),
    shell('child', { lineage: { parentThreadId: 'oldparent' }, activityRunStatus: 'running' }),
    shell('orphan', { lineage: { parentThreadId: 'archived' } }),
    shell('side', { lineage: { parentThreadId: 'open', sideChat: true } }),
  ];
  const { threads, missing } = boardThreads(shells, { now: NOW });
  assert.deepEqual(threads.map((t) => t.threadId).sort(), ['child', 'oldparent', 'open', 'orphan', 'recent']);
  assert.deepEqual(missing, ['archived']);
  // Newest first, as t3_thread_list sorts.
  const times = threads.map((t) => Date.parse(t.updatedAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test('the board from stream rows matches the board from the same rows over MCP', () => {
  const shells = [
    shell('t1', { activityRunStatus: 'running', pullRequests: [{ repository: 'o/r', number: 3, url: 'u', source: 'created', snapshot: { state: 'open' } }] }),
    shell('s1', { lineage: { parentThreadId: 't1' }, status: 'completed' }),
    shell('t2', { status: 'completed', pullRequests: [{ repository: 'o/r', number: 4, url: 'u', source: 'created', snapshot: { state: 'merged' } }] }),
  ];
  const { threads } = boardThreads(shells, { now: NOW });
  const board = buildBoard({ projects: [{ id: 'p1', title: 'P' }], threads, questions: new Map(), today: new Date(NOW) });
  const by = Object.fromEntries(board.tickets.map((k) => [k.thread.threadId, k]));
  assert.equal(by.t1.place, 'In progress');
  assert.equal(by.t1.stations, 1);
  assert.equal(by.t2.place, 'Merged');
});

test('whose changes to follow: open threads and any with an open PR, in the folder T3 Code runs them in', () => {
  const pr = (state, extra = {}) => ({ repository: 'o/r', number: 1, url: 'u', source: 'created', snapshot: { state, baseBranch: 'staging' }, ...extra });
  const shells = [
    shell('open'),
    shell('home', { worktreePath: null, projectId: 'p2' }),
    shell('settled', { settledOverride: 'settled', settledAt: iso(-2) }),
    shell('settled-pr', { settledOverride: 'settled', settledAt: iso(-2), pullRequests: [pr('open')] }),
    shell('merged', { settledOverride: 'settled', settledAt: iso(-2), pullRequests: [pr('merged')] }),
  ];
  const rows = boardThreads(shells, { now: NOW }).threads;
  const byId = new Map(shells.map((x) => [x.id, x]));
  const projects = { p2: { id: 'p2', workspaceRoot: '/repo/home' } };
  const got = changeTargets([...rows, { threadId: 'mcp-only', settled: false }], byId, (id) => projects[id] ?? null);
  assert.deepEqual(got.map((x) => x.id).sort(), ['home', 'open', 'settled-pr']);
  const by = Object.fromEntries(got.map((x) => [x.id, x]));
  assert.equal(by.open.folder, '/tmp/wt');
  assert.equal(by.home.folder, '/repo/home', 'no worktree: the project root, as T3 runs it');
  assert.equal(by['settled-pr'].branch, 'staging');
  assert.equal(by.open.stamp, iso(-1));
  assert.equal(threadFolder({ worktreePath: null }, null), null);
  assert.equal(prBase({ pullRequests: [pr('open', { source: 'stack-dismissed' })] }), null, 'a dismissed link is not the thread\'s PR');
  assert.equal(prBase({ pullRequests: [pr('closed'), pr('open')] }), 'staging');
});
