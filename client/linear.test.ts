// Linear tickets from the agents' own Linear MCP calls in T3 Code. The items copy the shapes T3 recorded on 2026-11-13
// for a Claude and a Codex call; the tickets in them are made up.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { cleanIssue, createLinearReads, linearCall } from './linear.ts';
import type { LinearThread } from './linear.ts';

const issue = (id: string, more: Record<string, unknown> = {}) => ({ id, title: `Ticket ${id}`, status: 'In Progress', statusType: 'started',
  url: `https://linear.app/acme/issue/${id}/ticket-${id.toLowerCase()}`, assignee: 'Ada', ...more });
// Claude: the MCP result with its content list and _meta (T3 ClaudeAdapterV2).
const claudeItem = (tool: string, input: unknown, body: unknown) => JSON.stringify({ toolName: `mcp__linear-server__${tool}`, input,
  output: { content: [{ type: 'text', text: JSON.stringify(body) }], _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'linear', title: 'Linear' } } } }, null, 2);
// Codex: the content list itself, under "server.tool".
const codexItem = (tool: string, input: unknown, body: unknown) => JSON.stringify({ toolName: `linear-server.${tool}`, input, output: [{ type: 'text', text: JSON.stringify(body) }] }, null, 2);

test('a Claude get_issue and a Codex list_issues give their tickets', () => {
  const one = linearCall(claudeItem('get_issue', { id: 'ENG-12' }, issue('ENG-12')), 1000);
  assert.deepEqual(one, { tool: 'get_issue', about: ['ENG-12'], at: 1000,
    issues: [{ id: 'ENG-12', title: 'Ticket ENG-12', status: 'In Progress', statusType: 'started', url: 'https://linear.app/acme/issue/ENG-12/ticket-eng-12', assignee: 'Ada' }] });
  const list = linearCall(codexItem('list_issues', { limit: 2 }, { issues: [issue('ENG-1'), issue('ENG-2', { status: 'Done', statusType: 'completed' })], hasNextPage: false }), 2000);
  assert.equal(list?.tool, 'list_issues');
  // A list is about no one ticket: it links no thread.
  assert.deepEqual(list?.about, []);
  assert.deepEqual(list?.issues.map((x) => [x.id, x.status]), [['ENG-1', 'In Progress'], ['ENG-2', 'Done']]);
});

test('other tools, other servers and broken items are not Linear calls', () => {
  assert.equal(linearCall(JSON.stringify({ toolName: 'ToolSearch', input: {}, output: {} }), 1), null);
  assert.equal(linearCall(JSON.stringify({ toolName: 'mcp__github__get_issue', input: { id: 'ENG-1' }, output: [] }), 1), null);
  assert.equal(linearCall(JSON.stringify({ toolName: 'mcp__linear-server__save_comment', input: {}, output: [] }), 1), null);
  assert.equal(linearCall('{"toolName": "mcp__linear-server__get_issue", "inp', 1), null);
  // An error reply still says what the call was about, with no ticket fields.
  const failed = linearCall(JSON.stringify({ toolName: 'mcp__linear-server__get_issue', input: { id: 'eng-7' }, output: 'Error: not found' }), 5);
  assert.deepEqual(failed, { tool: 'get_issue', about: ['ENG-7'], issues: [], at: 5 });
});

test('each field is checked once, here at the edge; anything else is dropped', () => {
  assert.equal(cleanIssue({ id: 'not an id' }), null);
  assert.equal(cleanIssue(['ENG-1']), null);
  assert.deepEqual(cleanIssue({ identifier: 'ENG-3', state: { name: 'Todo' } }), { id: 'ENG-3', status: 'Todo' });
  const bad = cleanIssue({ id: 'ENG-4', title: 'x'.repeat(5000), statusType: 'on fire', url: 'https://evil.example/issue/ENG-4', assignee: { name: 'Ada' }, status: 'a\u0000b\nc' });
  assert.deepEqual(bad, { id: 'ENG-4', title: 'x'.repeat(300), status: 'a b c' });
  // The address must be Linear's, for this ticket.
  assert.equal(cleanIssue({ id: 'ENG-5', url: 'https://linear.app/acme/issue/ENG-6/other' })?.url, undefined);
  assert.equal(cleanIssue({ id: 'ENG-5', url: 'javascript:alert(1)' })?.url, undefined);
  // Leaf fuzz: no value of any shape throws, and whatever survives keeps a ticket id.
  const leaves: unknown[] = [null, undefined, 0, -1, NaN, true, '', ' ', 'ENG-1', 'eng-99', {}, [], [1], { name: 'x' }, '<script>', 'x'.repeat(10_000)];
  for (const a of leaves) for (const b of leaves) {
    const out = cleanIssue({ id: a, identifier: b, title: a, status: b, statusType: a, url: b, assignee: a, state: b });
    assert.ok(out === null || /^[A-Z][A-Z0-9_]{0,9}-[0-9]{1,7}$/.test(out.id!));
  }
});

// A stand-in for T3's t3_thread_read: activity pages with short text, and each item in full by its itemId.
function fakeT3(threads: Record<string, { itemId: string; type: string; status?: string; text: string; updatedAt: string }[]>, log: unknown[][] = []) {
  return async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    log.push([name, args]);
    const items = threads[String(args.threadId)] ?? [];
    if (args.itemId) {
      const it = items.find((x) => x.itemId === args.itemId)!;
      const from = Number(args.textOffset ?? 0), max = Number(args.maxCharsPerItem);
      return { items: [{ ...it, text: it.text.slice(from, from + max), textTruncated: from + max < it.text.length, nextTextOffset: from + max < it.text.length ? from + max : null }] };
    }
    const after = Number(args.afterPosition), limit = Number(args.limit);
    const page = items.map((x, position) => ({ ...x, position })).filter((x) => x.position > after).slice(0, limit);
    return { items: page.map((x) => ({ ...x, text: x.text.slice(0, Number(args.maxCharsPerItem)), textTruncated: x.text.length > Number(args.maxCharsPerItem) })),
      nextPosition: page.length ? page[page.length - 1]!.position : after, hasMore: page.length === limit };
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const NOW = Date.parse('2026-11-13T12:00:00Z');
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();

test('the reader keeps the newest read of each ticket and links it to the thread that read it', async () => {
  const items = {
    a: [{ itemId: 'm0', type: 'user_message', text: 'look at ENG-12', updatedAt: at(30) },
      { itemId: 't1', type: 'dynamic_tool', text: claudeItem('get_issue', { id: 'ENG-12' }, issue('ENG-12', { status: 'Todo', statusType: 'unstarted' })), updatedAt: at(20) }],
    b: [{ itemId: 'm0', type: 'user_message', text: 'list', updatedAt: at(15) },
      { itemId: 't1', type: 'dynamic_tool', text: codexItem('list_issues', {}, { issues: [issue('ENG-12'), issue('ENG-13')] }), updatedAt: at(10) }],
  };
  const calls: unknown[][] = [];
  const reads = createLinearReads({ call: fakeT3(items, calls), now: () => NOW });
  let news = 0; reads.subscribe(() => { news++; });
  const threads: LinearThread[] = [{ threadId: 'a', title: 'Fix the import', updatedAt: at(20), itemCount: 2 }, { threadId: 'b', title: 'Triage', updatedAt: at(10), itemCount: 2 }];
  reads.want(threads);
  for (let i = 0; i < 5; i++) await settle();
  assert.ok(news >= 1);
  // ENG-12: thread a read it as Todo, thread b's newer list shows In Progress. The newer read wins.
  assert.equal(reads.get('ENG-12')?.status, 'In Progress');
  assert.equal(reads.get('ENG-12')?.by, 'b');
  // Thread a read ENG-12, so its ticket links it; thread b only listed tickets, so it links none.
  assert.deepEqual(reads.forThreads([threads[0]!]).map((x) => [x.id, x.state]), [['ENG-12', 'read']]);
  assert.deepEqual(reads.forThreads([threads[1]!]), []);
  // Only the Linear tool items were read in full.
  assert.equal(calls.filter(([, a]) => (a as { itemId?: string }).itemId).length, 2);
  // Nothing moved: wanting the same threads again reads nothing.
  const before = calls.length;
  reads.want(threads);
  await settle();
  assert.equal(calls.length, before);
});

test('a later item is read from where the last read stopped, and a long output is read page by page', async () => {
  const big = claudeItem('get_issue', { id: 'ENG-20' }, issue('ENG-20', { description: 'y'.repeat(120_000) }));
  const items: Record<string, { itemId: string; type: string; text: string; updatedAt: string }[]> = { a: [{ itemId: 'm0', type: 'user_message', text: 'hi', updatedAt: at(9) }] };
  const calls: unknown[][] = [];
  const reads = createLinearReads({ call: fakeT3(items, calls), now: () => NOW });
  reads.want([{ threadId: 'a', updatedAt: at(9), itemCount: 1 }]);
  for (let i = 0; i < 3; i++) await settle();
  items.a!.push({ itemId: 't1', type: 'dynamic_tool', text: big, updatedAt: at(1) });
  reads.want([{ threadId: 'a', updatedAt: at(1), itemCount: 2 }]);
  for (let i = 0; i < 8; i++) await settle();
  assert.equal(reads.get('ENG-20')?.status, 'In Progress');
  const pages = calls.filter(([, x]) => (x as { view?: string }).view === 'activity').map(([, x]) => (x as { afterPosition: number }).afterPosition);
  assert.deepEqual(pages, [0, 0]);
  assert.ok(calls.filter(([, x]) => (x as { itemId?: string }).itemId).length >= 3);
});

test('a ticket a thread names in its title or branch is linked, read or "not checked"', async () => {
  const items = { a: [{ itemId: 'm0', type: 'user_message', text: 'x', updatedAt: at(5) }, { itemId: 't1', type: 'dynamic_tool', text: claudeItem('get_issue', { id: 'ENG-12' }, issue('ENG-12')), updatedAt: at(4) }] };
  const reads = createLinearReads({ call: fakeT3(items), now: () => NOW });
  reads.want([{ threadId: 'a', updatedAt: at(4), itemCount: 2 }]);
  for (let i = 0; i < 5; i++) await settle();
  const links = reads.forThreads([{ threadId: 'z', title: 'ENG-12: reply recovery', branch: 't3/eng-647-reply-recovery', updatedAt: at(1) }]);
  assert.deepEqual(links.map((x) => [x.id, x.state]), [['ENG-12', 'read'], ['ENG-647', 'not-checked']]);
  // The unread one gets Linear's address from a read of the same team.
  assert.equal(links[1]!.url, 'https://linear.app/acme/issue/ENG-647');
  // A key no read has shown is no ticket: "PR-12" and "UTF-8" stay text.
  assert.deepEqual(reads.forThreads([{ threadId: 'z', title: 'PR-12 and UTF-8', updatedAt: at(1) }]), []);
});

test('a Linear call still running is read again once it has finished', async () => {
  const running = { itemId: 't1', type: 'dynamic_tool', status: 'running', text: JSON.stringify({ toolName: 'mcp__linear-server__get_issue', input: { id: 'ENG-30' } }, null, 2), updatedAt: at(3) };
  const items: Record<string, { itemId: string; type: string; status?: string; text: string; updatedAt: string }[]> = {
    a: [{ itemId: 'm0', type: 'user_message', text: 'x', updatedAt: at(4) }, running, { itemId: 'm1', type: 'assistant_message', text: 'reading', updatedAt: at(3) }] };
  const reads = createLinearReads({ call: fakeT3(items), now: () => NOW });
  reads.want([{ threadId: 'a', updatedAt: at(3), itemCount: 3 }]);
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(reads.get('ENG-30'), null);
  items.a![1] = { ...running, status: 'completed', text: claudeItem('get_issue', { id: 'ENG-30' }, issue('ENG-30')), updatedAt: at(2) };
  reads.want([{ threadId: 'a', updatedAt: at(2), itemCount: 3 }]);
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(reads.get('ENG-30')?.status, 'In Progress');
});

test('a failed read is tried again, a long thread is read to its end, and a status keeps its own age', async () => {
  const items: Record<string, { itemId: string; type: string; text: string; updatedAt: string }[]> = { a: [{ itemId: 'm0', type: 'user_message', text: 'x', updatedAt: at(9) }] };
  for (let i = 1; i <= 5; i++) items.a!.push({ itemId: `u${i}`, type: 'user_message', text: 'x', updatedAt: at(9) });
  items.a!.push({ itemId: 't1', type: 'dynamic_tool', text: claudeItem('get_issue', { id: 'ENG-40' }, issue('ENG-40')), updatedAt: at(8) });
  // A later read of the same ticket with no status: the status keeps its first read's time.
  items.a!.push({ itemId: 't2', type: 'dynamic_tool', text: claudeItem('get_issue', { id: 'ENG-40' }, { id: 'ENG-40', title: 'Renamed' }), updatedAt: at(2) });
  const base = fakeT3(items);
  let fail = true;
  const reads = createLinearReads({ call: async (name, args = {}) => {
    if (fail && !args.itemId) { fail = false; throw new Error('T3 is restarting'); }
    // Two items a page and a page budget of one: the thread takes several reads.
    return base(name, args.itemId ? args : { ...args, limit: 2 });
  }, now: () => NOW, pages: 1 });
  const thread = { threadId: 'a', updatedAt: at(2), itemCount: 8 };
  reads.want([thread]);
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(reads.get('ENG-40'), null);
  // Same stamp: only the failure makes it read again, and it then reads on to the end by itself.
  reads.want([thread]);
  for (let i = 0; i < 40; i++) await settle();
  const got = reads.get('ENG-40');
  assert.equal(got?.title, 'Renamed');
  assert.equal(got?.status, 'In Progress');
  assert.equal(got?.at, Date.parse(at(8)));
});

test('a thread untouched for a week is not read back from its start', async () => {
  const calls: unknown[][] = [];
  const reads = createLinearReads({ call: fakeT3({ old: [] }, calls), now: () => NOW });
  reads.want([{ threadId: 'old', updatedAt: at(8 * 24 * 60), itemCount: 900 }]);
  await settle();
  assert.equal(calls.length, 0);
});
