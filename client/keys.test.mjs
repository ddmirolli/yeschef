import test from 'node:test';
import assert from 'node:assert/strict';
import { keysCore } from './keys.mjs';

const K = keysCore(true);
const ev = (key, o = {}) => ({ key, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });

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

test('no list: every key is its default, and nothing routes', () => {
  const st = K.build([]);
  assert.equal(st.changed, false);
  assert.deepEqual(K.toList(st), []);
  for (const [key, ctx] of [['m', { ticket: true }], ['mod+k', {}], ['mod+enter', {}], ['?', {}], ['mod+alt+shift+a', {}], ['mod+n', {}]]) {
    assert.equal(K.route(st, key, ctx), null, key);
  }
  assert.deepEqual(K.keysOf(st, 'chat.new'), ['mod+t', 'mod+n']);
});

test('Swap them: Reply and Hold trade keys, each key routes to the other default, and the list round-trips', () => {
  const st0 = K.build([]);
  const c = K.clash(st0, 'ticket.reply', 'h');
  assert.equal(c.other, 'ticket.hold');
  assert.equal(c.text, 'H is already Hold until 8:00 tomorrow.');
  const st = K.swap(st0, 'ticket.reply', 'h', 'ticket.hold');
  assert.deepEqual(K.keysOf(st, 'ticket.reply'), ['h']);
  assert.deepEqual(K.keysOf(st, 'ticket.hold'), ['r']);
  assert.deepEqual(K.route(st, 'h', { ticket: true }), { as: 'r', id: 'ticket.reply' });
  assert.deepEqual(K.route(st, 'r', { ticket: true }), { as: 'h', id: 'ticket.hold' });
  assert.equal(K.route(st, 'h', {}), null, 'no ticket: as before');
  const list = K.toList(st);
  assert.deepEqual(list, [
    { key: 'r', command: '-ticket.reply', when: 'ticket' }, { key: 'h', command: 'ticket.reply', when: 'ticket' },
    { key: 'h', command: '-ticket.hold', when: 'ticket' }, { key: 'r', command: 'ticket.hold', when: 'ticket' },
  ]);
  const back = K.build(JSON.parse(JSON.stringify(list)));
  assert.deepEqual(back.by, st.by);
  assert.equal(back.changed, true);
  assert.equal(K.build(K.toList(K.reset(K.reset(st, 'ticket.reply'), 'ticket.hold'))).changed, false);
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
});

test('a command with no default key runs itself', () => {
  const st = K.set(K.build([]), 'view.team', 'mod+shift+u');
  assert.deepEqual(K.route(st, 'mod+shift+u', {}), { run: 'view.team' });
  assert.deepEqual(K.toList(st), [{ key: 'mod+shift+u', command: 'view.team' }]);
});

test('New thread: one recorded key replaces ⌘T and ⌘N', () => {
  const st = K.set(K.build([]), 'chat.new', 'mod+shift+o');
  assert.deepEqual(K.toList(st), [{ key: 'mod+t', command: '-chat.new' }, { key: 'mod+n', command: '-chat.new' }, { key: 'mod+shift+o', command: 'chat.new' }]);
  assert.deepEqual(K.route(st, 'mod+shift+o', {}), { as: 'mod+t', id: 'chat.new' });
  assert.deepEqual(K.route(st, 'mod+n', {}), { off: 'chat.new' });
});

test('clashes: the system, fixed keys, the send key needs ⌘ or ⌥, and only whens that can meet', () => {
  const st = K.build([]);
  assert.equal(K.clash(st, 'view.you', 'mod+q').reserved, true);
  assert.match(K.clash(st, 'view.you', 'mod+q').text, /^⌘Q belongs to macOS/);
  // Switching back is macOS's too: ⇧⌘Tab, and ⇧⌘` from a keydown or the file.
  assert.equal(K.clash(st, 'view.you', 'mod+shift+tab').reserved, true);
  assert.equal(K.clash(st, 'view.you', K.comboOf(ev('~', { code: 'Backquote', metaKey: true, shiftKey: true }))).reserved, true);
  assert.equal(K.clash(st, 'view.you', K.norm('mod+shift+' + String.fromCharCode(96))).reserved, true);
  const back = K.build([{ key: 'mod+k', command: '-commandPalette.toggle' }, { key: 'mod+shift+tab', command: 'commandPalette.toggle' }]);
  assert.deepEqual(back.notes, ['Entry 2 is not used: ⇧⌘⇥ belongs to macOS.', 'Action bar always has a key, so it keeps ⌘K.']);
  assert.deepEqual(K.keysOf(back, 'commandPalette.toggle'), ['mod+k']);
  // Logging out, the Dock, a Finder search and force quit are macOS's too, and the Action bar keeps ⌘K.
  for (const k of ['mod+shift+q', 'mod+alt+shift+q', 'mod+alt+d', 'mod+alt+space', 'mod+alt+shift+escape']) {
    assert.equal(K.clash(st, 'view.you', k).reserved, true, k);
    const out = K.build([{ command: '-commandPalette.toggle' }, { key: k, command: 'commandPalette.toggle' }]);
    assert.deepEqual(out.notes, ['Entry 2 is not used: ' + K.label(k) + ' belongs to macOS.', 'Action bar always has a key, so it keeps ⌘K.'], k);
    assert.deepEqual(K.keysOf(out, 'commandPalette.toggle'), ['mod+k'], k);
  }
  assert.equal(K.label('mod+shift+q'), '⇧⌘Q');
  assert.equal(K.clash(st, 'ticket.reply', 'j').fixed, true);
  assert.match(K.clash(st, 'ticket.reply', 'mod+r').text, /refreshes Yes Chef/);
  assert.equal(K.clash(st, 'ticket.suggested', 'x').fixed, true);
  assert.equal(K.clash(st, 'ticket.suggested', 'alt+enter'), null);
  assert.equal(K.clash(st, 'view.you', 'y'), null);
  assert.equal(K.clash(st, 'view.you', 'm').other, 'ticket.merge', 'no when meets ticket');
  // The Action bar always has a key: a command with none cannot take ⌘K from it, only one with a key to trade.
  assert.equal(K.clash(st, 'view.you', 'mod+k').canTake, false);
  assert.equal(K.clash(st, 'settings.open', 'mod+k').canTake, true);
  // Whens that never meet do not clash.
  const custom = K.build([{ key: 'y', command: 'view.you', when: 'dialog' }]);
  assert.equal(K.clash(custom, 'ticket.suggested', 'y') && K.clash(custom, 'ticket.suggested', 'y').other, undefined);
});

test('the file: unknown commands are kept, bad entries are named, a command that needs a key keeps one', () => {
  const st = K.build([{ key: 'y', command: 'chat.newLocal' }, { key: 'mod+nope', command: 'ticket.hold' }, { command: '-commandPalette.toggle' }, 'x', { key: 'g', command: 'ticket.hold', when: 'a || b' }]);
  assert.deepEqual(st.extra, [{ key: 'y', command: 'chat.newLocal' }]);
  assert.deepEqual(K.keysOf(st, 'commandPalette.toggle'), ['mod+k']);
  assert.equal(st.notes.length, 5);
  assert.match(st.notes.join('\n'), /chat\.newLocal is not a Yes Chef command/);
  assert.match(st.notes.join('\n'), /Action bar always has a key/);
  assert.deepEqual(K.toList(st), [{ key: 'y', command: 'chat.newLocal' }]);
  assert.match(K.build({}).notes[0], /not a list/);
  // A key added with no when takes its command's.
  assert.deepEqual(K.build([{ key: 'shift+h', command: 'ticket.hold' }]).by['ticket.hold'], [{ key: 'h', when: 'ticket' }, { key: 'shift+h', when: 'ticket' }]);
  // "-command" with no key takes every key away.
  assert.deepEqual(K.keysOf(K.build([{ command: '-ticket.hold' }]), 'ticket.hold'), []);
});

// No key belongs to two commands where both can apply.
const noClash = (st) => {
  for (const a of K.COMMANDS) for (const b of K.COMMANDS) {
    if (a.id >= b.id) continue;
    for (const x of st.by[a.id]) for (const y of st.by[b.id]) {
      assert.ok(x.key !== y.key || K.exclusive(x.when, y.when), `${x.key} is both ${a.id} and ${b.id}`);
    }
  }
};

test('names from the file never reach Object\'s own names', () => {
  const st = K.build([{ key: 'x', command: 'constructor' }, { command: '-toString' }, { key: 'y', command: '__proto__' }, { key: 'z', command: 'hasOwnProperty' }]);
  assert.equal(st.extra.length, 4);
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

test('the file: a key two commands have goes to the later entry, and an entry beats a default', () => {
  const a = K.build([{ key: 'r', command: 'ticket.hold' }]);
  assert.deepEqual(K.keysOf(a, 'ticket.hold'), ['h', 'r']);
  assert.deepEqual(K.keysOf(a, 'ticket.reply'), []);
  assert.deepEqual(a.notes, []);
  assert.deepEqual(K.route(a, 'r', { ticket: true }), { as: 'h', id: 'ticket.hold' });
  noClash(a);
  const b = K.build([{ key: 'q', command: 'ticket.hold' }, { key: 'q', command: 'ticket.reply' }]);
  assert.deepEqual(K.keysOf(b, 'ticket.hold'), ['h']);
  assert.deepEqual(K.keysOf(b, 'ticket.reply'), ['r', 'q']);
  assert.deepEqual(b.notes, ['Entry 1 is not used: entry 2 gives Q to Reply.']);
  noClash(b);
  // Whens that never meet keep both.
  const c = K.build([{ key: 'q', command: 'view.you', when: '!ticket' }, { key: 'q', command: 'ticket.hold' }]);
  assert.deepEqual([K.keysOf(c, 'view.you'), K.keysOf(c, 'ticket.hold')], [['q'], ['h', 'q']]);
  // A command that always keeps a key takes its default back, and says from whom.
  const d = K.build([{ key: 'mod+k', command: 'view.you' }]);
  assert.deepEqual([K.keysOf(d, 'commandPalette.toggle'), K.keysOf(d, 'view.you')], [['mod+k'], []]);
  assert.deepEqual(d.notes, ['Action bar always has a key, so it keeps ⌘K, not View: You.']);
  // Two that must keep a key, one losing its last key to the other's default: both end with one.
  const e = K.build([{ command: '-commandPalette.toggle' }, { key: 'mod+enter', command: 'commandPalette.toggle' }, { command: '-ticket.suggested' }]);
  assert.deepEqual([K.keysOf(e, 'commandPalette.toggle'), K.keysOf(e, 'ticket.suggested')], [['mod+k'], ['mod+enter']]);
  noClash(e);
  // What Settings writes reads back with no notes.
  const sw = K.swap(K.build([]), 'ticket.reply', 'h');
  assert.deepEqual(K.build(K.toList(sw)).notes, []);
});

test('the file: an entry whose when can never hold is skipped, and takes no key', () => {
  const st = K.build([{ key: 'v', command: 'view.you', when: 'ticket && !ticket' }]);
  assert.deepEqual([K.keysOf(st, 'view.toggle'), K.keysOf(st, 'view.you')], [['v'], []]);
  assert.deepEqual(st.notes, ['Entry 1 is not used: its when can never hold.']);
  assert.equal(st.changed, false);
  // Taking a key away needs no when that holds.
  assert.deepEqual(K.keysOf(K.build([{ key: 'v', command: '-view.toggle', when: 'a && !a' }]), 'view.toggle'), []);
});

test('Swap them gives the other command only keys it can have, and never leaves a must-have command without one', () => {
  const st = K.build([]);
  // Reply to ⌘↵: the suggested action cannot have R (it needs ⌘ or ⌥) and must keep a key, so only Keep.
  const c = K.clash(st, 'ticket.reply', 'mod+enter');
  assert.equal(c.other, 'ticket.suggested');
  assert.equal(c.canTake, false);
  assert.equal(c.text, '⌘↵ is already The suggested action, which always keeps a key.');
  assert.equal(K.swap(st, 'ticket.reply', 'mod+enter'), null);
  // The Action bar to ⌘↵: ⌘K suits the suggested action, so they trade.
  const p = K.clash(st, 'commandPalette.toggle', 'mod+enter');
  assert.deepEqual([p.canTake, p.gives], [true, ['mod+k']]);
  const ps = K.swap(st, 'commandPalette.toggle', 'mod+enter');
  assert.deepEqual([K.keysOf(ps, 'commandPalette.toggle'), K.keysOf(ps, 'ticket.suggested')], [['mod+enter'], ['mod+k']]);
  noClash(ps);
  // A key id gives up that a third command has where the other applies stays with the third: Take it.
  const f = K.build([{ key: 'x', command: 'view.you', when: '!ticket' }, { key: 'x', command: 'ticket.open' }]);
  const t = K.clash(f, 'view.you', 'v');
  assert.deepEqual([t.other, t.canTake, t.gives], ['view.toggle', true, []]);
  const ts = K.swap(f, 'view.you', 'v');
  assert.deepEqual([K.keysOf(ts, 'view.you'), K.keysOf(ts, 'view.toggle'), K.keysOf(ts, 'ticket.open')], [['v'], [], ['o', 'x']]);
  noClash(ts);
  // Every pair of commands and every default key: a swap Settings offers leaves no clash and every must-have key.
  for (const a of K.COMMANDS) for (const b of K.COMMANDS) for (const k of b.keys) {
    if (a.id === b.id) continue;
    const cl = K.clash(st, a.id, k);
    if (!cl || !cl.canTake) continue;
    const s2 = K.swap(st, a.id, k);
    noClash(s2);
    for (const n of K.COMMANDS.filter((x) => x.need)) assert.ok(K.keysOf(s2, n.id).length, `${a.id} ${k}: ${n.id}`);
    for (const g of cl.gives) assert.equal(K.refuse(cl.other, g), null, `${cl.other} ${g}`);
  }
});

test('Reset takes its keys back, and a command left with none gets its own back when they are free', () => {
  const sw = K.swap(K.build([]), 'ticket.reply', 'h');
  const r = K.reset(sw, 'ticket.reply');
  assert.deepEqual([K.keysOf(r, 'ticket.reply'), K.keysOf(r, 'ticket.hold')], [['r'], ['h']], 'Reset on one side undoes the swap');
  assert.equal(r.changed, false);
  // Hold's own H is taken, so Hold keeps no key rather than clash.
  const s2 = K.swap(sw, 'view.toggle', 'r');
  assert.deepEqual([K.keysOf(s2, 'view.toggle'), K.keysOf(s2, 'ticket.hold')], [['r'], ['v']]);
  const r2 = K.reset(s2, 'ticket.reply');
  assert.deepEqual([K.keysOf(r2, 'ticket.reply'), K.keysOf(r2, 'view.toggle'), K.keysOf(r2, 'ticket.hold')], [['r'], [], ['v']]);
  noClash(r2);
  // A must-have command always gets its key back, and may in turn take one.
  const ps = K.swap(K.build([]), 'commandPalette.toggle', 'mod+enter');
  const r3 = K.reset(ps, 'ticket.suggested');
  assert.deepEqual([K.keysOf(r3, 'commandPalette.toggle'), K.keysOf(r3, 'ticket.suggested')], [['mod+k'], ['mod+enter']]);
  noClash(r3);
});

test('a default key is off wherever its command applies, unless a key that holds there claims it', () => {
  const st = K.build([{ key: 'mod+enter', command: '-ticket.suggested' }, { key: 'mod+enter', command: 'ticket.suggested', when: '!ticket' }]);
  assert.deepEqual(K.route(st, 'mod+enter', { ticket: true }), { off: 'ticket.suggested' }, 'on a ticket ⌘↵ never sends');
  assert.equal(K.route(st, 'mod+enter', { ticket: false }), null);
  assert.equal(K.route(st, 'mod+enter', { ticket: true, dialog: true }), null, 'a dialog keeps its own ⌘↵');
  const m = K.build([{ key: 'm', command: '-ticket.merge' }, { key: 'm', command: 'ticket.merge', when: 'ticket && dialog' }]);
  assert.deepEqual(K.route(m, 'm', { ticket: true }), { off: 'ticket.merge' });
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
  assert.ok(!slash || slash.id !== 'ticket.suggested', '⌥/ is not the suggested action: ' + JSON.stringify(slash));
  // A sign as typed carries its own Shift: ⇧: types / on a French keyboard, and reads as /, not ?.
  assert.equal(K.comboOf(ev('/', { code: 'Period', shiftKey: true })), '/');
  assert.equal(K.comboOf(ev('?', { code: 'Slash', shiftKey: true, metaKey: true })), 'mod+?');
});

test('the file: a key a dialog keeps, with a when that needs a dialog, is skipped', () => {
  const st = K.build([{ command: '-commandPalette.toggle' }, { key: 'y', command: 'commandPalette.toggle', when: 'dialog' }]);
  assert.deepEqual(st.notes, ['Entry 2 is not used: its when needs a dialog, and a dialog keeps Y for itself.', 'Action bar always has a key, so it keeps ⌘K.']);
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
  const altGr = (on) => ({ getModifierState: (m) => on && m === 'AltGraph' });
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

test('an empty when survives saving where the command has its own', () => {
  const st = K.build([{ key: 'alt+enter', command: 'ticket.suggested', when: '' }, { key: 'y', command: 'view.you', when: '' }]);
  assert.deepEqual(st.by['ticket.suggested'], [{ key: 'mod+enter', when: '!dialog' }, { key: 'alt+enter', when: '' }]);
  const list = K.toList(st);
  assert.deepEqual(list, [{ key: 'y', command: 'view.you' }, { key: 'alt+enter', command: 'ticket.suggested', when: '' }]);
  assert.deepEqual(K.build(JSON.parse(JSON.stringify(list))).by, st.by);
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
  const src = String(keysCore);
  assert.equal(/<\/script/i.test(src), false);
  assert.equal(/=>|\blet\b|\bconst\b|`[^']/.test(src), false, 'ES5 only: no arrows, let, const or template literals');
});
