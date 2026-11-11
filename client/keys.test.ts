import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { keysCore } from './keys.ts';
import type { KeyContext, KeyEntry, KeyEventLike, KeyState } from './keys.ts';
import { nodeSource } from './test/node-source.ts';

const K = keysCore(true);
/** A swap the test expects Settings to offer. */
const swap = (st: KeyState, id: string, key: string): KeyState => { const s = K.swap(st, id, key); assert.ok(s, `${id} takes ${key}`); return s; };
/** A clash with another command that holds the key. */
const taken = (st: KeyState, id: string, key: string) => { const c = K.clash(st, id, key); assert.ok(c && c.other !== undefined, `${key} is taken`); return c; };
/** A clash with a key no command may have here: reserved by the system, or fixed. */
const refused = (st: KeyState, id: string, key: string) => { const c = K.clash(st, id, key); assert.ok(c && c.other === undefined, `${key} is refused`); return c; };
/** The saved list, as Settings writes it. */
const entries = (st: KeyState) => K.toList(st) as KeyEntry[];
const ev = (key: string, o: KeyEventLike = {}): KeyEventLike => ({ key, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });

test('keys read as in T3 Code: mod, alt, shift, then the key', () => {
  assert.equal(K.norm('Cmd+Option+Shift+A'), 'mod+alt+shift+a');
  assert.equal(K.norm('shift+alt+mod+a'), 'mod+alt+shift+a');
  assert.equal(K.norm('ctrl+k'), 'mod+k');
  assert.equal(K.norm('esc'), 'escape');
  assert.equal(K.norm('mod++'), 'mod++');
  assert.equal(K.norm('shift+?'), '?', 'a sign carries its own Shift');
  assert.equal(K.norm('mod+ctrl+k'), null, 'mod twice');
  assert.equal(K.norm('mod+hyper+k'), null);
  assert.equal(K.norm('mod+kk'), null);
  assert.equal(K.norm(''), null);
  assert.equal(K.norm(7), null);
});

test('a keydown names its key; letters from the key, and from the physical key under ⌥', () => {
  assert.equal(K.comboOf(ev('k', { metaKey: true })), 'mod+k');
  assert.equal(K.comboOf(ev('k', { ctrlKey: true })), 'mod+k', 'Ctrl counts as mod, as the page always did');
  assert.equal(K.comboOf(ev('Å', { code: 'KeyA', metaKey: true, altKey: true, shiftKey: true })), 'mod+alt+shift+a');
  assert.equal(K.comboOf(ev('M', { code: 'KeyM', shiftKey: true })), 'shift+m');
  assert.equal(K.comboOf(ev('?', { code: 'Slash', shiftKey: true })), '?');
  assert.equal(K.comboOf(ev(' ', { code: 'Space', shiftKey: true })), 'shift+space');
  assert.equal(K.comboOf(ev('Enter', { metaKey: true })), 'mod+enter');
  assert.equal(K.comboOf(ev('ArrowUp')), 'arrowup');
  assert.equal(K.comboOf(ev('Shift', { shiftKey: true })), null, 'a modifier alone is not a key yet');
  assert.equal(K.comboOf(ev('Meta', { metaKey: true })), null);
  // Dvorak: the key says j where the physical key is C. The letter wins, as the page has always read it.
  assert.equal(K.comboOf(ev('j', { code: 'KeyC' })), 'j');
});

test('labels in a Mac menu order, and elsewhere with words', () => {
  assert.deepEqual(K.glyphs('mod+alt+shift+a'), ['⌥', '⇧', '⌘', 'A']);
  assert.equal(K.label('mod+enter'), '⌘↵');
  assert.equal(K.label('mod+,'), '⌘,');
  assert.equal(K.label('?'), '?');
  assert.equal(K.label('shift+space'), '⇧Space');
  assert.equal(keysCore(false).label('mod+alt+k'), 'Ctrl+Alt+K');
});

test('when: && and !, and a name the context lacks is false', () => {
  assert.equal(K.holds('', {}), true);
  assert.equal(K.holds('ticket', { ticket: true }), true);
  assert.equal(K.holds('ticket && !dialog', { ticket: true, dialog: true }), false);
  assert.equal(K.holds('!dialog', {}), true);
  assert.equal(K.holds('nothing', { ticket: true }), false);
  assert.equal(K.exclusive('ticket && dialog', '!dialog'), true);
  assert.equal(K.exclusive('ticket', '!dialog'), false);
  assert.equal(K.okWhen('a && !b.c'), true);
  assert.equal(K.okWhen('a || b'), false);
});

// The four places a key can be pressed, as route gets them.
const PLACES = [{ ticket: false, dialog: false }, { ticket: true, dialog: false }, { ticket: false, dialog: true }, { ticket: true, dialog: true }];
const runsAt = (st: KeyState, id: string, key: string) => PLACES.filter((p) => !(p.dialog && K.dialogKey(key)) && K.lookup(st, key, p) === id);
// Settings shows a key on a command exactly when the key runs that command somewhere.
const honest = (st: KeyState) => {
  for (const c of K.COMMANDS) for (const k of K.keysOf(st, c.id)) assert.ok(runsAt(st, c.id, k).length, `${c.id} shows ${k} but never runs it`);
  for (const r of st.rules) if (runsAt(st, r.id, r.key).length) assert.ok(K.keysOf(st, r.id).includes(r.key), `${r.id} runs ${r.key} but does not show it`);
};
// A command that always keeps a key runs one in every place outside a dialog where its own when holds.
const reachable = (st: KeyState) => {
  for (const c of K.COMMANDS.filter((x) => x.need)) {
    for (const p of PLACES.filter((x) => !x.dialog && K.holds(c.when || '', x))) {
      assert.ok(K.keysOf(st, c.id).some((k) => K.lookup(st, k, p) === c.id), `${c.id} has no key at ${JSON.stringify(p)}`);
    }
  }
};

test('no list: every key is its default, and nothing routes', () => {
  const st = K.build([]);
  assert.equal(st.changed, false);
  assert.deepEqual(K.toList(st), []);
  for (const [key, ctx] of [['m', { ticket: true }], ['mod+k', {}], ['mod+enter', {}], ['?', {}], ['mod+alt+shift+a', {}], ['mod+n', {}]] as [string, KeyContext][]) {
    assert.equal(K.route(st, key, ctx), null, key);
  }
  assert.deepEqual(K.keysOf(st, 'chat.new'), ['mod+t', 'mod+n']);
  honest(st);
});

test('every default, as T3 Code writes a new file, is the same as no list', () => {
  const list = K.defaultList();
  assert.equal(list.length, K.COMMANDS.reduce((n, c) => n + c.keys.length, 0));
  assert.deepEqual(list.slice(0, 3), [{ key: 'mod+k', command: 'commandPalette.toggle' }, { key: 'mod+t', command: 'chat.new' }, { key: 'mod+n', command: 'chat.new' }]);
  assert.deepEqual(list.find((e) => e.command === 'ticket.merge'), { key: 'm', command: 'ticket.merge', when: 'ticket' });
  const st = K.build(list);
  assert.deepEqual([st.changed, st.notes], [false, []]);
  assert.deepEqual(st.by, K.build([]).by);
  assert.deepEqual(K.toList(st), list);
});

test('T3 Code\'s merge: an entry replaces its command\'s defaults, and a command the list does not name keeps them', () => {
  const st = K.build([{ key: 'mod+y', command: 'chat.new' }]);
  assert.deepEqual(K.keysOf(st, 'chat.new'), ['mod+y'], 'not ⌘T, ⌘N and ⌘Y');
  assert.deepEqual(K.keysOf(st, 'settings.open'), ['mod+,']);
  assert.deepEqual(K.route(st, 'mod+n', {}), { off: 'chat.new' });
  assert.deepEqual(K.route(st, 'mod+y', {}), { as: 'mod+t', id: 'chat.new' });
  // Two entries for one command: it has both, and nothing else.
  assert.deepEqual(K.keysOf(K.build([{ key: 'mod+y', command: 'chat.new' }, { key: 'mod+n', command: 'chat.new' }]), 'chat.new'), ['mod+y', 'mod+n']);
  // An entry Yes Chef cannot use replaces nothing, as T3 Code ignores an invalid rule.
  assert.deepEqual(K.keysOf(K.build([{ key: 'mod+q', command: 'chat.new' }]), 'chat.new'), ['mod+t', 'mod+n']);
});

test('T3 Code\'s precedence: of the rules for a key whose whens hold, the last runs, whichever command it is', () => {
  // Merge on V: V merges with a ticket open, and still expands the view with none.
  const st = K.build([{ key: 'v', command: 'ticket.merge', when: 'ticket' }]);
  assert.deepEqual(K.route(st, 'v', { ticket: true }), { as: 'm', id: 'ticket.merge' });
  assert.equal(K.route(st, 'v', { ticket: false }), null);
  assert.deepEqual([K.keysOf(st, 'ticket.merge'), K.keysOf(st, 'view.toggle')], [['v'], ['v']]);
  honest(st);
  // The later of two entries for one key runs; the earlier never does, so Settings shows it nowhere.
  const b = K.build([{ key: 'q', command: 'ticket.hold', when: 'ticket' }, { key: 'q', command: 'ticket.reply', when: 'ticket' }]);
  assert.deepEqual([K.keysOf(b, 'ticket.hold'), K.keysOf(b, 'ticket.reply')], [[], ['q']]);
  assert.deepEqual(b.notes, []);
  honest(b);
  // Whens that never meet keep both.
  const c = K.build([{ key: 'q', command: 'view.you', when: '!ticket' }, { key: 'q', command: 'ticket.hold', when: 'ticket' }]);
  assert.deepEqual([K.keysOf(c, 'view.you'), K.keysOf(c, 'ticket.hold')], [['q'], ['q']]);
  honest(c);
  // An entry with no when applies everywhere, as in T3 Code: it is later than every default, so it wins R.
  const a = K.build([{ key: 'r', command: 'ticket.hold' }]);
  assert.deepEqual([K.keysOf(a, 'ticket.hold'), K.keysOf(a, 'ticket.reply')], [['r'], []]);
  assert.deepEqual(a.by['ticket.hold'], [{ key: 'r', when: '' }]);
  assert.deepEqual(K.route(a, 'r', { ticket: true }), { as: 'h', id: 'ticket.hold' });
  assert.deepEqual(K.route(a, 'h', { ticket: true }), { off: 'ticket.hold' });
  honest(a);
});

test('Swap them: Reply and Hold trade keys, each key routes to the other default, and the list round-trips', () => {
  const st0 = K.build([]);
  const c = taken(st0, 'ticket.reply', 'h');
  assert.equal(c.other, 'ticket.hold');
  assert.equal(c.text, 'H is already Hold until 8:00 tomorrow.');
  const st = swap(st0, 'ticket.reply', 'h');
  assert.deepEqual(K.keysOf(st, 'ticket.reply'), ['h']);
  assert.deepEqual(K.keysOf(st, 'ticket.hold'), ['r']);
  assert.deepEqual(K.route(st, 'h', { ticket: true }), { as: 'r', id: 'ticket.reply' });
  assert.deepEqual(K.route(st, 'r', { ticket: true }), { as: 'h', id: 'ticket.hold' });
  assert.equal(K.route(st, 'h', {}), null, 'no ticket: as before');
  const list = K.toList(st);
  assert.deepEqual(list, [{ key: 'h', command: 'ticket.reply', when: 'ticket' }, { key: 'r', command: 'ticket.hold', when: 'ticket' }]);
  const back = K.build(JSON.parse(JSON.stringify(list)));
  assert.deepEqual(back.by, st.by);
  assert.deepEqual([back.changed, back.notes], [true, []]);
  assert.equal(K.reset(K.reset(st, 'ticket.reply'), 'ticket.hold').changed, false);
});

test('Settings saves as T3 Code does: entries stay where they are, and a recorded key goes at the end', () => {
  const theirs = { key: 'mod+shift+t', command: 'terminal.split', args: { n: 2 } };
  const seeded = K.defaultList();
  seeded.splice(4, 0, theirs);
  const st = K.set(K.build(seeded), 'ticket.reply', 'g');
  const list = entries(st);
  assert.deepEqual(list[4], theirs, 'an entry for a command Yes Chef does not have stays in place, args too');
  assert.deepEqual(list.at(-1), { key: 'g', command: 'ticket.reply', when: 'ticket' });
  assert.equal(list.filter((e) => e.command === 'ticket.reply').length, 1, 'the old rule for Reply leaves');
  assert.equal(list.length, seeded.length);
  // A command with no when of its own is written with none.
  assert.deepEqual(K.toList(K.set(K.build([]), 'view.team', 'mod+shift+u')), [{ key: 'mod+shift+u', command: 'view.team' }]);
});

test('Take it: the other command\'s rule stays, and the later rule wins its key where both apply', () => {
  const st0 = K.build(K.defaultList());
  const c = taken(st0, 'thread.goto', 'h');
  assert.deepEqual([c.other, c.canTake, c.gives], ['ticket.hold', true, []]);
  const st = swap(st0, 'thread.goto', 'h');
  assert.deepEqual([K.keysOf(st, 'thread.goto'), K.keysOf(st, 'ticket.hold')], [['h'], []]);
  assert.ok(entries(st).some((e) => e.command === 'ticket.hold' && e.key === 'h'), 'Hold keeps its rule, which no longer runs');
  assert.deepEqual(K.route(st, 'h', { ticket: true }), { run: 'thread.goto' });
  honest(st);
  // Reset on the taker gives the key back to Hold: its rule runs again.
  const r = K.reset(st, 'thread.goto');
  assert.deepEqual([K.keysOf(r, 'thread.goto'), K.keysOf(r, 'ticket.hold')], [[], ['h']]);
  assert.equal(r.changed, false);
});

test('a moved default key is off where its command applies; elsewhere the page keeps it', () => {
  const st = K.set(K.build([]), 'ticket.merge', 'x');
  assert.deepEqual(K.route(st, 'x', { ticket: true }), { as: 'm', id: 'ticket.merge' });
  assert.deepEqual(K.route(st, 'm', { ticket: true }), { off: 'ticket.merge' });
  assert.equal(K.route(st, 'm', {}), null);
  // The suggested action applies outside dialogs only, so New thread keeps ⌘↵ for Launch.
  const s2 = K.set(K.build([]), 'ticket.suggested', 'mod+shift+enter');
  assert.deepEqual(K.route(s2, 'mod+enter', {}), { off: 'ticket.suggested' });
  assert.equal(K.route(s2, 'mod+enter', { dialog: true }), null);
  assert.deepEqual(K.route(s2, 'mod+shift+enter', {}), { as: 'mod+enter', id: 'ticket.suggested' });
  // A key the file gives another command, where that command's when holds, runs it instead.
  const v = K.build([{ key: 'm', command: 'view.you' }]);
  assert.deepEqual(K.route(v, 'm', { ticket: true }), { run: 'view.you' });
  assert.deepEqual(K.keysOf(v, 'ticket.merge'), []);
});

test('a command with no default key runs itself', () => {
  const st = K.set(K.build([]), 'view.team', 'mod+shift+u');
  assert.deepEqual(K.route(st, 'mod+shift+u', {}), { run: 'view.team' });
});

test('New thread: one recorded key replaces ⌘T and ⌘N', () => {
  const st = K.set(K.build([]), 'chat.new', 'mod+shift+o');
  assert.deepEqual(K.toList(st), [{ key: 'mod+shift+o', command: 'chat.new' }]);
  assert.deepEqual(K.route(st, 'mod+shift+o', {}), { as: 'mod+t', id: 'chat.new' });
  assert.deepEqual(K.route(st, 'mod+n', {}), { off: 'chat.new' });
});

test('clashes: the system, fixed keys, the send key needs ⌘ or ⌥, and only whens that can meet', () => {
  const st = K.build([]);
  assert.equal(refused(st, 'view.you', 'mod+q').reserved, true);
  assert.match(refused(st, 'view.you', 'mod+q').text, /^⌘Q belongs to macOS/);
  // Switching back is macOS's too: ⇧⌘Tab, and ⇧⌘` from a keydown or the file.
  assert.equal(refused(st, 'view.you', 'mod+shift+tab').reserved, true);
  assert.equal(refused(st, 'view.you', K.comboOf(ev('~', { code: 'Backquote', metaKey: true, shiftKey: true })) ?? '').reserved, true);
  assert.equal(refused(st, 'view.you', K.norm('mod+shift+' + String.fromCharCode(96)) ?? '').reserved, true);
  // From the file, a reserved key is named and not used, and replaces nothing: the Action bar keeps ⌘K.
  const back = K.build([{ key: 'mod+shift+tab', command: 'commandPalette.toggle' }]);
  assert.deepEqual(back.notes, ['Entry 1 is not used: ⇧⌘⇥ belongs to macOS.']);
  assert.deepEqual(K.keysOf(back, 'commandPalette.toggle'), ['mod+k']);
  // Logging out, the Dock, a Finder search and force quit are macOS's too.
  for (const k of ['mod+shift+q', 'mod+alt+shift+q', 'mod+alt+d', 'mod+alt+space', 'mod+alt+shift+escape']) {
    assert.equal(refused(st, 'view.you', k).reserved, true, k);
    const out = K.build([{ key: k, command: 'commandPalette.toggle' }]);
    assert.deepEqual(out.notes, ['Entry 1 is not used: ' + K.label(k) + ' belongs to macOS.'], k);
    assert.deepEqual(K.keysOf(out, 'commandPalette.toggle'), ['mod+k'], k);
  }
  assert.equal(K.label('mod+shift+q'), '⇧⌘Q');
  assert.equal(refused(st, 'ticket.reply', 'j').fixed, true);
  assert.match(refused(st, 'ticket.reply', 'mod+r').text, /refreshes Yes Chef/);
  assert.equal(refused(st, 'ticket.suggested', 'x').fixed, true);
  assert.equal(K.clash(st, 'ticket.suggested', 'alt+enter'), null);
  assert.equal(K.clash(st, 'view.you', 'y'), null);
  assert.equal(taken(st, 'view.you', 'm').other, 'ticket.merge', 'no when meets ticket');
  // The Action bar always has a key: a command with none cannot take ⌘K from it, only one with a key to trade.
  assert.equal(taken(st, 'view.you', 'mod+k').canTake, false);
  assert.equal(taken(st, 'settings.open', 'mod+k').canTake, true);
  // Whens that never meet do not clash.
  const custom = K.build([{ key: 'y', command: 'view.you', when: 'dialog' }]);
  assert.equal(K.clash(custom, 'ticket.suggested', 'y')?.other, undefined);
});

test('the file: entries Yes Chef cannot use are named, kept where they are, and replace nothing', () => {
  const list = [{ key: 'y', command: 'chat.newLocal' }, { key: 'mod+nope', command: 'ticket.hold' }, { command: '-ticket.merge' }, 'x', { key: 'g', command: 'ticket.hold', when: 'a || b' }];
  const st = K.build(list);
  assert.deepEqual(st.notes, [
    'Entry 1: chat.newLocal is not a Yes Chef command.',
    'Entry 2: “mod+nope” is not a key Yes Chef can read.',
    'Entry 3: -ticket.merge is not a Yes Chef command.',
    'Entry 4 has no command.',
    'Entry 5: Yes Chef cannot read its when.',
  ]);
  assert.deepEqual([K.keysOf(st, 'ticket.hold'), K.keysOf(st, 'ticket.merge')], [['h'], ['m']], 'T3 Code has no "-command"');
  assert.equal(st.changed, false);
  assert.deepEqual(K.toList(st), list);
  assert.match(K.build({}).notes[0] ?? '', /not a list/);
});

test('names from the file never reach Object\'s own names', () => {
  const st = K.build([{ key: 'x', command: 'constructor' }, { command: '-toString' }, { key: 'y', command: '__proto__' }, { key: 'z', command: 'hasOwnProperty' }]);
  assert.equal(st.list.length, 4);
  assert.equal(st.changed, false);
  assert.match(st.notes.join('\n'), /constructor is not a Yes Chef command/);
  assert.equal(K.norm('constructor+a'), null);
  assert.equal(K.norm('toString'), null);
  assert.equal(K.holds('constructor', {}), false);
  assert.equal(K.holds('!toString', {}), true);
  assert.equal(K.label('valueOf'), '');
});

test('the file: an entry Settings would refuse is named and skipped', () => {
  const st = K.build([{ key: 'j', command: 'ticket.hold' }, { key: 'mod+q', command: 'view.you' }, { key: 'r', command: 'ticket.suggested' }, { key: 'space', command: 'view.toggle' }]);
  assert.equal(st.changed, false);
  assert.deepEqual(st.notes, [
    'Entry 1 is not used: J moves to the next ticket and stays that way.',
    'Entry 2 is not used: ⌘Q belongs to macOS.',
    'Entry 3 is not used: The suggested action also works while you write a note, so its key needs ⌘ or ⌥.',
    'Entry 4 is not used: Space pages down the message and stays that way.',
  ]);
  assert.equal(K.route(st, 'j', { ticket: true }), null, 'J still moves on');
});

test('the file: a command that always keeps a key gets its default back after every rule, and says from whom', () => {
  const d = K.build([{ key: 'mod+k', command: 'view.you' }]);
  assert.deepEqual([K.keysOf(d, 'commandPalette.toggle'), K.keysOf(d, 'view.you')], [['mod+k'], []]);
  assert.deepEqual(d.notes, ['Action bar always has a key, so it keeps ⌘K, not View: You.']);
  assert.deepEqual(K.toList(d), [{ key: 'mod+k', command: 'view.you' }], 'the file stays as written');
  honest(d);
  // The Action bar on ⌘↵ takes the suggested action's key everywhere; both end with their own.
  const e = K.build([{ key: 'mod+enter', command: 'commandPalette.toggle' }]);
  assert.deepEqual([K.keysOf(e, 'commandPalette.toggle'), K.keysOf(e, 'ticket.suggested')], [['mod+k'], ['mod+enter']]);
  assert.deepEqual(e.notes, ['The suggested action always has a key, so it keeps ⌘↵, not Action bar.', 'Action bar always has a key, so it keeps ⌘K.']);
  honest(e);
  // A key that leaves the suggested action only where no ticket is open is not enough.
  const t = K.build([{ key: 'mod+enter', command: 'ticket.reply', when: 'ticket' }]);
  assert.deepEqual(K.lookup(t, 'mod+enter', { ticket: true }), 'ticket.suggested');
  assert.deepEqual(t.notes, ['The suggested action always has a key, so it keeps ⌘↵, not Reply.']);
  reachable(t);
});

test('the file: an entry whose when can never hold is skipped, and takes no key', () => {
  const st = K.build([{ key: 'v', command: 'view.you', when: 'ticket && !ticket' }]);
  assert.deepEqual([K.keysOf(st, 'view.toggle'), K.keysOf(st, 'view.you')], [['v'], []]);
  assert.deepEqual(st.notes, ['Entry 1 is not used: its when can never hold.']);
  assert.equal(st.changed, false);
});

test('Swap them gives the other command only keys it can have, and never leaves a must-have command without one', () => {
  const st = K.build([]);
  // Reply to ⌘↵: the suggested action cannot have R (it needs ⌘ or ⌥), and Reply's ⌘↵ with a ticket open would leave
  // it none there, so only Keep.
  const c = taken(st, 'ticket.reply', 'mod+enter');
  assert.equal(c.other, 'ticket.suggested');
  assert.equal(c.canTake, false);
  assert.equal(c.text, '⌘↵ is already The suggested action, which always keeps a key.');
  assert.equal(K.swap(st, 'ticket.reply', 'mod+enter'), null);
  // The Action bar to ⌘↵: ⌘K suits the suggested action, so they trade.
  const p = taken(st, 'commandPalette.toggle', 'mod+enter');
  assert.deepEqual([p.canTake, p.gives], [true, ['mod+k']]);
  const ps = swap(st, 'commandPalette.toggle', 'mod+enter');
  assert.deepEqual([K.keysOf(ps, 'commandPalette.toggle'), K.keysOf(ps, 'ticket.suggested')], [['mod+enter'], ['mod+k']]);
  honest(ps);
  reachable(ps);
  // A key id gives up that a third command has where the other applies stays with the third: Take it.
  const f = K.build([{ key: 'x', command: 'view.you', when: '!ticket' }, { key: 'o', command: 'ticket.open', when: 'ticket' }, { key: 'x', command: 'ticket.open', when: 'ticket' }]);
  const t = taken(f, 'view.you', 'v');
  assert.deepEqual([t.other, t.canTake, t.gives], ['view.toggle', true, []]);
  const ts = swap(f, 'view.you', 'v');
  assert.deepEqual([K.keysOf(ts, 'view.you'), K.keysOf(ts, 'view.toggle'), K.keysOf(ts, 'ticket.open')], [['v'], [], ['o', 'x']]);
  honest(ts);
  // Every pair of commands and every default key, from no list and from every default: a swap Settings offers runs
  // the key for its command wherever that command applies, shows only keys that run, and keeps every must-have key.
  for (const from of [[], K.defaultList()]) {
    const s0 = K.build(from);
    for (const a of K.COMMANDS) for (const b of K.COMMANDS) for (const k of b.keys) {
      if (a.id === b.id) continue;
      const cl = K.clash(s0, a.id, k);
      if (!cl || cl.other === undefined || !cl.canTake) continue;
      const s2 = swap(s0, a.id, k);
      for (const pl of PLACES.filter((x) => !(x.dialog && K.dialogKey(k)) && K.holds(a.when || '', x))) {
        assert.equal(K.lookup(s2, k, pl), a.id, `${a.id} ${k} at ${JSON.stringify(pl)}`);
      }
      honest(s2);
      reachable(s2);
      assert.deepEqual(s2.notes, [], `${a.id} ${k}`);
      for (const g of cl.gives) assert.equal(K.refuse(cl.other, g), null, `${cl.other} ${g}`);
    }
  }
});

test('Reset takes its keys back, and a command left with none gets its own back when they are free', () => {
  const sw = swap(K.build([]), 'ticket.reply', 'h');
  const r = K.reset(sw, 'ticket.reply');
  assert.deepEqual([K.keysOf(r, 'ticket.reply'), K.keysOf(r, 'ticket.hold')], [['r'], ['h']], 'Reset on one side undoes the swap');
  assert.equal(r.changed, false);
  // Hold's own H is taken, so Hold keeps no key rather than clash.
  const s2 = swap(sw, 'view.toggle', 'r');
  assert.deepEqual([K.keysOf(s2, 'view.toggle'), K.keysOf(s2, 'ticket.hold')], [['r'], ['v']]);
  // Reply takes R back where a ticket is open; with none, R still expands the view.
  const r2 = K.reset(s2, 'ticket.reply');
  assert.deepEqual([K.keysOf(r2, 'ticket.reply'), K.keysOf(r2, 'view.toggle'), K.keysOf(r2, 'ticket.hold')], [['r'], ['r'], ['v']]);
  assert.deepEqual([K.route(r2, 'r', { ticket: true }), K.route(r2, 'r', {})], [null, { as: 'v', id: 'view.toggle' }]);
  honest(r2);
  // A must-have command always gets its key back, and may in turn take one.
  const ps = swap(K.build([]), 'commandPalette.toggle', 'mod+enter');
  const r3 = K.reset(ps, 'ticket.suggested');
  assert.deepEqual([K.keysOf(r3, 'commandPalette.toggle'), K.keysOf(r3, 'ticket.suggested')], [['mod+k'], ['mod+enter']]);
  assert.deepEqual(r3.notes, []);
  honest(r3);
  reachable(r3);
});

test('a default key is off wherever its command applies, unless a key that holds there claims it', () => {
  const st = K.build([{ key: 'x', command: 'ticket.merge', when: '!ticket' }]);
  assert.deepEqual(K.route(st, 'm', { ticket: true }), { off: 'ticket.merge' }, 'on a ticket M never merges');
  assert.equal(K.route(st, 'm', { ticket: false }), null);
  assert.deepEqual(K.route(st, 'x', { ticket: false }), { as: 'm', id: 'ticket.merge' });
  const m = K.build([{ key: 'm', command: 'view.you', when: 'ticket' }]);
  assert.deepEqual(K.route(m, 'm', { ticket: true }), { run: 'view.you' });
});

test('a US sign written with Shift is the sign Shift types, in the file and from a keydown', () => {
  assert.equal(K.norm('shift+/'), '?');
  assert.equal(K.norm('alt+shift+/'), 'alt+?', 'never alt+/');
  assert.equal(K.norm('mod+shift+['), 'mod+{');
  assert.equal(K.norm('shift+='), '+');
  assert.equal(K.norm("shift+'"), '"');
  assert.equal(K.norm('shift+\\'), '|');
  assert.equal(K.norm('shift+' + String.fromCharCode(96)), '~');
  assert.equal(K.norm('shift+?'), '?');
  assert.equal(K.norm('shift+ä'), 'ä', 'a sign with no US Shift keeps its name, as before');
  // The file's alt+shift+/ is the key ⌥⇧/ names, and ⌥/ stays free.
  const st = K.build([{ key: 'alt+shift+/', command: 'ticket.suggested' }]);
  assert.deepEqual(st.notes, []);
  assert.ok(K.keysOf(st, 'ticket.suggested').includes('alt+?'));
  assert.deepEqual(K.route(st, K.comboOf(ev('¿', { code: 'Slash', altKey: true, shiftKey: true })), {}), { as: 'mod+enter', id: 'ticket.suggested' });
  const slash = K.route(st, K.comboOf(ev('÷', { code: 'Slash', altKey: true })), {});
  assert.ok(!slash || !('id' in slash) || slash.id !== 'ticket.suggested', '⌥/ is not the suggested action: ' + JSON.stringify(slash));
  // A sign as typed carries its own Shift: ⇧: types / on a French keyboard, and reads as /, not ?.
  assert.equal(K.comboOf(ev('/', { code: 'Period', shiftKey: true })), '/');
  assert.equal(K.comboOf(ev('?', { code: 'Slash', shiftKey: true, metaKey: true })), 'mod+?');
});

test('the file: a key a dialog keeps, with a when that needs a dialog, is skipped', () => {
  const st = K.build([{ key: 'y', command: 'commandPalette.toggle', when: 'dialog' }]);
  assert.deepEqual(st.notes, ['Entry 1 is not used: its when needs a dialog, and a dialog keeps Y for itself.']);
  assert.deepEqual(K.keysOf(st, 'commandPalette.toggle'), ['mod+k']);
  assert.deepEqual(K.build([{ key: 'mod+enter', command: 'view.you', when: 'dialog' }]).notes, ['Entry 1 is not used: its when needs a dialog, and a dialog keeps ⌘↵ for itself.']);
  // A key a dialog leaves alone works there, and a plain key may still say it is not for a dialog.
  const ok = K.build([{ key: 'mod+y', command: 'view.you', when: 'dialog' }, { key: 'y', command: 'view.team', when: '!dialog' }]);
  assert.deepEqual(ok.notes, []);
  assert.deepEqual([K.keysOf(ok, 'view.you'), K.keysOf(ok, 'view.team')], [['mod+y'], ['y']]);
  assert.deepEqual(K.route(ok, 'mod+y', { dialog: true }), { run: 'view.you' });
});

test('the file: a key that is not text is named and skipped, and never throws', () => {
  const odd = JSON.parse('[{"command":"ticket.hold","key":{"toString":null}},{"command":"ticket.hold","key":5},{"command":"ticket.hold"},{"command":"ticket.hold","key":"kk"}]');
  const st = K.build(odd);
  assert.deepEqual(st.notes, ['Entry 1: its key is not text.', 'Entry 2: its key is not text.', 'Entry 3 has no key.', 'Entry 4: “kk” is not a key Yes Chef can read.']);
  assert.deepEqual(K.keysOf(st, 'ticket.hold'), ['h']);
  assert.equal(st.changed, false);
});

test('off a Mac, AltGr types a character and is never a shortcut; on a Mac, ⌥ still reads', () => {
  const W = keysCore(false);
  const altGr = (on: boolean) => ({ getModifierState: (m: string) => on && m === 'AltGraph' });
  assert.equal(W.comboOf(ev('€', { code: 'KeyE', ctrlKey: true, altKey: true, ...altGr(true) })), null, 'AltGr+E is €');
  assert.equal(W.comboOf(ev('e', { code: 'KeyE', ctrlKey: true, altKey: true, ...altGr(false) })), 'mod+alt+e', 'Ctrl+Alt+E with no AltGr is a key');
  const st = W.build([{ key: 'mod+alt+e', command: 'ticket.suggested' }]);
  assert.equal(W.route(st, W.comboOf(ev('€', { code: 'KeyE', ctrlKey: true, altKey: true, ...altGr(true) })), { ticket: true }), null, '€ in a note never sends');
  assert.deepEqual(W.route(st, W.comboOf(ev('e', { code: 'KeyE', ctrlKey: true, altKey: true, ...altGr(false) })), { ticket: true }), { as: 'mod+enter', id: 'ticket.suggested' });
  assert.equal(K.comboOf(ev('´', { code: 'KeyE', altKey: true, metaKey: true, ...altGr(true) })), 'mod+alt+e', 'a Mac reads ⌥ as ⌥');
});

test('a sign under ⌥ reads as its US key, whatever the Mac types', () => {
  assert.equal(K.comboOf(ev('÷', { code: 'Slash', altKey: true })), 'alt+/');
  assert.equal(K.comboOf(ev('¿', { code: 'Slash', altKey: true, shiftKey: true })), 'alt+?');
  assert.equal(K.comboOf(ev('≠', { code: 'Equal', altKey: true })), 'alt+=');
  assert.equal(K.comboOf(ev('±', { code: 'Equal', altKey: true, shiftKey: true })), 'alt++');
  assert.equal(K.comboOf(ev('«', { code: 'Backslash', altKey: true })), 'alt+\\');
  assert.equal(K.comboOf(ev('Dead', { code: 'Backquote', altKey: true })), 'alt+`');
  assert.equal(K.comboOf(ev('æ', { code: 'Quote', altKey: true, metaKey: true })), "mod+alt+'");
  for (const k of ['alt+/', 'alt+?', 'alt+=', 'alt++', 'alt+\\', 'alt+`', "mod+alt+'"]) assert.equal(K.norm(k), k, k);
  const st = K.build([{ key: 'alt+/', command: 'ticket.suggested' }]);
  assert.deepEqual(K.route(st, K.comboOf(ev('÷', { code: 'Slash', altKey: true })), {}), { as: 'mod+enter', id: 'ticket.suggested' });
  // Without ⌥ a sign reads as typed, as before.
  assert.equal(K.comboOf(ev('/', { code: 'Slash' })), '/');
  assert.equal(K.comboOf(ev('Shift', { code: 'ShiftLeft', shiftKey: true, altKey: true })), null);
  assert.equal(K.comboOf(ev('Alt', { code: 'AltLeft', altKey: true })), null);
});

test('a Mac dead key under ⌥ reads as its physical key', () => {
  assert.equal(K.comboOf(ev('Dead', { code: 'KeyE', altKey: true })), 'alt+e');
  assert.equal(K.comboOf(ev('Dead', { code: 'KeyU', altKey: true, metaKey: true })), 'mod+alt+u');
  assert.equal(K.comboOf(ev('Dead', { code: 'KeyE' })), null, 'a dead key alone is not a key yet');
  assert.equal(K.comboOf(ev('Dead', { code: 'Quote', altKey: true })), "alt+'", 'a sign under ⌥ too');
  assert.equal(K.comboOf(ev('Dead', { code: 'Quote' })), null, 'a dead sign alone is not a key yet');
  const st = K.build([{ key: 'alt+e', command: 'ticket.suggested' }]);
  assert.deepEqual(K.route(st, K.comboOf(ev('Dead', { code: 'KeyE', altKey: true })), {}), { as: 'mod+enter', id: 'ticket.suggested' });
});

test('a shifted digit\'s sign reads as the keydown for it', () => {
  assert.equal(K.norm('!'), 'shift+1');
  assert.equal(K.norm('mod+shift+!'), 'mod+shift+1');
  assert.equal(K.norm(')'), 'shift+0');
  assert.equal(K.comboOf(ev('!', { code: 'Digit1', shiftKey: true })), K.norm('!'));
  assert.equal(K.comboOf(ev('!', { code: 'Digit1', shiftKey: true, metaKey: true })), K.norm('mod+!'));
  assert.equal(K.label('!'), '⇧1');
  const st = K.build([{ key: '!', command: 'view.you' }]);
  assert.deepEqual(K.route(st, K.comboOf(ev('!', { code: 'Digit1', shiftKey: true })), {}), { run: 'view.you' });
  // Other signs keep their own Shift, as before.
  assert.equal(K.norm('shift+_'), '_');
});

test('no when and an empty when both apply everywhere, as in T3 Code, and the file keeps what was written', () => {
  const list = [{ key: 'alt+enter', command: 'ticket.suggested', when: '' }, { key: 'y', command: 'view.you' }];
  const st = K.build(list);
  assert.deepEqual(st.by['ticket.suggested'], [{ key: 'alt+enter', when: '' }]);
  assert.deepEqual(st.by['view.you'], [{ key: 'y', when: '' }]);
  assert.deepEqual(K.toList(st), list);
  assert.deepEqual(K.build(JSON.parse(JSON.stringify(list))).by, st.by);
  // Settings writes a command's own when, as T3 Code writes a rule's: Hold applies on a ticket.
  assert.deepEqual(K.toList(K.set(K.build([]), 'ticket.hold', 'g')), [{ key: 'g', command: 'ticket.hold', when: 'ticket' }]);
});

test('an open dialog keeps plain keys and ⌘↵', () => {
  assert.equal(K.dialogKey('r'), true);
  assert.equal(K.dialogKey('shift+1'), true);
  assert.equal(K.dialogKey('mod+enter'), true);
  assert.equal(K.dialogKey('mod+k'), false);
  assert.equal(K.dialogKey('mod+shift+enter'), false);
  assert.equal(K.dialogKey('alt+enter'), false);
});

test('a stand-in keydown is what the page handler reads for that key', () => {
  let stopped = 0;
  const real = { repeat: false, target: 'T', preventDefault: () => { stopped++; } };
  const a = K.synth('mod+alt+shift+a', real);
  assert.deepEqual([a.key, a.code, a.metaKey, a.ctrlKey, a.altKey, a.shiftKey, a.synthetic, a.target], ['A', 'KeyA', true, false, true, true, true, 'T']);
  a.preventDefault();
  assert.equal(stopped, 1);
  assert.deepEqual([K.synth('mod+enter', real).key, K.synth('?', real).key, K.synth('r', real).key, K.synth('space', real).key], ['Enter', '?', 'r', ' ']);
  assert.equal(keysCore(false).synth('mod+k', real).ctrlKey, true);
  // The handler's own reading of the stand-in gives back the same key.
  for (const c of ['mod+alt+shift+a', 'mod+enter', '?', 'r', 'mod+,', 'shift+space']) assert.equal(K.comboOf(K.synth(c, real)), c);
});

test('every default key is valid, unique where whens meet, and none is reserved or fixed', () => {
  const st = K.build([]);
  for (const c of K.COMMANDS) {
    for (const k of c.keys) {
      assert.equal(K.norm(k), k, `${c.id} ${k}`);
      assert.equal(K.clash(st, c.id, k), null, `${c.id} ${k}`);
    }
  }
});

test('the source inlines into a page script', () => {
  // The source text the page inlines, as Node gives it (client/test/node-source.ts).
  const src = nodeSource(new URL('./keys.ts', import.meta.url), 'keysCore');
  assert.equal(/<\/script/i.test(src), false);
  assert.equal(/=>|\blet\b|\bconst\b|`[^']/.test(src), false, 'ES5 only: no arrows, let, const or template literals');
});
