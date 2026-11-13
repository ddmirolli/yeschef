// Stage rules for T3 threads as tickets. Run: vp test run board.test.ts, in client/
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { buildBoard, shownPrs } from './board.ts';
import { summarize } from './team-summaries.ts';
import { one } from './test/expect.ts';
import type { Status, Ticket } from './board.ts';
import type { PullRequestLink, QuestionItem, ThreadRow } from './contracts.ts';

const T = (id: string, extra: Partial<ThreadRow> = {}): ThreadRow => ({ threadId: id, title: id, projectId: 'p', status: 'completed', latestRunId: 'r', updatedAt: '2026-11-06T12:00:00Z', pullRequests: [], ...extra });
const pr = (n: number, state: string): PullRequestLink => ({ repository: 'o/r', number: n, state });
// Local times, so the calendar-day rule holds in any time zone (TZ=Asia/Tokyo included).
const place = (threads: ThreadRow[], questions = new Map<string, QuestionItem[]>()) => Object.fromEntries(buildBoard({ projects: [{ id: 'p', title: 'P' }], threads, questions, today: new Date(2026, 10, 6, 15) }).tickets.map((k) => [k.thread.threadId, k.place]));
/** The one ticket a test reads, which must be there. */
const only = (tickets: Ticket[], i = 0): Ticket => { const k = tickets[i]; assert.ok(k); return k; };

test('a ticket is a top-level thread; its subagents are stations', () => {
  const b = buildBoard({ projects: [], threads: [T('a'), T('b', { parentThreadId: 'a' }), T('c', { parentThreadId: 'b' })], questions: new Map() });
  assert.equal(b.tickets.length, 1);
  assert.equal(only(b.tickets).stations, 2);
});

test('stages follow the threads and their pull requests', () => {
  assert.deepEqual(place([
    T('order', { status: 'idle', latestRunId: null }), T('prep'),
    T('fire', { status: 'running' }), T('child-runs'), T('kid', { parentThreadId: 'child-runs', status: 'running' }),
    T('tasting', { pullRequests: [pr(1, 'open')] }), T('sent', { pullRequests: [pr(2, 'merged')] }),
    T('plating', { status: 'waiting', pullRequests: [pr(3, 'open')] }),
  ]), { order: 'Backlog', prep: 'Planned', fire: 'In progress', 'child-runs': 'In progress', tasting: 'In review', sent: 'Merged', plating: 'Ready to merge' });
});

test('a question without an open PR waits at the pass but stays in its stage', () => {
  const b = buildBoard({ projects: [], threads: [T('q', { status: 'waiting' })], questions: new Map() });
  assert.equal(only(b.tickets).place, 'Planned');
  assert.equal(only(b.tickets).atPass, true);
});

test('Verified needs settled with nothing open; held states win', () => {
  assert.deepEqual(place([
    T('v', { settled: true, settledAt: new Date(2026, 10, 6, 14).toISOString(), pullRequests: [pr(1, 'merged')] }),
    T('settled-open', { settled: true, pullRequests: [pr(2, 'open')] }),
    T('snoozed', { snoozed: true }), T('failed', { status: 'failed' }), T('stopped', { status: 'interrupted' }),
  ]), { v: 'Verified', 'settled-open': 'In review', snoozed: 'Snoozed', failed: 'Failed', stopped: 'Stopped' });
});

test('Verified today counts the local calendar day', () => {
  const b = buildBoard({ projects: [], questions: new Map(), today: new Date(2026, 10, 6, 21, 0),
    threads: [T('late', { settled: true, settledAt: new Date(2026, 10, 6, 20, 30).toISOString() }), T('old', { settled: true, settledAt: new Date(2026, 10, 5, 9, 0).toISOString() })] });
  assert.equal(b.verifiedToday, 1);
});

import { renderApp, pickedFrom } from './board.ts';
const link = (t: ThreadRow) => `https://t3.example/env/${t.threadId}`;

test('an older Verified ticket leaves the board; one with work still running stays', () => {
  const b = buildBoard({ projects: [], questions: new Map(), today: new Date(2026, 10, 6, 12),
    threads: [T('old', { settled: true, settledAt: new Date(2026, 10, 1).toISOString() }),
      T('old-busy', { settled: true, settledAt: new Date(2026, 10, 1).toISOString() }), T('kid', { parentThreadId: 'old-busy', status: 'running' })] });
  assert.deepEqual(b.tickets.map((k) => [k.thread.threadId, k.place]), [['old-busy', 'In progress']]);
});

test('without a good poll the page says "not checked", never "all clear" or an older board', () => {
  const board = buildBoard({ projects: [], questions: new Map(), threads: [T('a', { status: 'running' })] });
  const html = renderApp({ board, link, status: { ok: false, error: 'T3 down', at: 0, ms: 0 }, origin: 'https://t3.example' });
  assert.match(html, /Not checked/);
  assert.doesNotMatch(html, /All clear/);
  assert.doesNotMatch(html, /data-thread="a"/);
});

test('project names are data, and counts follow the picked projects', () => {
  const board = buildBoard({ projects: [{ id: 'x', title: '__proto__' }, { id: 'y', title: 'Y' }, { id: 'z', title: 'Z' }], questions: new Map(), today: new Date(2026, 10, 6, 12),
    threads: [T('a', { projectId: 'x' }), T('b', { projectId: 'y', settled: true, settledAt: new Date(2026, 10, 6, 9).toISOString() }), T('c', { projectId: 'z', status: 'running' })] });
  const ok: Status = { ok: true, at: 0, ms: 1 };
  const page = (picked: string[] | null) => renderApp({ board, picked, link, status: ok, origin: 'https://t3.example' });
  assert.match(page(null), /data-p="__proto__" aria-checked="true"><span class="cb"[\s\S]*?<span class="vn">__proto__<\/span>/);
  assert.match(page(['__proto__']), /Verified today <b>0<\/b>/);
  assert.match(page(['Y']), /Verified today <b>1<\/b>/);
  // Any set: two of three projects count both, and only theirs.
  const two = page(['Y', 'Z']);
  assert.match(two, /Active <b>1<\/b>/);
  assert.match(two, /Verified today <b>1<\/b>/);
  assert.doesNotMatch(two, /data-thread="a"/);
  assert.match(two, /data-p="__proto__" aria-checked="false"/);
  // Every project picked is All projects.
  assert.match(page(['__proto__', 'Y', 'Z']), /<span class="vp">All projects<\/span>/);
  assert.match(page(['__proto__', 'Y', 'Z']), /class="pk all" role="checkbox" aria-checked="true"/);
});

test('the address picks projects: p repeats, and no p is All projects', () => {
  const q = (s: string) => pickedFrom(new URLSearchParams(s));
  assert.equal(q(''), null);
  assert.equal(q('?p='), null);
  assert.deepEqual(q('?p=A&p=B&p=A&p='), ['A', 'B']);
  assert.deepEqual(q('?p=__proto__&p=a%26b'), ['__proto__', 'a&b']);
});

test('a picked project with no tickets now stays in the menu, so it can be unticked', () => {
  const board = buildBoard({ projects: [{ id: 'y', title: 'Y' }], questions: new Map(), threads: [T('a', { projectId: 'y' })] });
  const html = renderApp({ board, picked: ['Gone', 'Y'], link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  // The pick with no ticket is marked, so the page script counts All projects as Y alone, as the server does.
  assert.deepEqual([...html.matchAll(/data-p="(\w+)"( data-gone)? aria-checked="(\w+)"/g)].map((m) => m.slice(1)).slice(0, 2), [['Gone', ' data-gone', 'true'], ['Y', undefined, 'true']]);
  assert.match(html, /<span class="fan" style="--n:2" title="Gone, Y">/);
});

test('the Pass orders by the oldest waiting question, and a failed poll shows no counts', () => {
  const board = buildBoard({ projects: [], questions: new Map(), threads: [
    T('new-parent', { updatedAt: '2026-11-06T14:00:00Z' }), T('old-ask', { parentThreadId: 'new-parent', status: 'waiting', updatedAt: '2026-11-06T08:00:00Z' }),
    T('mid', { status: 'waiting', updatedAt: '2026-11-06T10:00:00Z' })] });
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  const at = (id: string) => html.search(new RegExp(`call-tile mail" data-plate="[^"]+" data-thread="${id}"`));
  assert.ok(at('old-ask') >= 0 && at('old-ask') < at('mid'));
  const down = renderApp({ board, link, status: { ok: false, error: 'x', at: 0, ms: 0 }, origin: 'https://t3.example' });
  assert.match(down, /<nav class="pmenu-l" aria-label="Projects" data-nc>[\s\S]*?<p class="pk-nc"><b>Projects not checked\.<\/b> T3 did not answer\.<\/p>/);
  // A pick without a board stays a pick: the chip never says All projects for it.
  const kept = renderApp({ board, picked: ['Y'], link, status: { ok: false, error: 'x', at: 0, ms: 0 }, origin: 'https://t3.example' });
  assert.match(kept, /<span class="fan" style="--n:1" title="Y">/);
  assert.match(kept, /class="pk all" role="checkbox" aria-checked="mixed"/);
});

test('without a good poll the counts read "not checked", not zero', () => {
  const board = buildBoard({ projects: [], questions: new Map(), threads: [] });
  const html = renderApp({ board, link, status: { ok: false, error: 'x', at: 0, ms: 0 }, origin: 'https://t3.example' });
  assert.match(html, /Active <b>not checked<\/b>/);
  // The chart says so too, and draws nothing.
  assert.match(html, /<div class="fx-empty"><p><b>Not checked<\/b>/);
  assert.doesNotMatch(html, /<svg class="fx"/);
});

test('the card shows the oldest waiting question when parent and station both ask', () => {
  const board = buildBoard({ projects: [], questions: new Map(), threads: [
    T('parent', { status: 'waiting', updatedAt: '2026-11-06T14:00:00Z' }), T('station', { parentThreadId: 'parent', status: 'waiting', updatedAt: '2026-11-06T09:00:00Z' })] });
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /call-tile mail" data-plate="[^"]+" data-thread="station"/);
});

test('a finished, unsettled ticket hands the turn back: it waits at the pass with the agent\'s last words', () => {
  const words = new Map([['done', 'Four items wait on your go.\n\n1. Post #2318.']]);
  const board = buildBoard({ projects: [], questions: new Map(), lastWords: words, threads: [
    T('done', { pullRequests: [pr(9, 'open')] }), T('busy', { status: 'running' }), T('settled', { settled: true, pullRequests: [pr(8, 'open')] })] });
  const by = new Map(board.tickets.map((k) => [k.thread.threadId, k]));
  assert.equal(by.get('done')?.yourTurn, true);
  assert.equal(by.get('done')?.atPass, true);
  assert.equal(by.get('busy')?.atPass, false);
  assert.equal(by.get('settled')?.yourTurn, false);
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /chip c-blue">Your turn/);
  assert.match(html, /Four items wait on your go\./);
});

test('coordinator threads stay out of the stages, the pass and the On hold shelf (Dan, 2026-11-07: Yes Chef replaces them)', () => {
  const board = buildBoard({ projects: [], questions: new Map(), threads: [T('ATC 11-06', { pullRequests: [pr(1, 'open')] })] });
  assert.equal(only(board.tickets).place, 'Coordinators');
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.doesNotMatch(html, /Coordinators/);
  assert.match(html, /<b>Nothing on the line<\/b>/);
});

test('a ticket opens to its pull requests and stations, each linked out', () => {
  const board = buildBoard({ projects: [{ id: 'p', title: 'P', icon: '/icon/p' }], questions: new Map(), threads: [
    T('t', { status: 'running', pullRequests: [{ repository: 'o/r', number: 7, state: 'open', url: 'https://github.com/o/r/pull/7' }] }),
    T('s1', { parentThreadId: 't', status: 'running', title: 'Build the card', model: 'claude-opus-5-5' })] });
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /<article class="plate" id="p-[0-9a-f]{12}"/);
  assert.match(html, /href="https:\/\/github\.com\/o\/r\/pull\/7"/);
  assert.match(html, /href="https:\/\/t3\.example\/env\/s1"[^>]*>Build the card/);
  assert.match(html, /<img class="pm pimg" src="\/icon\/p"/);
});

test('agent messages: plain on the card, light formatting in the open ticket, T3 links named, nothing unescaped', () => {
  const words = new Map([['done', 'Merged **#2317** at `301206d` and told the [ATC](<t3-thread://v2/env/abc>).\n\n**Merge** <script>x</script>']]);
  const board = buildBoard({ projects: [], questions: new Map(), lastWords: words, threads: [T('done')] });
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /<span class="ct-pv">Merged #2317 at 301206d and told the ATC\./);
  assert.match(html, /<b>#2317<\/b> at <code>301206d<\/code>/);
  assert.doesNotMatch(html, /t3-thread:/);
  assert.doesNotMatch(html, /<script>x/);
});

test('a finished coordinator thread never shows at the pass', () => {
  const board = buildBoard({ projects: [], questions: new Map(), threads: [T('Expo 11-06')] });
  assert.equal(only(board.tickets).place, 'Coordinators');
  assert.equal(only(board.tickets).atPass, false);
});

test('an agent\'s "- " lines become a list in the open ticket, joined without blank lines', () => {
  const words = new Map([['done', 'Intro line.\n- first **bold**\n- second `code`\nAfter.']]);
  const board = buildBoard({ projects: [], questions: new Map(), lastWords: words, threads: [T('done')] });
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /Intro line\.<ul><li>first <b>bold<\/b><\/li><li>second <code>code<\/code><\/li><\/ul>After\./);
});

test('an agent\'s Markdown table becomes a table, escaped, and a lone pipe line stays text', () => {
  const words = new Map([['done', 'Queue:\n| # | PR | CI |\n|---|---|:--:|\n| 1 | #2330 <x> | **green** |\n| 2 | `#2346` | red |\nAfter.\n| not a table |']]);
  const board = buildBoard({ projects: [], questions: new Map(), lastWords: words, threads: [T('done')] });
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /Queue:<table class="md"><thead><tr><th>#<\/th><th>PR<\/th><th>CI<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>#2330 &lt;x&gt;<\/td><td><b>green<\/b><\/td><\/tr><tr><td>2<\/td><td><code>#2346<\/code><\/td><td>red<\/td><\/tr><\/tbody><\/table>After\./);
  assert.match(html, /After\.\n\| not a table \|/);
});

test('a question the ticket itself asks leads its sheet; a station\'s question keeps its name and link', () => {
  const qa = { id: 'q', requestId: 'r', question: 'Which?', options: [{ label: 'a', description: 'first' }] };
  const board = buildBoard({ projects: [], questions: new Map([['self', [qa]], ['st', [qa]]]), threads: [
    T('self', { status: 'running' }), T('parent'), T('st', { parentThreadId: 'parent', status: 'running', title: 'Station one' })] });
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  // The ticket's own question goes straight to the dock; a station's carries its name there and a link above.
  assert.match(html, /<p class="dock-k"><span class="chip c-blue">1 question<\/span><\/p><form class="act"[^>]*>(<input[^>]*>){3}<fieldset/);
  assert.match(html, /<b>Station one<\/b> is waiting on your answer\. <a href="https:\/\/t3\.example\/env\/st"/);
  assert.match(html, /<p class="dock-who">Station one asks<\/p>/);
  assert.match(html, /Hold and Settle come back once the question is answered\./);
});

test('a card labels each pull request by its number: two shown, the rest counted (Dan, 2026-11-08)', () => {
  const many = Array.from({ length: 8 }, (_, i) => pr(i + 1, i === 7 ? 'open' : 'merged'));
  const board = buildBoard({ projects: [], questions: new Map(), threads: [T('one', { pullRequests: [pr(1, 'open')] }), T('eight', { pullRequests: many })] });
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /class="th pr-open" title="o\/r#1 open"><i><\/i>#1</);
  // Open ones first.
  assert.match(html, /<i><\/i>#8<\/span><\/span><span class="mb"><span class="th pr-merged"[^>]*><i><\/i>#1</);
  assert.match(html, />\+6 PRs</);
});

test('a PR linked under its old and new owner shows one label; the data keeps both links (seen 2026-11-08)', () => {
  const moved = [{ repository: 'reviewwheel/reviewwheel', number: 2371, state: 'open' }, { repository: 'ddmirolli/reviewwheel', number: 2371, state: 'open' }];
  const board = buildBoard({ projects: [], questions: new Map(), threads: [
    T('moved', { pullRequests: moved }),
    T('three', { pullRequests: [pr(1, 'open'), pr(2, 'open'), pr(3, 'open'), { repository: 'x/r', number: 3, state: 'open' }] }),
    T('relinked', { pullRequests: [pr(12, 'open')] }), T('station', { parentThreadId: 'relinked', pullRequests: [{ repository: 'O/R', number: 12, state: 'merged' }] })] });
  const at = (id: string) => { const k = board.tickets.find((t) => t.thread.threadId === id); assert.ok(k, id); return k; };
  // Not proven one PR, so both stay in the data.
  assert.equal(at('moved').prs.length, 2);
  assert.deepEqual(shownPrs(at('moved').prs).map((p) => p.repositories), [['reviewwheel/reviewwheel', 'ddmirolli/reviewwheel']]);
  assert.equal(shownPrs(at('three').prs).length, 3);
  // The same repository linked open by the parent and merged by a station is one PR, and merged wins.
  assert.deepEqual(at('relinked').prs.map((p) => p.state), ['merged']);
  assert.equal(at('relinked').place, 'Merged');
  // A fork's #12 in another state, or a closed link beside a reopened PR, shows as its own label.
  assert.equal(shownPrs([{ repository: 'up/app', number: 12, state: 'open' }, { repository: 'alice/app', number: 12, state: 'merged' }]).length, 2);
  assert.equal(shownPrs([{ repository: 'o/r', number: 5, state: 'closed' }, { repository: 'a/r', number: 5, state: 'open' }]).length, 2);
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /<i><\/i>#2371</);
  assert.doesNotMatch(html, /#2371<\/span><span[^>]*><i><\/i>#2371</);
  assert.match(html, /title="reviewwheel\/reviewwheel#2371, ddmirolli\/reviewwheel#2371 open"/);
  // The plate keeps both links, each with its owner so they do not read alike.
  assert.match(html, /<i><\/i>reviewwheel\/reviewwheel#2371<span>open<\/span>/);
  assert.match(html, /<i><\/i>ddmirolli\/reviewwheel#2371<span>open<\/span>/);
  assert.match(html, /<i><\/i>r#1<span>open<\/span>/);
  assert.match(html, />\+1 PR</);
  assert.doesNotMatch(html, /\+1 PRs/);
});

test('a ticket at the pass reads like an email: project and model, the thread title, one line of preview, labels (Dan, 2026-11-08)', () => {
  const q = { id: 'q', requestId: 'r', question: 'Which layout?', options: [{ label: 'Left' }, { label: 'Centered (Recommended)' }] };
  const q2 = { id: 'q2', requestId: 'r', question: 'Which day?', options: [{ label: 'Monday' }, { label: 'Friday' }] };
  const board = buildBoard({ projects: [{ id: 'p', title: 'Yes Chef' }], questions: new Map([['ask', [q, q2]]]),
    threads: [T('ask', { title: 'Homepage hero', status: 'running', model: 'claude-opus-5-5', pullRequests: [pr(12, 'open')] })] });
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  const card = html.slice(html.indexOf('<button type="button" class="tile call-tile mail"'), html.indexOf('</button>', html.indexOf('class="tile call-tile mail"')));
  assert.match(card, /<span class="pn">Yes Chef<\/span><\/span><span class="mdl">Opus 5\.5<\/span>/);
  assert.match(card, /<span class="q">Homepage hero<\/span><span class="ct-pv">Which layout\?<\/span>/);
  assert.match(card, /<span class="chip c-blue">2 questions<\/span><span class="lb"><i class="gd c-blue"><\/i>Ready to merge<\/span><span class="lb th pr-open"[^>]*><i><\/i>#12<\/span>/);
  // The question and its recommendation are the dock's, not the card's.
  assert.doesNotMatch(card, /Recommends|Centered/);
  // The open ticket's title is the thread's; under it, only the count.
  assert.match(html, /<h2 class="plate-t"[^>]*>Homepage hero<\/h2><p class="lead lead-n"><span class="chip c-blue lead-k">2 questions<\/span><\/p>/);
});

test('several questions show as cards, one at a time, each with its own legend (Dan, 2026-11-08)', () => {
  const q1 = { id: 'q1', requestId: 'r1', question: 'Which layout?', options: [{ label: 'Left' }, { label: 'Centered' }] };
  const q2 = { id: 'q2', requestId: 'r1', question: 'Which day should it go out?', options: [{ label: 'Monday' }, { label: 'Friday' }] };
  const board = buildBoard({ projects: [], questions: new Map([['ask', [q1, q2]]]), threads: [T('ask', { status: 'running' })] });
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /<form class="act q-car"/);
  assert.match(html, /<span class="q-pos" aria-live="polite">1 of 2<\/span>/);
  assert.match(html, /<fieldset class="q-set q-on"><legend>Which layout\?<\/legend>/);
  assert.match(html, /<fieldset class="q-set"><legend>Which day should it go out\?<\/legend>/);
  assert.equal((html.match(/data-qto=/g) || []).length, 2);
  // One question: no carousel.
  const one = buildBoard({ projects: [], questions: new Map([['ask', [q1]]]), threads: [T('ask', { status: 'running' })] });
  const h1 = renderApp({ board: one, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.doesNotMatch(h1, /q-car|q-nav|class="q-set q-on"/);
  assert.match(h1, /<fieldset class="q-set"><legend>Which layout\?<\/legend>/);
});

test('kitchen rules: a visual call with no screenshots shows the flag; with one, or with the rule off, it does not (Dan, 2026-11-08)', async () => {
  const { renderApp } = await import('./board.ts');
  const { parseCalls, callKey } = await import('./calls.ts');
  const text = (img: string) => `Done.\n\n1. Should the pill also show at the top of the location picker?${img}\n   - a. Yes.\n   - b. No.\n\n   Recommendation: a.`;
  const html = (img: string, rules: unknown) => {
    const calls = parseCalls(text(img));
    const words = { latest: { itemId: 'i', text: text(img) }, call: { key: callKey('i', calls), itemId: 'i', text: text(img), calls } };
    const board = buildBoard({ projects: [{ id: 'p', title: 'P' }], threads: [T('v')], questions: new Map(), lastWords: new Map([['v', words]]) });
    return renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example', rules });
  };
  assert.match(html('', null), /class="kr-flag"[^]*data-ask-shots="Send this call again/);
  assert.doesNotMatch(html('\n   ![a](/tmp/a.png)', null), /class="kr-flag"/);
  assert.doesNotMatch(html('', { all: { missing: 'off' } }), /class="kr-flag"/);
  assert.doesNotMatch(html('', { projects: { p: { screens: 'off' } } }), /class="kr-flag"/);
  // The shots came in a later message: the plate shows them, so no flag (PR-Agent r4 on #49).
  const calls = parseCalls(text(''));
  const later = { latest: { itemId: 'j', text: 'Here they are.\n\n![a](/tmp/a.png)' }, call: { key: callKey('i', calls), itemId: 'i', text: text(''), calls } };
  const b2 = buildBoard({ projects: [{ id: 'p', title: 'P' }], threads: [T('v')], questions: new Map(), lastWords: new Map([['v', later]]) });
  assert.doesNotMatch(renderApp({ board: b2, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example', rules: null }), /class="kr-flag"/);
});

test('kitchen rules pane: T3 Code-style rows, every project in Applies to, and the rules as safe JSON', async () => {
  const { kitchenPane } = await import('./board.ts');
  const { normalize } = await import('./kitchen.ts');
  const rules = normalize({ all: { notes: '</script><b>x' } });
  const h = kitchenPane({ rules, projects: [{ id: 'b', title: 'Beta' }, { id: 'a', title: '<Alpha>' }] });
  for (const k of ['screens', 'missing', 'form', 'reviewer', 'council', 'browser', 'tracker', 'notes']) assert.match(h, new RegExp(`data-kr="${k}"`));
  assert.match(h, /<option value="">All projects<\/option><option value="a">&lt;Alpha&gt;<\/option><option value="b">Beta<\/option>/);
  const json = h.match(/id="yc-rules">([^]*?)<\/script>/)?.[1] ?? '';
  assert.doesNotMatch(json, /</);
  assert.equal(JSON.parse(json).all.notes, '</script><b>x');
});

test('the team\'s Rules show for the lead only: saved values picked, each area with its owner, projects and mode, the budget only in French Brigade', async () => {
  const { renderApp, teamRulesRows, kitchenPane } = await import('./board.ts');
  const view = { status: 'member', lead: true, rules: { stuckMin: 60, bigLines: 1500, bigFiles: 60, checks: false, dupAt: 95 },
    people: [{ id: 'i', name: 'Iris <Ng>', role: 'owner', area: 'a1' }, { id: 'k', name: 'Kai', role: 'engineer', area: 'a2' }],
    areas: [{ id: 'a1', name: 'Payments', projects: ['Fernpay'], mode: 'open', budget: 10 }, { id: 'a2', name: '<Shared>', projects: ['Fernpay', 'Loopline'], mode: 'brigade', budget: 5 }] };
  const h = teamRulesRows(view, [{ id: 'p1', title: 'Quillo' }, { id: 'p2', title: 'Fernpay' }]);
  assert.match(h, /^<script type="text\/html" id="yc-team-rules">/);
  for (const g of ['Escalation', 'Thresholds', 'Model checks', 'Areas']) assert.match(h, new RegExp(`<h3 class="kgroup">${g}</h3>`));
  assert.match(h, /data-tr="stuckMin"[^>]*><option value="10">10 min<\/option><option value="20">20 min<\/option><option value="30">30 min<\/option><option value="60" selected>1 h<\/option>/);
  assert.match(h, /<option value="1500:60" selected>1,500 lines or 60 files<\/option>/);
  assert.match(h, /<option value="15" selected>15 min<\/option>/, 'a rule the roster leaves out is the default');
  assert.match(h, /<option value="0">No limit<\/option>/);
  assert.doesNotMatch(h, /data-tr="checks"[^>]* checked/, 'the model checks start off');
  assert.match(h, /class="kr-row kr-off" data-row="t-comparesDay"/, 'their settings are dimmed while they are off');
  // Areas: the owner by role, every project as a chip, the area's own pressed, names escaped.
  assert.match(h, /Payments <span class="tr-own">Iris &lt;Ng&gt; owns it<\/span>/);
  assert.match(h, /&lt;Shared&gt; <span class="tr-own">No area owner<\/span>/, 'an Engineer does not own an area');
  const chips = (id: string) => [...h.matchAll(new RegExp(`data-ta-proj="([^"]+)" data-ta-id="${id}" aria-pressed="(true|false)"`, 'g'))].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(chips('a1'), ['Fernpay:true', 'Loopline:false', 'Quillo:false']);
  assert.deepEqual(chips('a2'), ['Fernpay:true', 'Loopline:true', 'Quillo:false']);
  assert.match(h, /data-ta="mode" data-ta-id="a1"[^>]*><option value="open" selected>Open kitchen<\/option><option value="brigade">French Brigade<\/option>/);
  assert.equal((h.match(/Failed-change budget/g) || []).length, 1, 'only the French Brigade area has a budget');
  assert.match(h, /data-ta="budget" data-ta-id="a2"[^>]*>.*<option value="5" selected>5%<\/option>/);
  // The areas for "Applies to", each with the T3 projects in it, so a project shows what its areas give it.
  assert.match(h, /<select data-areas hidden><option value="area:a1" data-ids="\[&quot;p2&quot;\]">Payments<\/option><option value="area:a2" data-ids="\[&quot;p2&quot;\]">&lt;Shared&gt;<\/option><\/select><\/script>$/);
  // A name that tries to end the script early cannot.
  assert.doesNotMatch(teamRulesRows({ ...view, areas: [{ id: 'x', name: '</script><b>' }] }).slice(0, -'</script>'.length), /<\/script/i);
  // No areas yet: one row says where to add them.
  assert.match(teamRulesRows({ ...view, areas: [] }), /No areas yet<\/h4><\/div><p>Add areas on the Team page\./);
  // The page draws them only for the lead; the pane has their place, hidden until then.
  const board = buildBoard({ projects: [], threads: [], questions: new Map() });
  const base = { board, link, status: { ok: true as const, at: 0, ms: 1 }, origin: 'https://t3.example' };
  assert.match(renderApp({ ...base, lead: view }), /<script type="text\/html" id="yc-team-rules">/);
  assert.doesNotMatch(renderApp(base), /yc-team-rules/);
  assert.match(kitchenPane({ rules: null }), /<div id="kr-team" hidden><\/div><h3 class="kgroup">House notes<\/h3>/);
});

test('the team\'s thresholds from the roster reach the Pass it draws: Stuck at 60 min drops a thread quiet for 38', async () => {
  const { renderApp } = await import('./board.ts');
  const { fixtureView } = await import('./open-kitchen.fixture.ts');
  const now = Date.UTC(2026, 10, 10, 14, 3);
  const board = buildBoard({ projects: [], threads: [], questions: new Map() });
  const drawn = (rules?: object) => renderApp({ board, link, status: { ok: true as const, at: now, ms: 1 }, origin: 'https://t3.example', team: { view: { ...fixtureView(now), rules }, now, mode: 'open' } });
  // Its card and its reader: one card in both views since 2026-11-13 (Dan), no column card of its own.
  assert.equal((drawn().match(/>Stuck</g) || []).length, 2, 'the proposed 20 min: Omar\'s thread is Stuck');
  assert.equal((drawn({ stuckMin: 60 }).match(/>Stuck</g) || []).length, 0);
});

test('each refresh carries the saved kitchen rules, as safe JSON, for a second window (PR-Agent r3 on #49)', async () => {
  const { renderApp } = await import('./board.ts');
  const board = buildBoard({ projects: [], threads: [], questions: new Map() });
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example', rules: { all: { notes: '</script>x' }, projects: {} } });
  const json = html.match(/id="yc-rules-now">([^]*?)<\/script>/)?.[1] ?? '';
  assert.doesNotMatch(json, /</);
  assert.equal(JSON.parse(json).all.notes, '</script>x');
  assert.doesNotMatch(renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' }), /yc-rules-now/);
});

test('PR-Agent r6 on #50: a closed pull request has its own dot, and the count adds every waiting question', () => {
  const q = (id: string, r: string): QuestionItem => ({ id, requestId: r, question: id + '?', options: [{ label: 'Yes' }, { label: 'No' }] });
  const board = buildBoard({ projects: [], questions: new Map([['parent', [q('p1', 'r1')]], ['station', [q('s1', 'r2')]]]), threads: [
    T('parent', { status: 'running', pullRequests: [pr(3, 'closed')] }), T('station', { parentThreadId: 'parent', status: 'running' })] });
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /class="lb th pr-closed"[^>]*><i><\/i>#3</);
  assert.doesNotMatch(html, /pr-merged[^>]*><i><\/i>#3</);
  assert.match(html, /<span class="chip c-blue">2 questions<\/span>/);
});

test('a summary ticket carries its feature: the Linear project of its read tickets, null for none, left out when none was read', () => {
  const board = buildBoard({ projects: [{ id: 'p', title: 'P' }], questions: new Map(), threads: [T('a'), T('b'), T('c')] });
  const [a, b] = [one(board.tickets, (k) => k.thread.threadId === 'a', 'a'), one(board.tickets, (k) => k.thread.threadId === 'b', 'b')];
  const r = { state: 'read' as const, title: 't', status: null, statusType: null, url: null, assignee: null, at: 1, by: 'a' };
  a.linear = [{ ...r, id: 'ENG-1', project: 'Payouts v2 '.repeat(20), projectId: 'p-1' }];
  b.linear = [{ ...r, id: 'ENG-2', project: null, projectId: null }];
  const tickets = summarize(board, ['p'], 65536, { now: 1 }).tickets;
  const by = (id: string) => one(tickets, (t) => t.thread === id, id);
  assert.deepEqual(by('a').feature, { id: 'p-1', name: 'Payouts v2 '.repeat(20).trim().slice(0, 80) });
  assert.equal(by('b').feature, null);
  assert.equal('feature' in by('c'), false);
});

test('a summary sends each feature\'s lead and whole-list count, and each ticket\'s open blockers (step 7 PR 2)', () => {
  const pid = 'ed93ef9c-3f61-4ee9-97e3-aa4a25b32da3';
  const board = buildBoard({ projects: [{ id: 'p', title: 'P' }], questions: new Map(), threads: [T('a', { pullRequests: [{ number: 5, repository: 'o/r', state: 'open', url: 'https://github.com/o/r/pull/5' } as PullRequestLink] }), T('b')] });
  const [a, b] = [one(board.tickets, (k) => k.thread.threadId === 'a', 'a'), one(board.tickets, (k) => k.thread.threadId === 'b', 'b')];
  const r = { state: 'read' as const, title: 't', status: null, statusType: null, url: null, assignee: null, at: 7, by: 'a', project: 'Payouts v2', projectId: pid };
  a.linear = [{ ...r, id: 'ENG-1', blockedBy: [{ id: 'ENG-2', title: 'Ledger', open: true }, { id: 'ENG-3', title: 'Done one', open: false }, { id: 'ENG-4', title: 'Unread', open: null }] }];
  b.linear = [{ ...r, id: 'ENG-5' }];
  const project = (id: string) => (id === pid ? { id: pid, name: 'Payouts v2', lead: 'Priya Shah', leadAt: 3,
    tickets: [{ id: 'ENG-1', statusType: 'completed' }, { id: 'ENG-5', statusType: 'canceled' }, { id: 'ENG-6', statusType: null }], listAt: 4 } : null);
  const pr = () => ({ state: 'checked', at: 9, blockedBy: [{ repo: 'o/api', n: 3, open: true }, { repo: 'o/api', n: 4, open: false }] });
  const s = summarize(board, ['p'], 65536, { now: 10, project, pr });
  assert.deepEqual(s.features, [{ id: pid, name: 'Payouts v2', lead: 'Priya Shah', leadAt: 3, list: { n: 3, closed: 2, unread: 1, at: 4 }, threads: { n: 2, merged: 0 } }]);
  assert.deepEqual(one(s.tickets, (t) => t.thread === 'a', 'a').blocked, [{ id: 'ENG-2', title: 'Ledger', at: 7 }, { id: 'o/api#3', title: null, at: 9 }]);
  assert.equal('blocked' in one(s.tickets, (t) => t.thread === 'b', 'b'), false);
  // No project read: the feature goes with its name only.
  assert.deepEqual(summarize(board, ['p'], 65536, { now: 10 }).features, [{ id: pid, name: 'Payouts v2', threads: { n: 2, merged: 0 } }]);
  // A blocker keeps the time this Mac first saw it, so a fresh read does not restart Blocked's wait (PR-Agent r1 on #78).
  let kept: Record<string, number> = {};
  const again = (now: number, at: number, blockedAt: Record<string, number>) => {
    a.linear = [{ ...r, at, id: 'ENG-1', blockedBy: [{ id: 'ENG-2', title: 'Ledger', open: true }] }];
    return one(summarize(board, ['p'], 65536, { now, blockedAt, keepBlocked: (m) => { kept = m; } }).tickets, (t) => t.thread === 'a', 'a').blocked;
  };
  assert.deepEqual(again(10, 7, {}), [{ id: 'ENG-2', title: 'Ledger', at: 7 }]);
  assert.deepEqual(kept, { 'a|ENG-2': 7 });
  assert.deepEqual(again(50, 40, kept), [{ id: 'ENG-2', title: 'Ledger', at: 7 }], 'a re-read keeps the first time');
  assert.deepEqual(again(50, 40, { 'a|ENG-2': 99 }), [{ id: 'ENG-2', title: 'Ledger', at: 40 }], 'a time ahead of now is dropped');
  a.linear = [{ ...r, id: 'ENG-1' }];
  summarize(board, ['p'], 65536, { now: 60, blockedAt: { 'a|ENG-2': 7 }, keepBlocked: (m) => { kept = m; } });
  assert.deepEqual(kept, {}, 'unblocked: the time goes');
});

test('a feature\'s thread count is made before the summary drops tickets to fit (PR-Agent r1 on #78)', () => {
  const pid = 'ed93ef9c-3f61-4ee9-97e3-aa4a25b32da3';
  const threads = Array.from({ length: 30 }, (_, i) => T(`t${i}`, { title: 'x'.repeat(150) }));
  const board = buildBoard({ projects: [{ id: 'p', title: 'P' }], questions: new Map(), threads });
  for (const k of board.tickets) k.linear = [{ state: 'read', id: 'ENG-1', title: 't', status: null, statusType: null, url: null, assignee: null, at: 1, by: 'a', project: 'Payouts v2', projectId: pid }];
  const s = summarize(board, ['p'], 3000, { now: 10 });
  assert.ok(s.tickets.length < 30, 'the summary dropped tickets');
  assert.deepEqual(s.features.find((f) => f.id === pid)?.threads, { n: 30, merged: 0 });
});

test('a reader shows its Linear tickets beside its pull requests: a read one with its status, a named one "Not checked"', () => {
  const board = buildBoard({ projects: [{ id: 'p', title: 'P' }], questions: new Map(), threads: [T('a', { pullRequests: [pr(4, 'open')] })] });
  const k = only(board.tickets);
  k.linear = [
    { state: 'read', id: 'ENG-12', title: 'Fix <b>import</b>', status: 'In Progress', statusType: 'started', url: 'https://linear.app/acme/issue/ENG-12/fix', assignee: null, project: null, projectId: null, at: Date.now() - 3 * 3_600_000, by: 'a' },
    { state: 'not-checked', id: 'ENG-13', url: null },
  ];
  const html = renderApp({ board, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /<div class="pr-row"><a class="prc t-open"[^]*?<a class="prc lin" href="https:\/\/linear\.app\/acme\/issue\/ENG-12\/fix"[^>]*title="Fix &lt;b&gt;import&lt;\/b&gt;\. Read in T3 3 h ago\."><i><\/i>ENG-12<span>In Progress · 3 h ago<\/span>/);
  assert.match(html, /<span class="prc lin" title="No agent has read this ticket in T3 yet\."><i><\/i>ENG-13<span>Not checked<\/span><\/span>/);
});
