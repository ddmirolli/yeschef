// Acting at the Pass: who may act, and what each action sends to T3. Run: vp test run actions.test.ts, in client/
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refuse, peerPids, peerIsLocal } from './guard.ts';
import { act, tomorrowMorning } from './actions.ts';
import { brief } from './kitchen.ts';
import { buildBoard, renderApp } from './board.ts';
import type { Board, Ticket } from './board.ts';
import type { QuestionItem, ThreadRow } from './contracts.ts';

const dir = mkdtempSync(join(tmpdir(), 'pass-test-'));
const allow = join(dir, 'pass.allow');
writeFileSync(allow, 'login dan@example.com\ndevice 100.1.1.1\n');
const ORIGIN = 'https://pass.example:8620';
const ok = { 'tailscale-user-login': 'dan@example.com', 'x-forwarded-for': '100.1.1.1', origin: ORIGIN };
const remote = async () => false, local = async () => true;

test('only Dan, through the tailnet, from an allowed device, on the Pass page, may act', async () => {
  const r = (headers: Record<string, string>, peerCheck = remote) => refuse({ headers, peerPort: 1, serverPort: 2, origin: ORIGIN, allowPath: allow, peerCheck });
  assert.equal(await r(ok), null);
  assert.match(String(await r(ok, local)), /process on this Mac/);
  assert.match(String(await r({ ...ok, 'tailscale-user-login': 'else@example.com' })), /allowed device/);
  assert.match(String(await r({ ...ok, 'x-forwarded-for': '100.9.9.9' })), /allowed device/);
  assert.match(String(await r({ ...ok, origin: 'https://evil.example' })), /Pass page/);
  assert.match(String(await refuse({ headers: ok, peerPort: 1, serverPort: 2, origin: ORIGIN, allowPath: join(dir, 'none'), peerCheck: remote })), /allowed device/);
});

// Rows in the shape of `netstat -anv -p tcp` on macOS (from the old Python pass's tests).
const NETSTAT = [
  'tcp4       0      0  127.0.0.1.54140        127.0.0.1.8620         ESTABLISHED            0          585  408300  146988 io.tailscale.ipn:96714  00182 00000008 0000000003aa6fc7 00000080 04000900      2      0 000000',
  'tcp4       0      0  127.0.0.1.54150        127.0.0.1.8620         ESTABLISHED            0          585  408300  146988 Google Chrome He:1349  00102 00000008 0000000003aa6fc7 00000080 04000900      2      0 000000',
].join('\n');

test('the peer check: only another user\'s process passes; it fails closed', async () => {
  assert.deepEqual([...peerPids(NETSTAT, 54150, 8620)], [1349]);
  const procs: Record<number, { uid: number; comm: string }> = { 96714: { uid: 0, comm: '/Library/SystemExtensions/X/io.tailscale.ipn.macsys.network-extension.systemextension/Contents/MacOS/io.tailscale.ipn.macsys.network-extension' }, 1349: { uid: 501, comm: 'Google Chrome Helper' } };
  const proc = async (p: number) => procs[p] ?? null;
  assert.equal(await peerIsLocal(54140, 8620, { table: NETSTAT, proc, me: 501 }), false);  // Tailscale, as root
  assert.equal(await peerIsLocal(54150, 8620, { table: NETSTAT, proc, me: 501 }), true);   // this user's browser or agent
  assert.equal(await peerIsLocal(59999, 8620, { table: NETSTAT, proc, me: 501 }), true);   // no row
  assert.equal(await peerIsLocal(54140, 8620, { table: NETSTAT, proc: async () => null, me: 501 }), true);  // exited
  // Another local user or service is not Tailscale, whatever its uid (PR-Agent r1 on #12).
  assert.equal(await peerIsLocal(54140, 8620, { table: NETSTAT, proc: async () => ({ uid: 502, comm: '/usr/local/bin/forge' }), me: 501 }), true);
  // Tailscale's updater runs as root and names Tailscale, but it is not the network extension.
  assert.equal(await peerIsLocal(54140, 8620, { table: NETSTAT, proc: async () => ({ uid: 0, comm: '/Applications/Tailscale.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate' }), me: 501 }), true);
  assert.equal(await peerIsLocal(54140, 8620, { table: NETSTAT, proc: async () => ({ uid: 0, comm: '/usr/local/bin/tailscaled' }), me: 501 }), false);
});

const T = (id: string, extra: Partial<ThreadRow> = {}): ThreadRow => ({ threadId: id, title: id, projectId: 'p', status: 'completed', latestRunId: 'r', updatedAt: '2026-11-06T12:00:00Z', pullRequests: [], ...extra });
const q: QuestionItem = { id: 'q1', requestId: 'r1', question: 'Which letter?', options: [{ label: 'a', description: '' }, { label: 'b', description: '' }] };
const board = () => buildBoard({ projects: [], questions: new Map([['asker', [q]]]), threads: [
  T('turn', { pullRequests: [{ repository: 'o/r', number: 1, state: 'open' }] }), T('busy', { status: 'running' }),
  T('asker', { status: 'waiting' }), T('ATC 11-06')] });
/** A T3 caller that keeps each call and answers {}. sent(i): the i-th call's arguments. */
const spy = () => {
  const calls: [name: string, args: Record<string, unknown> | undefined][] = [];
  return { calls, call: async (name: string, args?: Record<string, unknown>) => { calls.push([name, args]); return {}; },
    sent: (i: number): Record<string, unknown> => calls[i]?.[1] ?? {} };
};
/** The one ticket a test reads, which must be there. */
const only = (tickets: Ticket[]): Ticket => { const k = tickets[0]; assert.ok(k); return k; };
/** A board with no tickets: a launch needs none. */
const EMPTY: Board = { tickets: [], runsChecked: false };

test('Merge and Request changes go to a ticket that waits on Dan, as queued messages that say they are from Dan', async () => {
  const t3 = spy();
  // The form values stay "go" and "refire" (saved drafts carry them); the words are the developer ones (Dan, 2026-11-10).
  const go = await act({ board: board(), t3, input: { kind: 'go', thread: 'turn', nonce: 'n1' } });
  const fix = await act({ board: board(), t3, input: { kind: 'refire', thread: 'turn', nonce: 'n2', note: 'Cut it to two lines.' } });
  assert.deepEqual([go.status, go.text, fix.status, fix.text], [200, 'Sent: Merge.', 200, 'Sent: Request changes, with your note.']);
  assert.deepEqual(t3.calls, [
    ['t3_thread_send', { threadId: 'turn', message: 'Dan, from the Pass: Merge it.', mode: 'queue', clientRequestId: 'pass-n1' }],
    ['t3_thread_send', { threadId: 'turn', message: 'Dan, from the Pass: Request changes. Cut it to two lines.', mode: 'queue', clientRequestId: 'pass-n2' }]]);
});

test('with no open pull request there is nothing to merge: the button is Approve, with A, and the agent goes ahead (Pass call 1a)', async () => {
  const b = buildBoard({ projects: [], questions: new Map(), threads: [T('plan')] });
  assert.equal(only(b.tickets).place, 'Planned');
  const html = renderApp({ board: b, link: (t: ThreadRow) => `https://t3/${t.threadId}`, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  // Approve is the blue recommended action (Dan, 2026-11-10): A, or Cmd+Enter, named in its tooltip. A comes first: the
  // page script reads it to tell Approve from Merge.
  assert.match(html, /value="go" class="ab fill primary" data-toast="Approving \{t\}" data-what="Approve: the agent goes ahead"><svg[^>]*>[\s\S]*?<\/svg><span class="bl">Approve<\/span><span class="tip" aria-hidden="true"><span class="tn">Approve: the agent goes ahead<\/span><kbd data-cmd="ticket.approve">A<\/kbd><span class="or">or<\/span><kbd data-cmd="ticket.suggested">⌘↵<\/kbd><\/span><\/button>/);
  assert.match(html, /<input type="hidden" name="pr" value="none">/);
  // Call 1a: the button says Changes; the tooltip keeps the full name and its key.
  assert.match(html, /value="refire" class="ab" data-toast="Requesting changes on \{t\}"[^>]*><svg[^>]*>[\s\S]*?<\/svg><span class="bl">Changes<\/span><span class="tip" aria-hidden="true"><span class="tn">Request changes: say what to fix<\/span><kbd data-cmd="ticket.requestChanges">F<\/kbd><\/span>/);
  assert.doesNotMatch(html, />Go<|<kbd[^>]*>G<\/kbd>|>Merge</);
  const t3 = spy();
  const out = await act({ board: b, t3, input: { kind: 'go', thread: 'plan', nonce: 'n', pr: 'none' } });
  assert.deepEqual([out.status, out.text, t3.sent(0).message], [200, 'Sent: Approve.', 'Dan, from the Pass: Approved. Go ahead.']);
});

test('Merge and Approve send only what the lead saw: a pull request that opened or closed since then waits for a fresh look', async () => {
  const b = buildBoard({ projects: [], questions: new Map(), threads: [T('plan'), T('turn', { pullRequests: [{ repository: 'o/r', number: 1, state: 'open' }] })] });
  const t3 = spy();
  // The page showed Merge, then the pull request closed: Approve is not what the lead chose.
  const closed = await act({ board: b, t3, input: { kind: 'go', thread: 'plan', nonce: 'n1', pr: 'open' } });
  // The page showed Approve, then a pull request opened: Merge is not what the lead chose.
  const opened = await act({ board: b, t3, input: { kind: 'go', thread: 'turn', nonce: 'n2', pr: 'none' } });
  assert.deepEqual([closed.status, closed.text, opened.status, opened.text],
    [409, 'The pull request is no longer open. Look again before you act.', 409, 'A pull request opened since you looked. Review it, then merge.']);
  assert.equal(t3.calls.length, 0);
  // A page from before the field sends no "pr": it goes by the board, as it did (old pages and saved drafts keep working).
  const oldPlan = await act({ board: b, t3, input: { kind: 'go', thread: 'plan', nonce: 'n3' } });
  const oldTurn = await act({ board: b, t3, input: { kind: 'go', thread: 'turn', nonce: 'n4' } });
  assert.deepEqual([oldPlan.text, oldTurn.text], ['Sent: Approve.', 'Sent: Merge.']);
  assert.deepEqual(t3.calls.map((c) => c[1]?.message), ['Dan, from the Pass: Approved. Go ahead.', 'Dan, from the Pass: Merge it.']);
  // The ticket with a pull request says so in its form.
  const html = renderApp({ board: b, link: (t: ThreadRow) => `https://t3/${t.threadId}`, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  const turnForm = html.slice(html.indexOf('name="thread" value="turn"'), html.indexOf('</form>', html.indexOf('name="thread" value="turn"')));
  assert.match(turnForm, /<input type="hidden" name="pr" value="open">/);
});

test('an open pull request shows Merge with M, and Request changes with F', () => {
  const html = renderApp({ board: board(), link: (t: ThreadRow) => `https://t3/${t.threadId}`, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  const turnPlate = html.slice(html.indexOf('value="turn"'), html.indexOf('</form>', html.indexOf('value="turn"')));
  assert.match(turnPlate, /value="go" class="ab fill primary" data-toast="Merging \{t\}" data-what="Merge: the agent merges it"><svg[^>]*>[\s\S]*?<\/svg><span class="bl">Merge<\/span><span class="tip" aria-hidden="true"><span class="tn">Merge: the agent merges it<\/span><kbd data-cmd="ticket.merge">M<\/kbd><span class="or">or<\/span><kbd data-cmd="ticket.suggested">⌘↵<\/kbd>/);
  assert.match(turnPlate, /<span class="bl">Changes<\/span><span class="tip" aria-hidden="true"><span class="tn">Request changes: say what to fix<\/span><kbd data-cmd="ticket.requestChanges">F<\/kbd>/);
  assert.match(turnPlate, /needed for Request changes and Reply/);
  assert.match(html, /Review the pull request, then merge or request changes\./);
  assert.doesNotMatch(html, /Refire|>Go</);
});

test('the action bar: the blue action, Changes and Reply, then Hold and Settle as icons, then More (Dan, 2026-11-10)', () => {
  const html = renderApp({ board: board(), link: (t: ThreadRow) => `https://t3/${t.threadId}`, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  const at = html.indexOf('name="thread" value="turn"'), turn = html.slice(at, html.indexOf('</form>', at));
  // One blue button, and it is the first: Merge, with M or Cmd+Enter in its tooltip.
  assert.equal((turn.match(/class="ab fill primary"/g) || []).length, 1);
  const bar = turn.slice(turn.indexOf('<div class="abar">'));
  assert.match(bar, /^<div class="abar"><button type="submit" name="kind" value="go" class="ab fill primary"/);
  // The row, in order: the labelled buttons, a thin divider, Hold and Settle as icons with their names, then More.
  const order = [...bar.matchAll(/value="(\w+)" class="(ab|ib)[^"]*"|class="vr"|data-more/g)].map((m) => m[1] ? `${m[1]}:${m[2]}` : m[0]);
  assert.deepEqual(order, ['go:ab', 'refire:ab', 'reply:ab', 'class="vr"', 'hold:ib', 'settle:ib', 'data-more']);
  assert.match(bar, /value="hold" class="ib"[^>]* aria-label="Hold until 8:00 tomorrow"/);
  assert.match(bar, /value="settle" class="ib"[^>]* aria-label="Settle: it leaves the pass"/);
  // Keys live in tooltips only: none sits on the bar outside one.
  assert.doesNotMatch(bar.replace(/<span class="tip"[\s\S]*?<\/span><\/button>/g, '</button>').replace(/<div class="menu"[\s\S]*$/, ''), /<kbd[\s>]/);
  // More: "." in its tooltip, a popover menu with Add a note (N) and Open in T3 (O). On a phone it also holds Hold and
  // Settle, which press the bar's own buttons (data-press), so every check still runs.
  const id = bar.match(/data-more popovertarget="(m-[0-9a-f-]{36})"/)?.[1];
  assert.match(bar, /<span class="tn">More<\/span><kbd data-cmd="ticket.more">\.<\/kbd>/);
  const menu = bar.slice(bar.indexOf(`<div class="menu" id="${id}" popover role="menu"`));
  assert.ok(menu.length < bar.length, 'the menu follows its button');
  assert.deepEqual([...menu.matchAll(/data-press="(\w+)"/g)].map((m) => m[1]), ['hold', 'settle']);
  // A narrow ticket in a wide window moves them into More too, and there the card shows their keys.
  assert.match(menu, /data-press="hold">[\s\S]*?<span>Hold until 8:00 tomorrow<\/span><kbd data-cmd="ticket.hold">H<\/kbd><\/button>/);
  assert.match(menu, /data-press="settle">[\s\S]*?<span>Settle<\/span><kbd data-cmd="ticket.settle">E<\/kbd><\/button>/);
  assert.match(menu, /data-addnote>[\s\S]*?<span>Add a note<\/span><kbd data-cmd="ticket.addNote">N<\/kbd><\/button>/);
  assert.match(menu, /data-open-t3>[\s\S]*?<span>Open in T3<\/span><kbd data-cmd="ticket.open">O<\/kbd><\/button>/);
  assert.match(menu, new RegExp(`popovertarget="${id}" popovertargetaction="hide">Cancel</button>`));
  // A question: Send is blue, Hold and Settle wait, and More says why.
  const q = html.slice(html.indexOf('name="request" value="r1"'), html.indexOf('</form>', html.indexOf('name="request" value="r1"')));
  assert.match(q, /value="answer" class="ab fill primary"[^>]*><svg[^>]*>[\s\S]*?<\/svg><span class="bl">Send answer<\/span><span class="tip" aria-hidden="true"><span class="tn">Send your answer<\/span><kbd data-cmd="ticket.suggested">⌘↵<\/kbd>/);
  assert.doesNotMatch(q, /value="(go|hold|settle)"|data-press/);
  assert.match(q, /Hold and Settle come back once the question is answered\./);
});

test('actions are refused without a note, off the board, on coordinators, or for a ticket not waiting', async () => {
  const t3 = spy();
  assert.equal((await act({ board: board(), t3, input: { kind: 'refire', thread: 'turn', nonce: 'n' } })).status, 400);
  assert.equal((await act({ board: board(), t3, input: { kind: 'reply', thread: 'turn', nonce: 'n' } })).status, 400);
  assert.equal((await act({ board: board(), t3, input: { kind: 'go', thread: 'nope', nonce: 'n' } })).status, 409);
  assert.equal((await act({ board: board(), t3, input: { kind: 'go', thread: 'ATC 11-06', nonce: 'n' } })).status, 409);
  assert.equal((await act({ board: board(), t3, input: { kind: 'go', thread: 'busy', nonce: 'n' } })).status, 409);
  assert.equal((await act({ board: board(), t3, input: { kind: 'merge', thread: 'turn', nonce: 'n' } })).status, 400);
  assert.equal((await act({ board: board(), t3, input: { kind: 'go', thread: 'turn' } })).status, 400);
  assert.deepEqual(t3.calls, []);
});

test('an answer must match a waiting question and one of its options', async () => {
  const t3 = spy();
  assert.equal((await act({ board: board(), t3, input: { kind: 'answer', thread: 'asker', request: 'r1', 'q:q1': 'c', nonce: 'n' } })).status, 400);
  assert.equal((await act({ board: board(), t3, input: { kind: 'answer', thread: 'asker', request: 'r9', 'q:q1': 'a', nonce: 'n' } })).status, 409);
  assert.equal((await act({ board: board(), t3, input: { kind: 'answer', thread: 'asker', request: 'r1', 'q:q1': 'a', nonce: 'n' } })).status, 200);
  assert.deepEqual(t3.calls, [['t3_pending_request', { action: 'respond', threadId: 'asker', requestId: 'r1', answers: { q1: 'a' } }]]);
});

test('an option with spaces in its label still matches, and sends its value', async () => {
  const sq = { id: 'q2', requestId: 'r2', question: 'Pick', options: [{ label: ' a ', value: 'A', description: '' }] };
  const b = buildBoard({ projects: [], questions: new Map([['asker', [sq]]]), threads: [T('asker', { status: 'waiting' })] });
  const t3 = spy();
  assert.equal((await act({ board: b, t3, input: { kind: 'answer', thread: 'asker', request: 'r2', 'q:q2': ' a ', nonce: 'n' } })).status, 200);
  assert.deepEqual(t3.sent(0).answers, { q2: 'A' });
});

test('a finished Merged ticket offers Settle first, filled, and no Merge; the server refuses it there too', async () => {
  const b = buildBoard({ projects: [], questions: new Map(), threads: [T('done', { pullRequests: [{ repository: 'o/r', number: 2, state: 'merged' }] })] });
  assert.equal(only(b.tickets).place, 'Merged');
  assert.equal(only(b.tickets).atPass, true);
  const html = renderApp({ board: b, link: (t: ThreadRow) => `https://t3/${t.threadId}`, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  const foot = html.slice(html.indexOf('<aside class="dock'));
  const acts = foot.slice(foot.indexOf('<div class="abar">'), foot.indexOf('<div class="menu"', foot.indexOf('<div class="abar">')));
  assert.match(acts, /^<div class="abar"><button type="submit" name="kind" value="settle" class="ab fill primary"[^>]*><svg[^>]*>[\s\S]*?<\/svg><span class="bl">Settle<\/span><span class="tip" aria-hidden="true"><span class="tn">Settle: it moves to Verified<\/span><kbd data-cmd="ticket.settle">E<\/kbd><span class="or">or<\/span><kbd data-cmd="ticket.suggested">⌘↵<\/kbd>/);
  assert.doesNotMatch(acts, /value="go"/);
  assert.match(acts, /value="refire"/);
  // Settled once is enough: no second Settle in the row, and none in the phone's More sheet.
  assert.equal(acts.match(/value="settle"/g)?.length, 1);
  assert.doesNotMatch(foot.slice(0, foot.indexOf('</form>')), /data-press="settle"/);
  assert.match(html, /Try it where it shipped\. If it works, settle it\./);
  // The hand-back says what it asks under the title, before the pull requests (hill climb 2 r2, Astra).
  const plate = html.slice(html.indexOf('<article class="plate"'));
  // No pill on a hand-back: the blue pill means a decision waits on you (Dan, 2026-11-08).
  assert.match(plate, /<p class="lead"><span class="lead-q">Try it where it shipped\. If it works, settle it\.<\/span><\/p>/);
  // Only the title pins; the ask and the pull requests scroll with the message (Dan, 2026-11-14, Gmail).
  assert.match(plate, /<header class="plate-head"><h2 class="plate-t"[^>]*>done<\/h2><\/header><p class="lead">[\s\S]*?<div class="pr-row">[\s\S]*?<section class="msg">/);
  assert.ok(plate.indexOf('class="lead"') < plate.indexOf('class="pr-row"'));
  const t3 = spy();
  assert.equal((await act({ board: b, t3, input: { kind: 'go', thread: 'done', nonce: 'n' } })).status, 409);
  const out = await act({ board: b, t3, input: { kind: 'settle', thread: 'done', nonce: 'n' } });
  assert.deepEqual([out.status, out.text], [200, 'Settled. It moves to Verified.']);
  assert.deepEqual(t3.calls, [['t3_thread_organize', { action: 'settle', threadId: 'done' }]]);
});

test('Hold snoozes until 8:00 tomorrow; Settle settles', async () => {
  const t3 = spy(), now = new Date(2026, 10, 6, 15, 0);
  await act({ board: board(), t3, now, input: { kind: 'hold', thread: 'busy', nonce: 'n' } });
  await act({ board: board(), t3, input: { kind: 'settle', thread: 'turn', nonce: 'n' } });
  assert.deepEqual(t3.calls, [['t3_thread_organize', { action: 'snooze', threadId: 'busy', snoozedUntil: new Date(2026, 10, 7, 8, 0).toISOString() }],
    ['t3_thread_organize', { action: 'settle', threadId: 'turn' }]]);
  assert.equal(tomorrowMorning(now), new Date(2026, 10, 7, 8, 0).toISOString());
});

test('a retried Hold keeps its first time, even after midnight', async () => {
  const t3 = spy(), holds = new Map<string, string>();
  await act({ board: board(), t3, holds, now: new Date(2026, 10, 6, 23, 59), input: { kind: 'hold', thread: 'busy', nonce: 'h1' } });
  await act({ board: board(), t3, holds, now: new Date(2026, 10, 7, 0, 1), input: { kind: 'hold', thread: 'busy', nonce: 'h1' } });
  const until = new Date(2026, 10, 7, 8, 0).toISOString();
  assert.deepEqual(t3.calls.map(([, a]) => a?.snoozedUntil), [until, until]);
});

test('the open ticket carries the forms: answers for questions, Merge and Request changes only when it waits on Dan', () => {
  const html = renderApp({ board: board(), link: (t: ThreadRow) => `https://t3/${t.threadId}`, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /<input type="radio" name="q:q1" value="a" data-key="a" data-need>/);
  assert.match(html, /name="request" value="r1"/);
  const busyPlate = html.slice(html.indexOf('value="busy"'), html.indexOf('</form>', html.indexOf('value="busy"')));
  assert.doesNotMatch(busyPlate, /value="go"/);
  assert.match(busyPlate, /value="hold"/);
  const turnPlate = html.slice(html.indexOf('value="turn"'), html.indexOf('</form>', html.indexOf('value="turn"')));
  assert.match(turnPlate, /value="go"/);
  assert.match(turnPlate, /value="refire"/);
});

test('a thread waiting on a question reads "running" in T3: it is at the pass, not working, and only Reply stays', async () => {
  const b = buildBoard({ projects: [], questions: new Map([['live', [q]]]), threads: [T('live', { status: 'running' })] });
  assert.equal(only(b.tickets).working, 0);
  assert.equal(only(b.tickets).atPass, true);
  const t3 = spy();
  assert.equal((await act({ board: b, t3, input: { kind: 'hold', thread: 'live', nonce: 'n' } })).status, 409);
  assert.equal((await act({ board: b, t3, input: { kind: 'reply', thread: 'live', note: 'later', nonce: 'n' } })).status, 200);
  const html = renderApp({ board: b, link: (t: ThreadRow) => `https://t3/${t.threadId}`, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  const form = html.slice(html.indexOf('<aside class="dock'));
  assert.ok(form.includes('value="answer"'));
  assert.doesNotMatch(form.slice(0, form.indexOf('</form>')), /value="(go|hold|settle)"|data-press=/);
});

test('a launch goes only into a project T3 lists, with the prompt, in a new worktree unless the checkout is chosen', async () => {
  const projects = [{ id: 'p1', title: 'Yes Chef' }];
  const empty = EMPTY;
  const t3 = spy();
  let r = await act({ board: empty, t3, projects, input: { kind: 'launch', nonce: 'l1', project: 'nope', prompt: 'x' } });
  assert.equal(r.status, 400);
  r = await act({ board: empty, t3, projects, input: { kind: 'launch', nonce: 'l1', project: 'p1', prompt: '   ' } });
  assert.equal(r.status, 400);
  assert.equal(t3.calls.length, 0);
  const off = { all: { screens: 'off', form: 'any', council: 'agent' } };
  r = await act({ board: empty, t3, projects, rules: off, input: { kind: 'launch', nonce: 'l1', project: 'p1', prompt: 'Fix the toast font.\nThen open a PR.' } });
  assert.equal(r.status, 200);
  assert.deepEqual(t3.calls[0], ['t3_thread_launch', { projectId: 'p1', title: 'Fix the toast font.', message: 'Fix the toast font.\nThen open a PR.', workspaceStrategy: { type: 'worktree' }, clientRequestId: 'pass-l1' }]);
  await act({ board: empty, t3, projects, input: { kind: 'launch', nonce: 'l2', project: 'p1', prompt: 'Look', title: 'My title', workspace: 'root' } });
  assert.deepEqual(t3.sent(1).workspaceStrategy, { type: 'root' });
  assert.equal(t3.sent(1).title, 'My title');
});

test('Hold and Settle refuse a written note instead of dropping it (council 3, Opus)', async () => {
  for (const kind of ['hold', 'settle']) {
    const t3 = spy();
    const out = await act({ board: board(), t3, input: { kind, thread: 'turn', nonce: 'n', note: 'Please also add a test.' } });
    assert.equal(out.status, 400);
    assert.match(out.text, /note would be lost/);
    assert.deepEqual(t3.calls, []);
  }
});

test('a launch carries the project rules under the prompt (Dan, 2026-11-08)', async () => {
  const projects = [{ id: 'p1', title: 'Yes Chef' }, { id: 'p2', title: 'ReviewWheel' }];
  const rules = { all: { reviewer: 'coderabbit' }, projects: { p1: { reviewer: 'pr-agent' } } };
  const t3 = spy();
  await act({ board: EMPTY, t3, projects, rules, input: { kind: 'launch', nonce: 'k1', project: 'p1', prompt: 'Do it.' } });
  await act({ board: EMPTY, t3, projects, rules, input: { kind: 'launch', nonce: 'k2', project: 'p2', prompt: 'Do it.' } });
  assert.equal(t3.sent(0).message, 'Do it.' + brief(rules, 'p1'));
  assert.match(String(t3.sent(0).message), /PR-Agent is the pull-request reviewer/);
  assert.match(String(t3.sent(1).message), /CodeRabbit is the pull-request reviewer/);
  // A new kitchen's defaults go too: screenshots for visual calls, numbered decisions, council only when asked.
  await act({ board: EMPTY, t3, projects, input: { kind: 'launch', nonce: 'k3', project: 'p2', prompt: 'Do it.' } });
  assert.match(String(t3.sent(2).message), /^Do it\.\n\n---\nRules \(Yes Chef\):\n- A decision about anything I can see/);
});
