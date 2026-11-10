// The ⌘K action bar's pure parts, and the rules that let the page inline it. Run: node --test client/bar.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { BAR_CSS, BAR_HTML, SPRING, barCore, installBar } from './bar.mjs';

const core = barCore();

test('every word typed must appear in the row, in any case and any order', () => {
  assert.equal(core.match('dens comp', 'Density: Compact Titles only'), true);
  assert.equal(core.match('COMPACT density', 'Density: Compact'), true);
  assert.equal(core.match('dens cozy', 'Density: Compact'), false);
  assert.equal(core.match('   ', 'anything'), true);
  const rows = [{ t: 'New thread in T3 Code', d: 'Also ⌘N', g: 'Threads', kw: 'launch start' }, { t: 'Rules', g: 'Settings', kw: 'brief reviewer' }, { t: 'x', hay: 'only the hay counts' }];
  assert.deepEqual(core.filter(rows, 'launch').map((r) => r.t), ['New thread in T3 Code']);
  assert.deepEqual(core.filter(rows, 'settings').map((r) => r.t), ['Rules']);
  assert.deepEqual(core.filter(rows, 'hay').map((r) => r.t), ['x']);
  assert.deepEqual(core.filter(rows, 'x').map((r) => r.t), []);
});

test('a step\'s choice shows at the top once a typed word starts its name', () => {
  const hay = 'Change appearance: Dark mode theme';
  assert.equal(core.nestedHit('dark', hay, 'Dark'), true);
  assert.equal(core.nestedHit('appearance da', hay, 'Dark'), true);
  assert.equal(core.nestedHit('DARK', hay, 'Dark'), true);
  assert.equal(core.nestedHit('appearance', hay, 'Dark'), false, 'the step\'s own name finds the step, not every choice');
  assert.equal(core.nestedHit('ark', hay, 'Dark'), false, 'inside a word is not enough');
  assert.equal(core.nestedHit('dark sepia', hay, 'Dark'), false, 'every word must still match');
  assert.equal(core.nestedHit('  ', hay, 'Dark'), false);
});

test('in a step, a typed name puts its own choice first: keep holds the group order only, never the rows\' order', () => {
  const step = [
    { t: 'System', d: 'Light or dark, as your Mac is set', g: 'Appearance', kw: 'mode theme' },
    { t: 'Light', d: 'Always light', g: 'Appearance', kw: 'mode theme' },
    { t: 'Dark', d: 'Always dark', g: 'Appearance', kw: 'mode theme' },
  ];
  assert.deepEqual(core.filter(step, 'dark', true).map((r) => r.t), ['Dark', 'System']);
  assert.deepEqual(core.filter(step, 'light', true).map((r) => r.t), ['Light', 'System']);
  assert.deepEqual(core.filter(step, '', true).map((r) => r.t), ['System', 'Light', 'Dark'], 'empty: the step\'s own order');
});

test('recent actions: newest first, no copies, five at most, malformed entries dropped', () => {
  let l = [];
  for (let i = 1; i <= 7; i++) l = core.pushRecent(l, 'a' + i, 'Action ' + i, i);
  assert.deepEqual(l.map((r) => r.id), ['a7', 'a6', 'a5', 'a4', 'a3']);
  l = core.pushRecent(l, 'a5', 'Action 5 again', 9);
  assert.deepEqual(l.map((r) => r.id), ['a5', 'a7', 'a6', 'a4', 'a3']);
  assert.equal(l[0].t, 'Action 5 again');
  assert.equal(l[0].f, core.fp('Action 5 again'));
  const raw = JSON.stringify([{ id: 'ok', t: 'Fine', at: 1 }, { id: '', t: 'x', at: 1 }, { id: 'n', t: 'x' }, null, 'junk', { id: 'y', t: 'Also fine', at: 2 }]);
  assert.deepEqual(core.readRecent(raw), [{ id: 'ok', t: 'Fine', at: 1 }, { id: 'y', t: 'Also fine', at: 2 }]);
  assert.deepEqual(core.readRecent('{not json'), []);
  assert.deepEqual(core.readRecent('{"id":"x"}'), []);
  assert.deepEqual(core.readRecent(null), []);
});

test('the last note\'s thread reads back only when whole', () => {
  assert.deepEqual(core.readNoted('{"id":"YC-1","at":5}'), { id: 'YC-1', at: 5 });
  assert.equal(core.readNoted('{"id":"YC-1"}'), null);
  assert.equal(core.readNoted('nope'), null);
  assert.equal(core.readNoted(null), null);
});

test('ages read like Mail', () => {
  const now = 1_000_000_000;
  assert.equal(core.ago(now - 5_000, now), 'Just now');
  assert.equal(core.ago(now + 5_000, now), 'Just now');
  assert.equal(core.ago(now - 4 * 60_000, now), '4 min ago');
  assert.equal(core.ago(now - 3 * 3_600_000, now), '3 h ago');
  assert.equal(core.ago(now - 30 * 3_600_000, now), 'Yesterday');
  assert.equal(core.ago(now - 3 * 86_400_000, now), '3 days ago');
});

test('the next in The Pass is the one after the open ticket, else the first other one', () => {
  assert.equal(core.after(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(core.after(['a', 'b', 'c'], 'c'), 'a');
  assert.equal(core.after(['a', 'b', 'c'], null), 'a');
  assert.equal(core.after(['a'], 'a'), null);
  assert.equal(core.after([], null), null);
});

test('View: You and View: Your team show only to a user with reports, once the app can switch', () => {
  const v = { hasReports: true, current: 'team', team: { name: 'Lantern', below: 14 } };
  assert.deepEqual(core.viewRows(v, false), []);
  assert.deepEqual(core.viewRows({ ...v, hasReports: false }, true), []);
  assert.deepEqual(core.viewRows({ ...v, hasReports: 'yes' }, true), []);
  assert.deepEqual(core.viewRows(null, true), []);
  const rows = core.viewRows(v, true);
  assert.deepEqual(rows.map((r) => [r.t, r.now]), [['View: You', false], ['View: Your team', true]]);
  assert.equal(rows[1].d, 'Lantern, 14 people below you');
  for (const w of ['switch', 'team', 'me', 'mine', 'solo', 'lead', 'reports', 'scope']) assert.equal(core.filter(rows, w).length, 2, w);
  assert.equal(core.viewRows({ ...v, team: { name: 'Solo', below: 1 } }, true)[1].d, 'Solo, 1 person below you');
  // Nothing is guessed: a missing name or count says so.
  assert.equal(core.viewRows({ hasReports: true, current: 'you' }, true)[1].d, 'Team name not checked, people below you not checked');
});

test('barCore and installBar stand alone, so the page can inline their source text', () => {
  // A fresh context with no module scope: barCore must run on its own.
  const ctx = vm.createContext({});
  const c = vm.runInContext(`(${barCore})()`, ctx);
  assert.equal(c.MAX, 5);
  assert.equal(c.SINK_MS, 250);
  assert.equal(c.COUNT_MS, 5000);
  // installBar returns null without its dialog, and names nothing from this module.
  const doc = { getElementById: () => null };
  const ib = vm.runInContext(`(${installBar})`, vm.createContext({ document: doc }));
  assert.equal(ib({ $: () => null, $$: () => [] }, c), null);
  for (const name of ['BAR_CSS', 'BAR_HTML', 'SPRING', 'ICONS', 'barCore']) assert.equal(String(installBar).includes(name), false, name);
  // The source text goes inside the page's <script> element, so it must not close it.
  for (const src of [String(barCore), String(installBar)]) assert.equal(/<\/script/i.test(src), false);
});

test('the motion is Apple\'s default spring: 0.5 s, no bounce, as 735 ms of linear()', () => {
  assert.match(BAR_CSS, /--cb-dur:735ms/);
  assert.ok(BAR_CSS.includes(SPRING));
  assert.match(SPRING, /^linear\(0, 0\.0575, .* 0\.9986, 1\)$/);
  assert.match(BAR_CSS, /--cb-lead:150ms;--cb-stag:40ms/);
  assert.match(BAR_CSS, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(BAR_HTML, /<dialog id="bar"/);
  assert.match(BAR_HTML, /role="combobox"/);
  assert.match(BAR_HTML, /<symbol id="cb-search"/);
});

test('matches rank by the title inside each group; the groups keep their order', () => {
  const rows = [
    { g: 'This ticket', t: 'Pick a: Merge', d: 'Recommended by the agent' },
    { g: 'This ticket', t: 'Pick b: Request changes' },
    { g: 'Settings', t: 'Rules', kw: 'brief' },
    { g: 'Settings', t: 'Settings' },
    { g: 'Threads', t: 'Settings sync', d: 'Fernpay' },
  ];
  assert.deepEqual(core.filter(rows, 'pick b').map((r) => r.t), ['Pick b: Request changes', 'Pick a: Merge']);
  assert.deepEqual(core.filter(rows, 'settings').map((r) => r.t), ['Settings', 'Rules', 'Settings sync']);
  assert.ok(core.score('dens', 'Density: Compact') > core.score('dens', 'Condensed'));
  assert.deepEqual(core.filter(rows, '').map((r) => r.t), rows.map((r) => r.t));
});

test('a ticket action names the hand-back it answers, so a saved one never runs on a newer hand-back', () => {
  assert.equal(core.tkId('p-1', 'e76d005b5d4465cd', 0, 'primary'), 'tk:p-1:e76d005b5d4465cd:0:primary');
  assert.notEqual(core.tkId('p-1', 'call-a', 0, 'primary'), core.tkId('p-1', 'call-b', 0, 'primary'));
  // The id splits the same way whatever the hand-back's id holds.
  const id = core.tkId('p-1', 'req:7/x', 1, 'pick:0:b');
  assert.deepEqual(id.split(':').slice(0, 4), ['tk', 'p-1', 'req%3A7%2Fx', '1']);
  assert.equal(id.split(':')[4], 'pick');
  assert.equal(core.tkId('p-1', '', 0, 'go'), 'tk:p-1:-:0:go');
});

test('the rows stop clipping once the last one has popped in', () => {
  const lead = +/--cb-lead:(\d+)ms/.exec(BAR_CSS)[1], stag = +/--cb-stag:(\d+)ms/.exec(BAR_CSS)[1], dur = +/--cb-dur:(\d+)ms/.exec(BAR_CSS)[1];
  for (const n of [1, 4, 9]) assert.equal(core.popEnd(n), lead + (n - 1) * stag + dur);
  assert.equal(core.popEnd(0), lead + dur);
});

test('a saved label cut to 200 characters still compares in full, by its fingerprint', () => {
  const long = 'Send a: ' + 'keep the token in the Keychain, one item per user, '.repeat(6) + '· Push token store';
  assert.ok(long.length > 200);
  const [saved] = core.readRecent(JSON.stringify(core.pushRecent([], 'tk:p-1:k:0:primary', long, 1)));
  assert.equal(saved.t.length, 200);
  assert.equal(saved.f, core.fp(long));
  assert.notEqual(core.fp(long), core.fp(long.replace('Send a', 'Send b')));
  assert.notEqual(core.fp(long), core.fp(long + ' '));
  assert.equal(core.fp(''), '811c9dc5');
  // An entry saved before fingerprints reads back without one.
  assert.deepEqual(core.readRecent('[{"id":"x","t":"X","at":1}]'), [{ id: 'x', t: 'X', at: 1 }]);
  assert.deepEqual(core.readRecent('[{"id":"x","t":"X","at":1,"f":7}]'), [{ id: 'x', t: 'X', at: 1 }]);
});

test('a ticket action takes its name from the button\'s tooltip, so the icon-only Hold and Settle are named (#72)', () => {
  // The Gmail-style bar (Dan, 2026-11-10) gives Hold and Settle no word, and calls Request changes "Changes" on the
  // button only. The tooltip's name, up to ": ", keeps the full words: "Hold until 8:00 tomorrow" (not "Hold until 8"),
  // "Settle", "Request changes", "Merge".
  const src = String(installBar);
  const m = /label = (\(txt\(\$\('\.tn', b\)\) \|\| txt\(\$\('\.bl', b\)\)\)\.split\(': '\)\[0\])/.exec(src);
  assert.ok(m, 'the label reads the tooltip name first');
  const name = (tn) => tn.split(': ')[0];
  assert.equal(name('Hold until 8:00 tomorrow'), 'Hold until 8:00 tomorrow');
  assert.equal(name('Settle: it leaves the pass'), 'Settle');
  assert.equal(name('Request changes: say what to fix'), 'Request changes');
  // Hold's line, "Until 8:00 tomorrow", is in its name already, so the row drops it.
  assert.match(src, /if \(d && label\.toLowerCase\(\)\.indexOf\(d\.toLowerCase\(\)\) >= 0\) d = '';/);
});

test('Send a note lists the threads that take a note first, then the rest with their reason', () => {
  const all = [{ id: 'a', t: 'A' }, { id: 'b', t: 'B' }, { id: 'c', t: 'C' }, { id: 'd', t: 'D' }];
  const why = { b: 'A question waits on it. Answer it in the ticket first.', d: 'A send to it is waiting out its Undo' };
  const out = core.notePick(all, (id) => why[id]);
  assert.deepEqual(out.map((x) => x.k.id), ['a', 'c', 'b', 'd']);
  assert.deepEqual(out.map((x) => x.why), ['', '', why.b, why.d]);
  assert.deepEqual(core.notePick([], () => ''), []);
});

test('a group whose best row answers the words better comes first; a step keeps its groups in order', () => {
  const rows = [
    { g: 'This ticket', t: 'Note', d: 'Add a note to the next send' },
    { g: 'This ticket', t: 'Reply', d: 'Write a note, then ⌘↵' },
    { g: 'Threads', t: 'Send a note to a thread…', d: 'Pick any thread, write, send' },
  ];
  assert.deepEqual(core.filter(rows, 'send a note').map((r) => r.t), ['Send a note to a thread…', 'Note']);
  // On a tie, the open ticket's actions lead.
  assert.deepEqual(core.filter(rows, 'note').map((r) => r.t), ['Note', 'Reply', 'Send a note to a thread…']);
  const step = [{ g: 'Pick a thread', t: 'Search index' }, { g: 'Takes no note now', t: 'Search by phone' }];
  assert.deepEqual(core.filter(step, 'search by phone').map((r) => r.t), ['Search by phone']);
  assert.deepEqual(core.filter(step, 'search', true).map((r) => r.t), ['Search index', 'Search by phone']);
  assert.deepEqual(core.filter([...step].reverse(), 'search by', true).map((r) => r.t), ['Search by phone']);
});
