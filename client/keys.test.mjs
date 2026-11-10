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
