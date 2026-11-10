// Stage rules for T3 threads as tickets. Run: node --test client/board.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, shownPrs } from './board.mjs';

const T = (id, extra = {}) => ({ threadId: id, title: id, projectId: 'p', status: 'completed', latestRunId: 'r', updatedAt: '2026-11-06T12:00:00Z', pullRequests: [], ...extra });
const pr = (n, state) => ({ repository: 'o/r', number: n, state });
// Local times, so the calendar-day rule holds in any time zone (TZ=Asia/Tokyo included).
const place = (threads, questions = new Map()) => Object.fromEntries(buildBoard({ projects: [{ id: 'p', title: 'P' }], threads, questions, today: new Date(2026, 10, 6, 15) }).tickets.map((k) => [k.thread.threadId, k.place]));

test('a ticket is a top-level thread; its subagents are stations', () => {
  const b = buildBoard({ projects: [], threads: [T('a'), T('b', { parentThreadId: 'a' }), T('c', { parentThreadId: 'b' })], questions: new Map() });
  assert.equal(b.tickets.length, 1);
  assert.equal(b.tickets[0].stations, 2);
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
  assert.equal(b.tickets[0].place, 'Planned');
  assert.equal(b.tickets[0].atPass, true);
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

import { renderApp } from './board.mjs';
const link = (t) => `https://t3.example/env/${t.threadId}`;

test('an older Verified ticket leaves the board; one with work still running stays', () => {
  const b = buildBoard({ projects: [], questions: new Map(), today: new Date(2026, 10, 6, 12),
    threads: [T('old', { settled: true, settledAt: new Date(2026, 10, 1).toISOString() }),
      T('old-busy', { settled: true, settledAt: new Date(2026, 10, 1).toISOString() }), T('kid', { parentThreadId: 'old-busy', status: 'running' })] });
  assert.deepEqual(b.tickets.map((k) => [k.thread.threadId, k.place]), [['old-busy', 'In progress']]);
});

test('without a good poll the page says "not checked", never "all clear" or an older board', () => {
  const board = buildBoard({ projects: [], questions: new Map(), threads: [T('a', { status: 'running' })] });
  const html = renderApp({ board, project: null, link, status: { ok: false, error: 'T3 down', at: 0, ms: 0 }, origin: 'https://t3.example' });
  assert.match(html, /Not checked/);
  assert.doesNotMatch(html, /All clear/);
  assert.doesNotMatch(html, /data-thread="a"/);
});

test('project names are data, and counts follow the project filter', () => {
  const board = buildBoard({ projects: [{ id: 'x', title: '__proto__' }, { id: 'y', title: 'Y' }], questions: new Map(), today: new Date(2026, 10, 6, 12),
    threads: [T('a', { projectId: 'x' }), T('b', { projectId: 'y', settled: true, settledAt: new Date(2026, 10, 6, 9).toISOString() })] });
  const ok = { ok: true, at: 0, ms: 1 };
  assert.match(renderApp({ board, project: null, link, status: ok, origin: 'https://t3.example' }), /<span>__proto__<\/span><span class="n">1<\/span>/);
  assert.match(renderApp({ board, project: '__proto__', link, status: ok, origin: 'https://t3.example' }), /Verified today <b>0<\/b>/);
  assert.match(renderApp({ board, project: 'Y', link, status: ok, origin: 'https://t3.example' }), /Verified today <b>1<\/b>/);
});

test('the Pass orders by the oldest waiting question, and a failed poll shows no counts', () => {
  const board = buildBoard({ projects: [], questions: new Map(), threads: [
    T('new-parent', { updatedAt: '2026-11-06T14:00:00Z' }), T('old-ask', { parentThreadId: 'new-parent', status: 'waiting', updatedAt: '2026-11-06T08:00:00Z' }),
    T('mid', { status: 'waiting', updatedAt: '2026-11-06T10:00:00Z' })] });
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  const at = (id) => html.search(new RegExp(`call-tile mail" data-plate="[^"]+" data-thread="${id}"`));
  assert.ok(at('old-ask') >= 0 && at('old-ask') < at('mid'));
  const down = renderApp({ board, project: null, link, status: { ok: false, error: 'x', at: 0, ms: 0 }, origin: 'https://t3.example' });
  assert.match(down, /All projects<\/span><span class="n">not checked/);
});

test('without a good poll the counts read "not checked", not zero', () => {
  const board = buildBoard({ projects: [], questions: new Map(), threads: [] });
  const html = renderApp({ board, project: null, link, status: { ok: false, error: 'x', at: 0, ms: 0 }, origin: 'https://t3.example' });
  assert.match(html, /Active <b>not checked<\/b>/);
  assert.match(html, /aria-label="In progress: not checked"/);
});

test('the card shows the oldest waiting question when parent and station both ask', () => {
  const board = buildBoard({ projects: [], questions: new Map(), threads: [
    T('parent', { status: 'waiting', updatedAt: '2026-11-06T14:00:00Z' }), T('station', { parentThreadId: 'parent', status: 'waiting', updatedAt: '2026-11-06T09:00:00Z' })] });
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /call-tile mail" data-plate="[^"]+" data-thread="station"/);
});

test('a finished, unsettled ticket hands the turn back: it waits at the pass with the agent\'s last words', () => {
  const words = new Map([['done', 'Four items wait on your go.\n\n1. Post #2318.']]);
  const board = buildBoard({ projects: [], questions: new Map(), lastWords: words, threads: [
    T('done', { pullRequests: [pr(9, 'open')] }), T('busy', { status: 'running' }), T('settled', { settled: true, pullRequests: [pr(8, 'open')] })] });
  const by = Object.fromEntries(board.tickets.map((k) => [k.thread.threadId, k]));
  assert.equal(by.done.yourTurn, true);
  assert.equal(by.done.atPass, true);
  assert.equal(by.busy.atPass, false);
  assert.equal(by.settled.yourTurn, false);
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /chip c-blue">Your turn/);
  assert.match(html, /Four items wait on your go\./);
});

test('coordinator threads stay out of the stages, the pass and the On hold shelf (Dan, 2026-11-07: Yes Chef replaces them)', () => {
  const board = buildBoard({ projects: [], questions: new Map(), threads: [T('ATC 11-06', { pullRequests: [pr(1, 'open')] })] });
  assert.equal(board.tickets[0].place, 'Coordinators');
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.doesNotMatch(html, /Coordinators/);
  assert.match(html, /aria-label="In review: 0"/);
});

test('a ticket opens to its pull requests and stations, each linked out', () => {
  const board = buildBoard({ projects: [{ id: 'p', title: 'P', icon: '/icon/p' }], questions: new Map(), threads: [
    T('t', { status: 'running', pullRequests: [{ repository: 'o/r', number: 7, state: 'open', url: 'https://github.com/o/r/pull/7' }] }),
    T('s1', { parentThreadId: 't', status: 'running', title: 'Build the card', model: 'claude-opus-5-5' })] });
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /<article class="plate" id="p-[0-9a-f]{12}"/);
  assert.match(html, /href="https:\/\/github\.com\/o\/r\/pull\/7"/);
  assert.match(html, /href="https:\/\/t3\.example\/env\/s1"[^>]*>Build the card/);
  assert.match(html, /<img class="pm pimg" src="\/icon\/p"/);
});

test('agent messages: plain on the card, light formatting in the open ticket, T3 links named, nothing unescaped', () => {
  const words = new Map([['done', 'Merged **#2317** at `301206d` and told the [ATC](<t3-thread://v2/env/abc>).\n\n**Merge** <script>x</script>']]);
  const board = buildBoard({ projects: [], questions: new Map(), lastWords: words, threads: [T('done')] });
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /<span class="ct-pv">Merged #2317 at 301206d and told the ATC\./);
  assert.match(html, /<b>#2317<\/b> at <code>301206d<\/code>/);
  assert.doesNotMatch(html, /t3-thread:/);
  assert.doesNotMatch(html, /<script>x/);
});

test('a finished coordinator thread never shows at the pass', () => {
  const board = buildBoard({ projects: [], questions: new Map(), threads: [T('Expo 11-06')] });
  assert.equal(board.tickets[0].place, 'Coordinators');
  assert.equal(board.tickets[0].atPass, false);
});

test('an agent\'s "- " lines become a list in the open ticket, joined without blank lines', () => {
  const words = new Map([['done', 'Intro line.\n- first **bold**\n- second `code`\nAfter.']]);
  const board = buildBoard({ projects: [], questions: new Map(), lastWords: words, threads: [T('done')] });
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /Intro line\.<ul><li>first <b>bold<\/b><\/li><li>second <code>code<\/code><\/li><\/ul>After\./);
});

test('an agent\'s Markdown table becomes a table, escaped, and a lone pipe line stays text', () => {
  const words = new Map([['done', 'Queue:\n| # | PR | CI |\n|---|---|:--:|\n| 1 | #2330 <x> | **green** |\n| 2 | `#2346` | red |\nAfter.\n| not a table |']]);
  const board = buildBoard({ projects: [], questions: new Map(), lastWords: words, threads: [T('done')] });
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /Queue:<table class="md"><thead><tr><th>#<\/th><th>PR<\/th><th>CI<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>#2330 &lt;x&gt;<\/td><td><b>green<\/b><\/td><\/tr><tr><td>2<\/td><td><code>#2346<\/code><\/td><td>red<\/td><\/tr><\/tbody><\/table>After\./);
  assert.match(html, /After\.\n\| not a table \|/);
});

test('a question the ticket itself asks leads its sheet; a station\'s question keeps its name and link', () => {
  const qa = { id: 'q', requestId: 'r', question: 'Which?', options: [{ label: 'a', description: 'first' }] };
  const board = buildBoard({ projects: [], questions: new Map([['self', [qa]], ['st', [qa]]]), threads: [
    T('self', { status: 'running' }), T('parent'), T('st', { parentThreadId: 'parent', status: 'running', title: 'Station one' })] });
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  // The ticket's own question goes straight to the dock; a station's carries its name there and a link above.
  assert.match(html, /<p class="dock-k"><span class="chip c-blue">1 question<\/span><\/p><form class="act"[^>]*>(<input[^>]*>){3}<fieldset/);
  assert.match(html, /<b>Station one<\/b> is waiting on your answer\. <a href="https:\/\/t3\.example\/env\/st"/);
  assert.match(html, /<p class="dock-who">Station one asks<\/p>/);
  assert.match(html, /Hold and Settle come back once the question is answered\./);
});

test('a card labels each pull request by its number: two shown, the rest counted (Dan, 2026-11-08)', () => {
  const many = Array.from({ length: 8 }, (_, i) => pr(i + 1, i === 7 ? 'open' : 'merged'));
  const board = buildBoard({ projects: [], questions: new Map(), threads: [T('one', { pullRequests: [pr(1, 'open')] }), T('eight', { pullRequests: many })] });
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
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
  const at = (id) => board.tickets.find((k) => k.thread.threadId === id);
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
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
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
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
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
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /<form class="act q-car"/);
  assert.match(html, /<span class="q-pos" aria-live="polite">1 of 2<\/span>/);
  assert.match(html, /<fieldset class="q-set q-on"><legend>Which layout\?<\/legend>/);
  assert.match(html, /<fieldset class="q-set"><legend>Which day should it go out\?<\/legend>/);
  assert.equal((html.match(/data-qto=/g) || []).length, 2);
  // One question: no carousel.
  const one = buildBoard({ projects: [], questions: new Map([['ask', [q1]]]), threads: [T('ask', { status: 'running' })] });
  const h1 = renderApp({ board: one, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.doesNotMatch(h1, /q-car|q-nav|class="q-set q-on"/);
  assert.match(h1, /<fieldset class="q-set"><legend>Which layout\?<\/legend>/);
});

test('kitchen rules: a visual call with no screenshots shows the flag; with one, or with the rule off, it does not (Dan, 2026-11-08)', async () => {
  const { renderApp } = await import('./board.mjs');
  const { parseCalls, callKey } = await import('./calls.mjs');
  const text = (img) => `Done.\n\n1. Should the pill also show at the top of the location picker?${img}\n   - a. Yes.\n   - b. No.\n\n   Recommendation: a.`;
  const html = (img, rules) => {
    const calls = parseCalls(text(img));
    const words = { latest: { itemId: 'i', text: text(img) }, call: { key: callKey('i', calls), itemId: 'i', text: text(img), calls } };
    const board = buildBoard({ projects: [{ id: 'p', title: 'P' }], threads: [T('v')], questions: new Map(), lastWords: new Map([['v', words]]) });
    return renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example', rules });
  };
  assert.match(html('', null), /class="kr-flag"[^]*data-ask-shots="Send this call again/);
  assert.doesNotMatch(html('\n   ![a](/tmp/a.png)', null), /class="kr-flag"/);
  assert.doesNotMatch(html('', { all: { missing: 'off' } }), /class="kr-flag"/);
  assert.doesNotMatch(html('', { projects: { p: { screens: 'off' } } }), /class="kr-flag"/);
  // The shots came in a later message: the plate shows them, so no flag (PR-Agent r4 on #49).
  const calls = parseCalls(text(''));
  const later = { latest: { itemId: 'j', text: 'Here they are.\n\n![a](/tmp/a.png)' }, call: { key: callKey('i', calls), itemId: 'i', text: text(''), calls } };
  const b2 = buildBoard({ projects: [{ id: 'p', title: 'P' }], threads: [T('v')], questions: new Map(), lastWords: new Map([['v', later]]) });
  assert.doesNotMatch(renderApp({ board: b2, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example', rules: null }), /class="kr-flag"/);
});

test('kitchen rules pane: T3 Code-style rows, every project in Applies to, and the rules as safe JSON', async () => {
  const { kitchenPane } = await import('./board.mjs');
  const { normalize } = await import('./kitchen.mjs');
  const rules = normalize({ all: { notes: '</script><b>x' } });
  const h = kitchenPane({ rules, projects: [{ id: 'b', title: 'Beta' }, { id: 'a', title: '<Alpha>' }] });
  for (const k of ['screens', 'missing', 'form', 'reviewer', 'council', 'browser', 'tracker', 'notes']) assert.match(h, new RegExp(`data-kr="${k}"`));
  assert.match(h, /<option value="">All projects<\/option><option value="a">&lt;Alpha&gt;<\/option><option value="b">Beta<\/option>/);
  const json = h.match(/id="yc-rules">([^]*?)<\/script>/)[1];
  assert.doesNotMatch(json, /</);
  assert.equal(JSON.parse(json).all.notes, '</script><b>x');
});

test('each refresh carries the saved kitchen rules, as safe JSON, for a second window (PR-Agent r3 on #49)', async () => {
  const { renderApp } = await import('./board.mjs');
  const board = buildBoard({ projects: [], threads: [], questions: new Map() });
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example', rules: { all: { notes: '</script>x' }, projects: {} } });
  const json = html.match(/id="yc-rules-now">([^]*?)<\/script>/)[1];
  assert.doesNotMatch(json, /</);
  assert.equal(JSON.parse(json).all.notes, '</script>x');
  assert.doesNotMatch(renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' }), /yc-rules-now/);
});

test('PR-Agent r6 on #50: a closed pull request has its own dot, and the count adds every waiting question', () => {
  const q = (id, r) => ({ id, requestId: r, question: id + '?', options: [{ label: 'Yes' }, { label: 'No' }] });
  const board = buildBoard({ projects: [], questions: new Map([['parent', [q('p1', 'r1')]], ['station', [q('s1', 'r2')]]]), threads: [
    T('parent', { status: 'running', pullRequests: [pr(3, 'closed')] }), T('station', { parentThreadId: 'parent', status: 'running' })] });
  const html = renderApp({ board, project: null, link, status: { ok: true, at: 0, ms: 1 }, origin: 'https://t3.example' });
  assert.match(html, /class="lb th pr-closed"[^>]*><i><\/i>#3</);
  assert.doesNotMatch(html, /pr-merged[^>]*><i><\/i>#3</);
  assert.match(html, /<span class="chip c-blue">2 questions<\/span>/);
});
