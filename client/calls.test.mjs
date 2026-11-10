// Calls and screenshots in an agent's own T3 message: parsing, the ticket sheet, the answer, the image route's checks.
// Run: node --test client/calls.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCalls, recommendLines, imagesIn, imageUrl, callKey, shotPath, isShot } from './calls.mjs';
import { buildBoard, renderApp } from './board.mjs';
import { act } from './actions.mjs';

// A real hand-back from a ReviewWheel build thread (2026-11-02), trimmed: screenshots, links, and a decision.
const REAL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 't3-call-message.md'), 'utf8');

test('a real hand-back: the numbered decision, its options, and the recommendation', () => {
  assert.deepEqual(parseCalls(REAL), [{ question: 'Ship #2151?', recommend: 'a',
    options: [{ letter: 'a', text: 'Yes, merge once CI is green.' }, { letter: 'b', text: 'Change something first (say what).' }] }]);
  assert.deepEqual(imagesIn(REAL), [{ src: '/Users/chef/rw-artifacts/2026-11-02/free-thumbs-dark/free-desktop-dark-after.png', alt: '/free/ in dark mode, after' }]);
});

test('the shapes agents write: bold letters, capitals, parentheses, inline "recommended", several decisions', () => {
  const two = parseCalls('**Decisions for Dan**\n1. Which words?\n   a. Ours\n   b. Theirs\n   c. Refire, with your note\n   Recommend: b.\n2. Delete the old files?\n   a. Yes\n   b. Keep them');
  assert.deepEqual(two.map((c) => [c.question, c.options.length, c.recommend]), [['Which words?', 3, 'b'], ['Delete the old files?', 2, null]]);
  assert.deepEqual(parseCalls('**Your call:** send it out?\n\n**a.** Send it out (recommended)\n**b.** One more build').map((c) => [c.question, c.recommend, c.options[0].text]),
    [['Your call: send it out?', 'a', 'Send it out']]);
  assert.deepEqual(parseCalls('2. Publishing the guide:\n- A. Publish now with no texting claim.\n- B. Wait for the carrier.\n- Recommendation: A.').map((c) => [c.question, c.recommend, c.options.map((o) => o.letter).join('')]),
    [['Publishing the guide', 'a', 'ab']]);
  assert.equal(parseCalls('Which banner?\n(a) Navy\n(b) Azure - recommended')[0].recommend, 'b');
  // An indented line under an option adds to it.
  assert.equal(parseCalls('Ship it?\na. Yes\n   after CI is green\nb. No')[0].options[0].text, 'Yes after CI is green');
});

test('lettered steps and status updates are not calls', () => {
  assert.deepEqual(parseCalls('Steps I took:\na. read the file\nb. fixed it\nAll checks pass.'), []);
  assert.deepEqual(parseCalls('Nothing to act on in this update.\n- **Comments:** none need a reply.'), []);
  assert.deepEqual(parseCalls('Ship it?\na. Yes'), []);           // one option is not a choice
  assert.deepEqual(parseCalls('Ship it?\nb. Yes\nc. No'), []);    // must start at a
});

test('screenshots: Markdown images and image paths in code; folders, relative paths, and http are left alone', () => {
  const t = '![after](/tmp/a.png) ![remote](https://x.example/b.jpg) ![rel](shots/c.png) ![http](http://x.example/d.png)\n'
    + 'Shots: `~/rw-artifacts/e.webp`, folder `/Users/me/rw-artifacts/2026/`, and `/etc/passwd`.';
  assert.deepEqual(imagesIn(t).map((i) => i.src), ['/tmp/a.png', 'https://x.example/b.jpg', '~/rw-artifacts/e.webp']);
  assert.equal(imageUrl('https://x.example/b.jpg'), 'https://x.example/b.jpg');
  assert.match(imageUrl('/tmp/a.png'), /^\/img\/[0-9a-f]{20}$/);
});

const T = (id, extra = {}) => ({ threadId: id, title: id, projectId: 'p', status: 'completed', latestRunId: 'r', updatedAt: '2026-11-06T12:00:00Z', pullRequests: [], ...extra });
const withCall = (text = REAL, extra = {}) => {
  const calls = parseCalls(text);
  return buildBoard({ projects: [{ id: 'p', title: 'P' }], questions: new Map(), threads: [T('ship', { pullRequests: [{ repository: 'o/r', number: 2151, state: 'open' }], ...extra })],
    lastWords: new Map([['ship', { latest: { itemId: 'i2', text: 'Nothing to fix on #2151. Both comments are automated.' }, call: { key: callKey('i1', calls), itemId: 'i1', text, calls } }]]) });
};
const page = (board, answered) => renderApp({ board, project: null, link: (t) => `https://t3.example/env/${t.threadId}`, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example', answered });

test('a call puts the ticket at the pass with a blue pill that counts its questions, in Ready to merge when its PR is open', () => {
  const k = withCall().tickets[0];
  assert.equal(k.place, 'Ready to merge');
  assert.equal(k.atPass, true);
  assert.equal(k.call.calls[0].question, 'Ship #2151?');
  const html = page(withCall());
  // The card's subject is the thread's title; the question is its preview (Dan, 2026-11-08).
  assert.match(html, /<span class="q">ship<\/span><span class="ct-pv">Ship #2151\?<\/span><span class="lbs"><span class="chip c-blue">1 question<\/span>/);
});

test('the sheet shows the screenshots, the links, the choices with the recommendation, and what came since', () => {
  const html = page(withCall());
  assert.match(html, /<a class="att" role="listitem" href="\/img\/[0-9a-f]{20}" data-shot[^>]*><span class="att-img"><img src="\/img\/[0-9a-f]{20}" alt="\/free\/ in dark mode, after"[^>]*><\/span><span class="att-cap">\/free\/ in dark mode, after<\/span>/);
  assert.match(html, /<a href="https:\/\/mac\.example\.ts\.net:8443\/2026-11-02\/free-thumbs-dark\/index\.html" target="_blank"/);
  assert.match(html, /<a href="https:\/\/t3\.example\/5f0c2a1e-4b7d-4c3a-9e21-0d6b8a7c3f10\/mcp:c116042a-bb2b-4208-b853-8b83342a1245"[^>]*>ATC 10-28/);
  assert.match(html, /<button type="submit" name="kind" value="call" class="ab fill primary"/);
  assert.match(html, /name="c:0" value="a" data-key="a" data-need data-rec><span class="opt-t"><b>a\.<\/b> Yes, merge once CI is green\. <span class="rec">Recommended<\/span>/);
  assert.match(html, /<b>Since then<\/b>.*Nothing to fix on #2151/s);
  // The call carries its own choices: no Merge or Request changes beside it. Reply, Hold, and Settle stay.
  assert.doesNotMatch(html, /value="go"|value="refire"/);
  assert.match(html, /value="reply"/);
  assert.doesNotMatch(html, /!\[/);
});

test('agent text stays text: a script tag or a javascript: link in a message is never live', () => {
  const evil = '<script>alert(1)</script>\n[click](javascript:alert(1))\n![x](/tmp/a.png" onerror="alert(1))\nShip it <img src=x onerror=alert(2)>?\na. Yes <b>now</b>\nb. No';
  const html = page(withCall(evil));
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /onerror="alert/);
  assert.doesNotMatch(html, /<img src=x|<b>now<\/b>/);
  assert.match(html, /Ship it &lt;img src=x onerror=alert\(2\)&gt;\?/);
});

test('answering a call: "1a" plus the question, queued to the ticket\'s own thread, once', async () => {
  const sent = [];
  const t3 = { call: async (name, args) => { sent.push([name, args]); return {}; } };
  const board = withCall(), key = board.tickets[0].call.key, answered = new Map();
  const ok = await act({ board, t3, answered, input: { kind: 'call', thread: 'ship', call: key, 'c:0': 'a', note: 'Watch the dark tiles.', nonce: 'n1' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(sent, [['t3_thread_send', { threadId: 'ship', mode: 'queue', clientRequestId: 'pass-n1',
    message: 'Dan, from the Pass: my call.\n1a. Yes, merge once CI is green. (Ship #2151?)\n\nWatch the dark tiles.' }]]);
  // The same send retried passes (T3 drops the repeat by its id); a second, different answer is refused.
  assert.equal((await act({ board, t3, answered, input: { kind: 'call', thread: 'ship', call: key, 'c:0': 'a', note: 'Watch the dark tiles.', nonce: 'n1' } })).status, 200);
  assert.equal((await act({ board, t3, answered, input: { kind: 'call', thread: 'ship', call: key, 'c:0': 'b', nonce: 'n2' } })).status, 409);
  assert.match(page(board, answered), /You answered 1a at/);
});

test('a call answer is refused when stale, empty, off the list, or on a ticket with no call', async () => {
  const t3 = { call: async () => { throw new Error('must not send'); } };
  const board = withCall(), key = board.tickets[0].call.key;
  assert.equal((await act({ board, t3, input: { kind: 'call', thread: 'ship', call: 'old', 'c:0': 'a', nonce: 'n' } })).status, 409);
  assert.equal((await act({ board, t3, input: { kind: 'call', thread: 'ship', call: key, nonce: 'n' } })).status, 400);
  assert.equal((await act({ board, t3, input: { kind: 'call', thread: 'ship', call: key, 'c:0': 'z', nonce: 'n' } })).status, 400);
  const plain = buildBoard({ projects: [], questions: new Map(), threads: [T('t')], lastWords: new Map([['t', 'Done.']]) });
  assert.equal((await act({ board: plain, t3, input: { kind: 'call', thread: 't', call: key, 'c:0': 'a', nonce: 'n' } })).status, 409);
});

test('a settled or still-running thread shows no call', () => {
  assert.equal(withCall(REAL, { settled: true }).tickets[0].call, null);
  assert.equal(withCall(REAL, { status: 'running' }).tickets[0].call, null);
});

test('the image route serves only image files under the allowed folders, with image bytes', () => {
  const home = mkdtempSync(join(tmpdir(), 'pass-home-'));
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  mkdirSync(join(home, 'rw-artifacts'), { recursive: true });
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(join(home, '.t3', 'worktrees', 'w'), { recursive: true });
  writeFileSync(join(home, 'rw-artifacts', 'a.png'), png);
  writeFileSync(join(home, '.ssh', 'k.png'), png);
  writeFileSync(join(home, '.t3', 'worktrees', 'w', 'b.png'), png);
  writeFileSync(join(home, 'rw-artifacts', 'note.txt'), 'hi');
  symlinkSync('/etc/hosts', join(home, 'rw-artifacts', 'link.png'));
  const opts = { home, roots: [shotPath(home + '/rw-artifacts/a.png', { home, roots: ['/'] }).replace(/\/rw-artifacts\/a\.png$/, '')] };
  assert.ok(shotPath(join(home, 'rw-artifacts', 'a.png'), opts));
  assert.ok(shotPath('~/rw-artifacts/a.png', opts));
  assert.ok(shotPath(join(home, '.t3', 'worktrees', 'w', 'b.png'), opts));
  assert.equal(shotPath(join(home, '.ssh', 'k.png'), opts), null);
  assert.equal(shotPath(join(home, 'rw-artifacts', 'note.txt'), opts), null);
  assert.equal(shotPath(join(home, 'rw-artifacts', 'link.png'), opts), null);   // a link out of the folders
  assert.equal(shotPath(join(home, 'rw-artifacts', '..', '..', 'etc', 'x.png'), opts), null);
  assert.equal(shotPath('/etc/hosts', opts), null);
  assert.equal(isShot(png), true);
  assert.equal(isShot(Buffer.from('<svg onload=alert(1)>')), false);
});

test('PR-Agent r1 on #17: "not recommended" never takes the pill or loses a word', () => {
  const c = parseCalls('Ship it?\na. Wait for CI (recommended)\nb. Skip CI, not recommended')[0];
  assert.equal(c.recommend, 'a');
  assert.equal(c.options[1].text, 'Skip CI, not recommended');
});

test('PR-Agent r1 on #17: two tabs, a changed retry, and a failed send never put two answers in the thread', async () => {
  const sent = [];
  let release;
  const slow = { call: (name, args) => { sent.push(args.message); return new Promise((r) => { release = r; }); } };
  const board = withCall(), key = board.tickets[0].call.key, answered = new Map();
  const first = act({ board, t3: slow, answered, input: { kind: 'call', thread: 'ship', call: key, 'c:0': 'a', nonce: 'tab1' } });
  // The second tab arrives while the first send is still in flight.
  assert.equal((await act({ board, t3: slow, answered, input: { kind: 'call', thread: 'ship', call: key, 'c:0': 'b', nonce: 'tab2' } })).status, 409);
  release({});
  assert.equal((await first).status, 200);
  // A retry under the same id with a different choice is refused, and the record keeps the first answer.
  assert.equal((await act({ board, t3: slow, answered, input: { kind: 'call', thread: 'ship', call: key, 'c:0': 'b', nonce: 'tab1' } })).status, 409);
  assert.equal(answered.get(key).picks, '1a');
  assert.equal(sent.length, 1);
  // A send that fails may still have reached T3: a fresh answer is refused; the same retry is allowed.
  const answered2 = new Map(), boom = { call: async () => { throw new Error('T3 timed out'); } };
  await assert.rejects(act({ board, t3: boom, answered: answered2, input: { kind: 'call', thread: 'ship', call: key, 'c:0': 'a', nonce: 'x1' } }));
  assert.equal((await act({ board, t3: boom, answered: answered2, input: { kind: 'call', thread: 'ship', call: key, 'c:0': 'b', nonce: 'x2' } })).status, 409);
  await assert.rejects(act({ board, t3: boom, answered: answered2, input: { kind: 'call', thread: 'ship', call: key, 'c:0': 'a', nonce: 'x1' } }));
});

test('PR-Agent r1 on #17: a call with a station still running is not Ready to merge and shows no call', () => {
  const calls = parseCalls(REAL);
  const b = buildBoard({ projects: [], questions: new Map(), threads: [T('ship', { pullRequests: [{ repository: 'o/r', number: 1, state: 'open' }] }), T('kid', { parentThreadId: 'ship', status: 'running' })],
    lastWords: new Map([['ship', { latest: { itemId: 'i1', text: REAL }, call: { key: callKey('i1', calls), itemId: 'i1', text: REAL, calls } }]]) });
  assert.equal(b.tickets[0].place, 'In progress');
  assert.equal(b.tickets[0].call, null);
});

test('PR-Agent r2 on #17: a lettered list of steps never borrows the next section\'s decision heading', () => {
  const calls = parseCalls('Steps I took:\na. read the file\nb. fixed it\n\n**Decision for you**\n1. Ship it?\n   a. Yes\n   b. No');
  assert.deepEqual(calls.map((c) => c.question), ['Ship it?']);
});

test('PR-Agent r2 on #17: every decision needs an answer; Merge and Request changes refuse while a call is open', async () => {
  const t3 = { call: async () => { throw new Error('must not send'); } };
  const text = '1. Ship it?\n   a. Yes\n   b. No\n2. Delete the old files?\n   a. Yes\n   b. Keep them';
  const board = withCall(text), key = board.tickets[0].call.key;
  assert.match((await act({ board, t3, input: { kind: 'call', thread: 'ship', call: key, 'c:0': 'a', nonce: 'n' } })).text, /every decision/);
  assert.equal((await act({ board, t3, input: { kind: 'go', thread: 'ship', nonce: 'n' } })).status, 409);
  assert.equal((await act({ board, t3, input: { kind: 'refire', thread: 'ship', note: 'x', nonce: 'n' } })).status, 409);
  assert.equal((await act({ board, t3: { call: async () => ({}) }, input: { kind: 'reply', thread: 'ship', note: 'x', nonce: 'n' } })).status, 200);
});

test('PR-Agent r2 on #17: an unconfirmed send comes back as the same answer to send again, never as a success', async () => {
  const board = withCall(), key = board.tickets[0].call.key, answered = new Map();
  await assert.rejects(act({ board, t3: { call: async () => { throw new Error('timeout'); } }, answered, input: { kind: 'call', thread: 'ship', call: key, 'c:0': 'a', note: 'n1 note', nonce: 'first' } }));
  const html = page(board, answered);
  assert.match(html, /Not confirmed: your 1a/);
  assert.doesNotMatch(html, /You answered 1a/);
  assert.match(html, /name="nonce" value="first"/);
  assert.match(html, /name="c:0" value="a"><input type="hidden" name="note" value="n1 note">/);
  // That same retry, once T3 takes it, confirms the answer.
  assert.equal((await act({ board, t3: { call: async () => ({}) }, answered, input: { kind: 'call', thread: 'ship', call: key, 'c:0': 'a', note: 'n1 note', nonce: 'first' } })).status, 200);
  assert.match(page(board, answered), /You answered 1a/);
});

test('PR-Agent r3 on #17: options inside a code fence are an example, not a question', () => {
  assert.deepEqual(parseCalls('The format is:\n```markdown\nShip it?\na. Yes\nb. No\n```\nNothing to decide today.'), []);
  assert.equal(parseCalls('```\nexample\n```\nShip it?\na. Yes\nb. No').length, 1);
});

test('PR-Agent r5 on #17: nine options all count; a cut-off message offers no Merge or Request changes', async () => {
  const nine = parseCalls('Which one?\n' + 'abcdefghi'.split('').map((l) => `${l}. option ${l}`).join('\n') + '\nRecommendation: i.')[0];
  assert.equal(nine.options.length, 9);
  assert.equal(nine.recommend, 'i');
  const b = buildBoard({ projects: [], questions: new Map(), threads: [T('long')], lastWords: new Map([['long', { latest: { itemId: 'x', text: 'Very long…' }, call: null, cut: true }]]) });
  const html = page(b);
  assert.match(html, /Not checked: the Pass could not read all of its recent messages/);
  assert.doesNotMatch(html, /value="go"|value="refire"/);
  assert.equal((await act({ board: b, t3: { call: async () => ({}) }, input: { kind: 'go', thread: 'long', nonce: 'n' } })).status, 409);
});

test('PR-Agent r6 on #17: a pending T3 question blocks a call answer', async () => {
  const calls = parseCalls(REAL);
  const b = buildBoard({ projects: [], questions: new Map([['kid', [{ id: 'q', question: 'Which?', options: [], requestId: 'r' }]]]),
    threads: [T('ship'), T('kid', { parentThreadId: 'ship', status: 'running' })],
    lastWords: new Map([['ship', { latest: { itemId: 'i1', text: REAL }, call: { key: callKey('i1', calls), itemId: 'i1', text: REAL, calls } }]]) });
  // The asking child is not working, so the parent's turn and its call stand; the question still comes first.
  assert.ok(b.tickets[0].call);
  assert.equal((await act({ board: b, t3: { call: async () => { throw new Error('must not send'); } }, input: { kind: 'call', thread: 'ship', call: b.tickets[0].call.key, 'c:0': 'a', nonce: 'n' } })).status, 409);
});

test('PR-Agent r7 on #17: "I recommend a phased rollout" names no option; "Recommendation: A for today" does', () => {
  assert.equal(parseCalls('Ship how?\na. Full release\nb. Phased rollout\nI recommend a phased rollout.')[0].recommend, null);
  assert.equal(parseCalls('Which token?\n- A. Use the token\n- B. Rotate it\n- Recommendation: A for today. B only if it changes.')[0].recommend, 'a');
  assert.equal(parseCalls('Ship it?\na. Yes\nb. No\n**Recommendation: b.** It waits on CI.')[0].recommend, 'b');
});

test('the message drops the option lines the dock already shows, and the card names the recommendation', () => {
  const html = page(withCall());
  const prose = html.slice(html.indexOf('<div class="prose last full">'), html.indexOf('</div>', html.indexOf('<div class="prose last full">')));
  assert.doesNotMatch(prose, /Yes, merge once CI is green/);
  assert.doesNotMatch(prose, /Change something first/);
  // The question and the recommendation line are in the dock, not repeated in the message (Sol).
  assert.doesNotMatch(prose, /Ship #2151\?/);
  assert.doesNotMatch(prose, /Recommend(ation)?:? \*?\*?a/i);
  assert.match(html, /name="c:0" value="a"[^>]*><span class="opt-t"><b>a\.<\/b> Yes, merge once CI is green\./);
  assert.match(html, /name="c:0" value="a" data-key="a" data-need data-rec>/);
});

test('screenshots are attachments pinned under the title, at one size and labelled, never inside the message (Dan, 2026-11-07)', () => {
  const html = page(withCall());
  const plate = html.slice(html.indexOf('<article class="plate"'));
  const prose = plate.slice(plate.indexOf('<div class="prose last full">'), plate.indexOf('</div>', plate.indexOf('<div class="prose last full">')));
  assert.doesNotMatch(prose, /<img|data-shot/);
  // The title, the question count, then the attachments, then the message.
  const at = (re) => plate.search(re);
  assert.ok(at(/class="plate-t"/) < at(/class="lead/) && at(/class="lead/) < at(/class="atts"/) && at(/class="atts"/) < at(/class="prose last full"/));
  assert.match(plate, /<p class="lead lead-n"><span class="chip c-blue lead-k">1 question<\/span><\/p>/);
});

test('PR-Agent r2 on #27: an option line that carries a screenshot keeps its words, and the screenshot is pinned', () => {
  const text = 'Which hero?\n\n1. Which layout should the hero use?\n   a. Centered ![centered, dark](/Users/chef/rw-artifacts/2026-11-07/hero/centered.png)\n   b. Left-aligned\n\nRecommendation: a.';
  const html = page(withCall(text));
  const prose = html.slice(html.indexOf('<div class="prose last full">'), html.indexOf('</div>', html.indexOf('<div class="prose last full">')));
  assert.match(prose, /Centered/);
  assert.doesNotMatch(prose, /Left-aligned/);
  assert.match(html, /<span class="att-cap">centered, dark<\/span>/);
});

test('a line that is only a screenshot\'s path is pinned, not repeated in the message; a path in a sentence stays (hill climb 2 r1)', () => {
  const text = 'Which hero?\n\n`/Users/chef/rw-artifacts/2026-11-07/hero/centered.png`\n\nSee `/Users/chef/rw-artifacts/2026-11-07/hero/left.png` for the other.\n\n1. Which layout should the hero use?\n   a. Centered\n   b. Left-aligned\n\nRecommendation: a.';
  const html = page(withCall(text));
  const prose = html.slice(html.indexOf('<div class="prose last full">'), html.indexOf('</div>', html.indexOf('<div class="prose last full">')));
  assert.doesNotMatch(prose, /centered\.png/);
  assert.match(prose, /See <code>\/Users\/chef\/rw-artifacts\/2026-11-07\/hero\/left\.png<\/code> for the other/);
  assert.match(html, /<span class="att-cap">centered\.png<\/span>/);
  assert.match(html, /<span class="att-cap">left\.png<\/span>/);
});

test('PR-Agent r3 on #27: an option line with a link keeps it clickable; a PR URL option still goes to the dock', () => {
  const text = 'Which hero?\n\n1. Which layout should the hero use?\n   a. Centered, see [preview](https://preview.example/hero)\n   b. Ship https://github.com/o/r/pull/12 as is\n\nRecommendation: a.';
  const html = page(withCall(text));
  const prose = html.slice(html.indexOf('<div class="prose last full">'), html.indexOf('</div>', html.indexOf('<div class="prose last full">')));
  assert.match(prose, /<a [^>]*href="https:\/\/preview\.example\/hero"/);
  assert.doesNotMatch(prose, /pull\/12/);
});

test('PR-Agent r4 on #27: a question line with a link stays in the message', () => {
  const text = 'Which hero?\n\n1. Ship [the preview](https://preview.example/hero)?\n   a. Yes\n   b. No\n\nRecommendation: a.';
  const html = page(withCall(text));
  const prose = html.slice(html.indexOf('<div class="prose last full">'), html.indexOf('</div>', html.indexOf('<div class="prose last full">')));
  assert.match(prose, /<a [^>]*href="https:\/\/preview\.example\/hero"/);
});

test('PR-Agent r5 on #27: an option PR link keeps its comment anchor and drops trailing punctuation', () => {
  const text = 'Which?\n\n1. Merge it?\n   a. Yes, see https://github.com/o/r/pull/12#discussion_r123.\n   b. No, see https://github.com/o/r/pull/12/files\n\nRecommendation: a.';
  const html = page(withCall(text));
  assert.match(html, /<a href="https:\/\/github\.com\/o\/r\/pull\/12#discussion_r123" target="_blank" rel="noopener">PR #12<\/a>\./);
  assert.match(html, /<a href="https:\/\/github\.com\/o\/r\/pull\/12\/files" target="_blank" rel="noopener">PR #12<\/a>/);
});

test('PR-Agent r6 on #27: a question line keeps its PR link; an answered ticket keeps its whole decision', () => {
  const text = 'Which?\n\n1. Review https://github.com/o/r/pull/12#discussion_r123?\n   a. Yes, merge it now\n   b. No, hold it\n\nRecommendation: a.';
  const board = withCall(text);
  const prose = (html) => html.slice(html.indexOf('<div class="prose last full">'), html.indexOf('</div>', html.indexOf('<div class="prose last full">')));
  assert.match(prose(page(board)), /discussion_r123/);
  assert.doesNotMatch(prose(page(board)), /Yes, merge it now/);
  const answered = new Map([[board.tickets[0].call.key, { picks: '1a', letters: ['a'], at: '9:00 AM', confirmed: true }]]);
  const after = prose(page(board, answered));
  assert.match(after, /Yes, merge it now/);
  assert.match(after, /No, hold it/);
});

test('the pull request the message names comes first, by whole URL or number only (PR-Agent r1 on #38)', () => {
  const prs = [{ repository: 'o/r', number: 21, state: 'open' }, { repository: 'o/r', number: 2151, state: 'open' }];
  const chips = (text) => { const html = page(withCall(text, { pullRequests: prs })); return [...html.matchAll(/class="prc[^"]*"[^>]*>.*?r#([0-9]+)/g)].map((m) => m[1]); };
  assert.deepEqual(chips('See https://github.com/o/r/pull/2151 for the fix.\n\n1. Ship it?\n   a. Yes\n   b. No'), ['2151', '21']);
  assert.deepEqual(chips('Only #21 matters.\n\n1. Ship it?\n   a. Yes\n   b. No'), ['21', '2151']);
});

// Dan's "Agentic Brigade for Dev Teams" call, 2026-11-08: three decisions, each with a "Recommendation:" line that
// says more than its letter.
const BRIGADE = readFileSync(new URL('../fixtures/t3-three-calls.md', import.meta.url), 'utf8');

test('"Recommendation: a now." names option a; "I recommend a phased rollout" still names none (Dan, 2026-11-08)', () => {
  const calls = parseCalls(BRIGADE);
  assert.deepEqual(calls.map((c) => [c.options.length, c.recommend]), [[3, 'a'], [2, 'a'], [2, 'a']]);
  assert.equal(calls[0].question, 'How does Yes Chef get live updates from T3 Code?');
  assert.equal(parseCalls('Ship how?\na. Full release\nb. Phased rollout\nI recommend a phased rollout.')[0].recommend, null);
});

test('three decisions: the message keeps its prose, and each reason moves onto its question\'s card (Dan, 2026-11-08)', () => {
  const calls = parseCalls(BRIGADE);
  const board = buildBoard({ projects: [{ id: 'p', title: 'P' }], questions: new Map(), threads: [T('b', { title: 'Agentic Brigade for Dev Teams' })],
    lastWords: new Map([['b', { latest: { itemId: 'i1', text: BRIGADE }, call: { key: callKey('i1', calls), itemId: 'i1', text: BRIGADE, calls } }]]) });
  const html = page(board);
  const prose = html.slice(html.indexOf('<div class="prose last full">'), html.indexOf('</div>', html.indexOf('<div class="prose last full">')));
  assert.doesNotMatch(prose, /Recommendation/);
  assert.match(prose, /Your encryption question/);
  assert.match(prose, /Once you answer, I(?:'|&#39;|&#x27;)ll write the brief/);
  assert.match(html, /<form class="act q-car"/);
  assert.match(html, /1 of 3/);
  assert.match(html, /<p class="q-why"><b>Recommendation:<\/b> a now\. Offer b to the team next week\.<\/p><\/fieldset><fieldset class="q-set"><legend>How much do we take from T3 Code\?/);
  assert.match(html, /<p class="q-why"><b>Recommendation:<\/b> a\. T3 Code uses it, and single sign-on and billing come with it later\.<\/p><\/fieldset>/);
  // A bare "Recommendation: a." adds nothing to the Recommended pill, so it shows no line.
  assert.equal((html.match(/class="q-why"/g) || []).length, 2);
  // An architecture call that says "design choices" is not about something you can see.
  assert.doesNotMatch(html, /class="kr-flag"/);
});

test('PR-Agent r1 on #50: two decisions that ask the same thing keep their own reasons', () => {
  const text = '**Decisions**\n1. Ship it?\n   a. Yes\n   b. No\n   Recommendation: a. CI is green.\n2. Ship it?\n   a. Yes\n   b. No\n   Recommendation: b. Staging is down.';
  const calls = parseCalls(text);
  assert.equal(calls.length, 2);
  const board = buildBoard({ projects: [{ id: 'p', title: 'P' }], questions: new Map(), threads: [T('d', { title: 'Two ships' })],
    lastWords: new Map([['d', { latest: { itemId: 'i1', text }, call: { key: callKey('i1', calls), itemId: 'i1', text, calls } }]]) });
  const html = page(board);
  assert.match(html, /Recommendation:<\/b> a\. CI is green\.<\/p><\/fieldset><fieldset class="q-set"><legend>Ship it\?<\/legend>[\s\S]*?Recommendation:<\/b> b\. Staging is down\.<\/p><\/fieldset>/);
});

test('PR-Agent r4 on #50: a recommendation in the prose before the first decision stays in the message', () => {
  const text = 'Recommendation: b. Keep the existing deployment.\n\n**Decisions**\n1. Ship it?\n   a. Yes\n   b. No\n   Recommendation: a. CI is green.';
  const calls = parseCalls(text);
  const board = buildBoard({ projects: [{ id: 'p', title: 'P' }], questions: new Map(), threads: [T('d', { title: 'One ship' })],
    lastWords: new Map([['d', { latest: { itemId: 'i1', text }, call: { key: callKey('i1', calls), itemId: 'i1', text, calls } }]]) });
  const html = page(board);
  const prose = html.slice(html.indexOf('<div class="prose last full">'), html.indexOf('</div>', html.indexOf('<div class="prose last full">')));
  assert.match(prose, /Keep the existing deployment/);
  assert.doesNotMatch(prose, /CI is green/);
  assert.match(html, /<p class="q-why"><b>Recommendation:<\/b> a\. CI is green\.<\/p>/);
  assert.doesNotMatch(html, /q-why"><b>Recommendation:<\/b> b\. Keep/);
});

test('PR-Agent r5 on #50: after a bare recommendation, a later one stays in the message', () => {
  const text = '**Decisions**\n1. Ship it?\n   a. Yes\n   b. No\n   Recommendation: a.\n\nRecommendation: b. Keep the existing deployment.';
  const calls = parseCalls(text);
  assert.equal(calls[0].recommend, 'a');
  const board = buildBoard({ projects: [{ id: 'p', title: 'P' }], questions: new Map(), threads: [T('d', { title: 'One ship' })],
    lastWords: new Map([['d', { latest: { itemId: 'i1', text }, call: { key: callKey('i1', calls), itemId: 'i1', text, calls } }]]) });
  const html = page(board);
  const prose = html.slice(html.indexOf('<div class="prose last full">'), html.indexOf('</div>', html.indexOf('<div class="prose last full">')));
  assert.match(prose, /Keep the existing deployment/);
  assert.doesNotMatch(html, /class="q-why"/);
});

test('PR-Agent r7 on #50: only the line a decision\'s recommendation came from moves to its card', () => {
  const text = 'Ship it?\na. Yes (recommended)\nb. No\n\n**Later**\n\nSome notes on the queue.\n\nMore notes.\n\nRecommendation: a. Keep the worker pool.';
  const calls = parseCalls(text);
  assert.equal(calls[0].recommend, 'a');
  assert.deepEqual(recommendLines(text), [-1]);
  assert.deepEqual(recommendLines(BRIGADE), BRIGADE.split('\n').map((l, n) => [l, n]).filter(([l]) => /^\s+Recommendation:/.test(l)).map(([, n]) => n));
  // The parsed calls, and so their keys, carry no line numbers.
  assert.equal('recLine' in calls[0], false);
  const board = buildBoard({ projects: [{ id: 'p', title: 'P' }], questions: new Map(), threads: [T('d', { title: 'One ship' })],
    lastWords: new Map([['d', { latest: { itemId: 'i1', text }, call: { key: callKey('i1', calls), itemId: 'i1', text, calls } }]]) });
  const html = page(board);
  assert.doesNotMatch(html, /class="q-why"/);
  assert.match(html, /Keep the worker pool/);
});
