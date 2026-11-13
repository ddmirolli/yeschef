// A lead's call on a teammate's ticket, both ways (team-acts.ts outgoing, team-inbox.ts incoming). Run: vp test run team-acts.test.ts, in client/
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { outgoing } from './team-acts.ts';
import { incoming } from './team-inbox.ts';
import type { Board } from './board.ts';

const base = { to: 'm-ada', thread: 'th-1', nonce: 'n-1' };

test('outgoing: each button becomes the action the relay carries, or a refusal before anything leaves', () => {
  assert.deepEqual(outgoing({ ...base, act: 'reply', note: ' Hi ' }), { to: 'm-ada', action: { kind: 'reply', thread: 'th-1', note: 'Hi' } });
  assert.deepEqual(outgoing({ ...base, act: 'refire', note: 'Fix it' }), { to: 'm-ada', action: { kind: 'refire', thread: 'th-1', note: 'Fix it' } });
  // Rebase needs Reply and Roll back needs Merge (roles.ts), so they travel as those, with the reader's words first.
  assert.deepEqual(outgoing({ ...base, act: 'rebase', say: 'Rebase on #12.' }), { to: 'm-ada', action: { kind: 'reply', thread: 'th-1', note: 'Rebase on #12.' } });
  assert.deepEqual(outgoing({ ...base, act: 'rollback', say: 'Roll back #431.', note: 'Now.' }), { to: 'm-ada', action: { kind: 'refire', thread: 'th-1', note: 'Roll back #431.\n\nNow.' } });
  assert.deepEqual(outgoing({ ...base, act: 'answer', 'c:0': 'b', q: 'Which?' }), { to: 'm-ada', action: { kind: 'answer', thread: 'th-1', pick: 'b', q: 'Which?' } });
  assert.deepEqual(outgoing({ ...base, act: 'hold' }), { to: 'm-ada', action: { kind: 'hold', thread: 'th-1' } });
  // Refused on this Mac: nothing goes.
  assert.equal((outgoing({ ...base, act: 'reply' }) as { status: number }).status, 400);
  assert.equal((outgoing({ ...base, act: 'refire' }) as { status: number }).status, 400);
  assert.equal((outgoing({ ...base, act: 'hold', note: 'x' }) as { status: number }).status, 400);
  assert.equal((outgoing({ ...base, act: 'answer' }) as { status: number }).status, 400);
  assert.equal((outgoing({ ...base, act: 'rebase' }) as { status: number }).status, 409);
  assert.equal((outgoing({ ...base, act: 'settle' }) as { status: number }).status, 400);
  assert.equal((outgoing({ act: 'reply', note: 'x', to: 'm-ada' }) as { status: number }).status, 409);
});

// A dev's board with two tickets: one stopped on a T3 question, one handing back a call with letters.
const board = {
  tickets: [
    { thread: { threadId: 'th-q', updatedAt: '2026-11-13T10:00:00Z' }, call: null,
      asks: [{ thread: { threadId: 'th-q' }, items: [{ id: 'q1', requestId: 'r1', question: 'Which database?', options: [{ label: 'Postgres', description: 'The one we run' }, { label: 'SQLite' }] }] }] },
    { thread: { threadId: 'th-c', updatedAt: '2026-11-13T10:00:00Z' }, asks: [],
      call: { key: 'call-1', calls: [{ question: 'Ship it?', recommend: 'a', options: [{ letter: 'a', text: 'Yes' }, { letter: 'b', text: 'No' }] }] } },
  ],
} as unknown as Board;

test('incoming: Reply and Hold run as they are; Request changes goes as a message', () => {
  assert.deepEqual(incoming(board, { kind: 'reply', thread: 'th-c', note: 'x' }), { kind: 'reply', thread: 'th-c', note: 'x' });
  assert.deepEqual(incoming(board, { kind: 'hold', thread: 'th-c' }), { kind: 'hold', thread: 'th-c' });
  assert.deepEqual(incoming(board, { kind: 'refire', thread: 'th-c', note: 'Fix it', nonce: 'n' }), { kind: 'reply', thread: 'th-c', note: 'Request changes. Fix it', nonce: 'n' });
  assert.equal((incoming(board, { kind: 'go', thread: 'th-c' }) as { status: number }).status, 400);
});

test('incoming: an answer finds the same question and option on the dev\'s board, else it is refused', () => {
  // A T3 question: the option by its place, sent with the request id, as the dev's own answer form does.
  assert.deepEqual(incoming(board, { kind: 'answer', thread: 'th-q', q: 'Which database?', pick: 'SQLite', nonce: 'n' }),
    { kind: 'answer', thread: 'th-q', request: 'r1', 'q:q1': 'SQLite', nonce: 'n' });
  // A hand-back call: the letter.
  assert.deepEqual(incoming(board, { kind: 'answer', thread: 'th-c', q: 'Ship it?', pick: 'b', nonce: 'n' }),
    { kind: 'call', thread: 'th-c', call: 'call-1', 'c:0': 'b', nonce: 'n' });
  // The question changed since the lead looked, the option is gone, or nothing waits: refused, nothing runs.
  assert.match(String((incoming(board, { kind: 'answer', thread: 'th-c', q: 'Ship it now?', pick: 'a' }) as { text: string }).text), /something new/);
  assert.match(String((incoming(board, { kind: 'answer', thread: 'th-c', q: 'Ship it?', pick: 'z' }) as { text: string }).text), /not on the question/);
  assert.equal((incoming(board, { kind: 'answer', thread: 'th-none', q: 'x', pick: 'a' }) as { status: number }).status, 409);
  // A T3 answer takes no note: refused, never dropped.
  assert.equal((incoming(board, { kind: 'answer', thread: 'th-q', q: 'Which database?', pick: 'SQLite', note: 'hm' }) as { status: number }).status, 400);
});
