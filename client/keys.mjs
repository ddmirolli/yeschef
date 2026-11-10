// Editable shortcuts (⌘K bar PR 4, docs/command-bar-v1_0.md). Settings → Shortcuts records a key for a command, and the
// page's key handler routes each key through the result.
// The saved shape is T3 Code's keybindings.json: a list of { key, command, when }. A key reads as in T3 Code: modifiers
// in the order mod, alt, shift, then the key ("mod+alt+shift+a"); mod is ⌘ on a Mac and Ctrl elsewhere. A when names
// where the key applies, with && and ! ("ticket && !dialog"). There are no chords.
// The list holds only what differs from the defaults, as VS Code's keybindings.json does: an entry adds a key to a
// command, and an entry whose command starts with "-" takes that key away from it (with no key, every key). Reset all
// empties the list. An entry for a command Yes Chef does not have is kept as written and does nothing.
// keysCore is inlined into the page script by its source text (client/server.mjs), so it is ES5 and holds no
// closing script tag.
export function keysCore(mac) {
  // The group "On a call" is the approved mock's name for the keys that act on the open ticket (mock v3, Dan's yes).
  var CALL = 'On a call';
  // need: a command that always keeps a key. mod: its key also works while you write, so it needs ⌘ or ⌥.
  // note: a line shown only while the command has its default keys.
  var COMMANDS = [
    { id: 'commandPalette.toggle', g: 'App', t: 'Action bar', d: 'Search every action, thread and setting', keys: ['mod+k'], need: true },
    { id: 'chat.new', g: 'App', t: 'New thread in T3 Code', keys: ['mod+t', 'mod+n'], note: 'mod+n' },
    { id: 'thread.note', g: 'App', t: 'Send a note to a thread', d: 'Opens the action bar at the thread list', keys: [] },
    { id: 'thread.goto', g: 'App', t: 'Go to a thread', d: 'Opens the action bar at every thread on the board', keys: [] },
    { id: 'settings.open', g: 'App', t: 'Settings', keys: ['mod+,'] },
    { id: 'shortcuts.open', g: 'App', t: 'Shortcuts', d: 'This list', keys: ['?'] },
    { id: 'appearance.cycle', g: 'App', t: 'Appearance: next', d: 'System, Light and Dark in turn, as in T3 Code', keys: ['mod+alt+shift+a'] },
    { id: 'view.toggle', g: 'App', t: 'Expand or collapse the view', d: 'Every stage as a column, or The Pass and the open ticket', keys: ['v'] },
    { id: 'view.you', g: 'App', t: 'View: You', d: 'Your own agents, and only their calls in The Pass', keys: [] },
    { id: 'view.team', g: 'App', t: 'View: Team', d: 'Everyone below you, when you have a team', keys: [] },
    { id: 'send.undo', g: 'App', t: 'Undo the send', d: 'For 4 seconds after it', keys: ['z'] },
    { id: 'ticket.suggested', g: CALL, t: 'The suggested action', d: 'The blue button: Merge, Approve or the recommended answer, what Reply or Request changes armed, or Retry', keys: ['mod+enter'], when: '!dialog', need: true, mod: true },
    { id: 'ticket.merge', g: CALL, t: 'Merge', d: 'The agent merges its pull request', keys: ['m'], when: 'ticket' },
    { id: 'ticket.approve', g: CALL, t: 'Approve', d: 'With no pull request open, the agent goes ahead', keys: ['a'], when: 'ticket' },
    { id: 'ticket.requestChanges', g: CALL, t: 'Request changes', d: 'Say what to fix, then send', keys: ['f'], when: 'ticket' },
    { id: 'ticket.reply', g: CALL, t: 'Reply', d: 'Write a note, then send', keys: ['r'], when: 'ticket' },
    { id: 'ticket.addNote', g: CALL, t: 'Add a note', d: 'To the next send', keys: ['n'], when: 'ticket' },
    { id: 'ticket.hold', g: CALL, t: 'Hold until 8:00 tomorrow', keys: ['h'], when: 'ticket' },
    { id: 'ticket.settle', g: CALL, t: 'Settle', d: 'Done: it leaves The Pass', keys: ['e'], when: 'ticket' },
    { id: 'ticket.more', g: CALL, t: 'More', d: 'The actions that are not in the row', keys: ['.'], when: 'ticket' },
    { id: 'ticket.open', g: CALL, t: 'Open in T3 Code', keys: ['o'], when: 'ticket' }
  ];
  var CMD = {};
  COMMANDS.forEach(function (c) { CMD[c.id] = c; });
  // Keys that never change: shown in the list, and refused when recorded, with what they do.
  var FIXED = [
    { keys: ['j', 'k'], t: 'Next and previous ticket', d: '↓ and ↑ too' },
    { keys: ['space'], t: 'Page down the message', d: '⇧ Space pages up' },
    { keys: ['a', 'b', 'c'], more: true, t: 'Pick an option while a question waits', d: 'An option’s letter comes before any other key' },
    { keys: ['arrowleft', 'arrowright'], t: 'Previous and next question, or screenshot' },
    { keys: ['escape'], t: 'Leave the note, close a ticket or a dialog' },
    { keys: ['mod+r'], t: 'Refresh' }
  ];
  var FIXED_KEY = {
    j: 'moves to the next ticket', k: 'moves to the previous ticket', arrowdown: 'moves to the next ticket', arrowup: 'moves to the previous ticket',
    arrowleft: 'moves between questions and screenshots', arrowright: 'moves between questions and screenshots',
    space: 'pages down the message', 'shift+space': 'pages up the message', escape: 'closes and leaves', enter: 'presses the button in focus',
    tab: 'moves the focus', 'shift+tab': 'moves the focus', 'mod+r': 'refreshes Yes Chef'
  };
  // What the system keeps for itself.
  var RESERVED = {};
  ['mod+q', 'mod+w', 'mod+h', 'mod+alt+h', 'mod+m', 'mod+c', 'mod+v', 'mod+x', 'mod+a', 'mod+z', 'mod+shift+z', 'mod+tab', 'mod+space', 'mod+`',
    'mod+shift+3', 'mod+shift+4', 'mod+shift+5', 'mod+alt+escape'].forEach(function (k) { RESERVED[k] = 1; });

  var NAMED = { enter: 1, escape: 1, space: 1, tab: 1, backspace: 1, 'delete': 1, arrowup: 1, arrowdown: 1, arrowleft: 1, arrowright: 1, home: 1, end: 1, pageup: 1, pagedown: 1 };
  var ALIAS = { esc: 'escape', 'return': 'enter', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', del: 'delete' };
  var MOD_ALIAS = { mod: 'mod', cmd: 'mod', command: 'mod', meta: 'mod', ctrl: 'mod', control: 'mod', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift' };
  // The key alone, from the key's own name ("mod++" is mod and the plus key).
  function parse(s) {
    if (typeof s !== 'string') return null;
    var t = s.trim().toLowerCase();
    if (!t || t.length > 40) return null;
    var parts, key;
    if (t === '+') { key = '+'; parts = []; }
    else if (t.slice(-2) === '++') { key = '+'; parts = t.slice(0, -2).split('+'); }
    else { parts = t.split('+'); key = parts.pop(); }
    var m = { mod: false, alt: false, shift: false };
    for (var i = 0; i < parts.length; i++) {
      var p = MOD_ALIAS[parts[i].trim()];
      if (!p || m[p]) return null;
      m[p] = true;
    }
    key = ALIAS[key] || key;
    if (!(key.length === 1 || NAMED[key] || /^f([1-9]|1[0-9]|20)$/.test(key))) return null;
    if (/\s/.test(key)) return null;
    // A sign carries its own Shift: "?" is the key, never "shift+/".
    if (key.length === 1 && !/^[a-z0-9]$/.test(key)) m.shift = false;
    return { mod: m.mod, alt: m.alt, shift: m.shift, key: key };
  }
  function str(p) { return (p.mod ? 'mod+' : '') + (p.alt ? 'alt+' : '') + (p.shift ? 'shift+' : '') + p.key; }
  /** A key as written anywhere ("Cmd+Option+A", "esc"), in T3 Code's form, or null. */
  function norm(s) { var p = parse(s); return p ? str(p) : null; }
  /** The key a keydown names, or null for a modifier alone. Letters and digits read from the key, so another layout
   *  keeps its letters; with ⌥ or ⇧ they read from the physical key, as the page did for ⌥⇧⌘A. */
  function comboOf(ev) {
    var k = ev && ev.key;
    if (!k || /^(Shift|Meta|Control|Alt|AltGraph|CapsLock|Fn|FnLock|Hyper|Super|OS|Dead|Unidentified|Process)$/.test(k)) return null;
    var code = ev.code || '', name;
    if (k.length === 1 && /^[a-z0-9]$/i.test(k)) name = k.toLowerCase();
    else if ((ev.altKey || ev.shiftKey) && /^Key[A-Z]$/.test(code)) name = code.slice(3).toLowerCase();
    else if ((ev.altKey || ev.shiftKey) && /^Digit[0-9]$/.test(code)) name = code.slice(5);
    else if (k === ' ') name = 'space';
    else name = k.toLowerCase();
    return norm((ev.metaKey || ev.ctrlKey ? 'mod+' : '') + (ev.altKey ? 'alt+' : '') + (ev.shiftKey ? 'shift+' : '') + (name === '+' ? '+' : name));
  }
  var GLYPH = { enter: '↵', escape: 'esc', space: 'Space', tab: '⇥', backspace: '⌫', 'delete': '⌦', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', home: '↖', end: '↘', pageup: '⇞', pagedown: '⇟' };
  /** The keys of one key, in the order a Mac menu shows them: ["⌥", "⇧", "⌘", "A"]. */
  function glyphs(c) {
    var p = parse(c); if (!p) return [];
    var out = [];
    if (mac) { if (p.alt) out.push('⌥'); if (p.shift) out.push('⇧'); if (p.mod) out.push('⌘'); }
    else { if (p.mod) out.push('Ctrl'); if (p.alt) out.push('Alt'); if (p.shift) out.push('Shift'); }
    out.push(GLYPH[p.key] || p.key.toUpperCase());
    return out;
  }
  /** One key as one label: "⌥⇧⌘A" on a Mac, "Ctrl+Alt+Shift+A" elsewhere. */
  function label(c) { var g = glyphs(c); return g.join(mac ? '' : '+'); }

  // ----- when -----
  var WHEN = /^\s*!?\s*[A-Za-z][\w.]*\s*(&&\s*!?\s*[A-Za-z][\w.]*\s*)*$/;
  function okWhen(w) { return w == null || w === '' || (typeof w === 'string' && w.length <= 200 && WHEN.test(w)); }
  function lits(w) { return w ? String(w).split('&&').map(function (x) { return x.replace(/\s+/g, ''); }) : []; }
  /** Whether a when holds in ctx ({ ticket: true, dialog: false }). A name ctx does not have is false. */
  function holds(w, ctx) {
    return lits(w).every(function (t) { var neg = t.charAt(0) === '!'; return !!(ctx && ctx[neg ? t.slice(1) : t]) !== neg; });
  }
  /** Two whens that can never hold together ("x" and "!x"): their keys do not clash. */
  function exclusive(a, b) {
    var lb = lits(b);
    return lits(a).some(function (x) { return lb.indexOf(x.charAt(0) === '!' ? x.slice(1) : '!' + x) >= 0; });
  }

  // ----- The keys in use -----
  function defaults(id) { var c = CMD[id]; return c.keys.map(function (k) { return { key: k, when: c.when || '' }; }); }
  function has(list, b) { return list.some(function (x) { return x.key === b.key && x.when === b.when; }); }
  function same(a, b) { return a.length === b.length && a.every(function (x) { return has(b, x); }); }
  /** The keys in use from a saved list: { by: { command: [{ key, when }] }, notes, extra, changed }. notes say what in
   *  the list was not used; extra keeps the entries for commands Yes Chef does not have. */
  function build(list) {
    var by = {}, notes = [], extra = [];
    COMMANDS.forEach(function (c) { by[c.id] = defaults(c.id); });
    if (list != null && !Array.isArray(list)) notes.push('The file is not a list, so every key is its default.');
    (Array.isArray(list) ? list : []).forEach(function (e, i) {
      var at = 'Entry ' + (i + 1);
      if (!e || typeof e !== 'object' || typeof e.command !== 'string') { notes.push(at + ' has no command.'); return; }
      var off = e.command.charAt(0) === '-', id = off ? e.command.slice(1) : e.command, c = CMD[id];
      if (!c) { extra.push(e); notes.push(at + ': ' + e.command + ' is not a Yes Chef command.'); return; }
      if (!okWhen(e.when)) { notes.push(at + ': Yes Chef cannot read its when.'); return; }
      var w = e.when == null ? (c.when || '') : lits(e.when).join(' && ');
      if (off && (e.key == null || e.key === '')) { by[id] = []; return; }
      var k = norm(e.key);
      if (!k) { notes.push(at + ': “' + String(e.key).slice(0, 40) + '” is not a key Yes Chef can read.'); return; }
      if (off) { by[id] = by[id].filter(function (b) { return b.key !== k; }); return; }
      if (!has(by[id], { key: k, when: w })) by[id].push({ key: k, when: w });
    });
    COMMANDS.forEach(function (c) {
      if (c.need && !by[c.id].length) { by[c.id] = defaults(c.id); notes.push(c.t + ' always has a key, so it keeps ' + label(c.keys[0]) + '.'); }
    });
    return state(by, notes, extra);
  }
  function state(by, notes, extra) {
    return { by: by, notes: notes || [], extra: extra || [], changed: COMMANDS.some(function (c) { return !same(by[c.id], defaults(c.id)); }) };
  }
  /** The list to save: what differs from the defaults, then the entries kept for other commands. */
  function toList(st) {
    var out = [];
    function entry(key, command, when) { var e = { key: key, command: command }; if (when) e.when = when; return e; }
    COMMANDS.forEach(function (c) {
      var now = st.by[c.id], dflt = defaults(c.id);
      if (same(now, dflt)) return;
      if (!now.length && dflt.length) { out.push({ command: '-' + c.id }); return; }
      dflt.forEach(function (b) { if (!has(now, b)) out.push(entry(b.key, '-' + c.id, b.when)); });
      now.forEach(function (b) { if (!has(dflt, b)) out.push(entry(b.key, c.id, b.when)); });
    });
    return out.concat(st.extra);
  }
  function copy(st) { var by = {}; for (var id in st.by) by[id] = st.by[id].slice(); return { by: by, extra: st.extra }; }
  /** The command's keys now. */
  function keysOf(st, id) { return (st.by[id] || []).map(function (b) { return b.key; }); }
  /** id now has only key. */
  function set(st, id, key) { var s = copy(st); s.by[id] = [{ key: key, when: CMD[id].when || '' }]; return state(s.by, [], s.extra); }
  /** id takes key from other, and other takes id's keys ("Swap them"; with none, other is left without one). */
  function swap(st, id, key, other) {
    var s = copy(st), old = keysOf(st, id).filter(function (k) { return k !== key; });
    s.by[id] = [{ key: key, when: CMD[id].when || '' }];
    s.by[other] = s.by[other].filter(function (b) { return b.key !== key; });
    old.forEach(function (k) { var b = { key: k, when: CMD[other].when || '' }; if (!has(s.by[other], b)) s.by[other].push(b); });
    return state(s.by, [], s.extra);
  }
  function reset(st, id) { var s = copy(st); s.by[id] = defaults(id); return state(s.by, [], s.extra); }
  function isDefault(st, id) { return same(st.by[id], defaults(id)); }
  /** Why key cannot simply go to id: { reserved }, { fixed }, { other: command }, or null when it is free.
   *  Only commands whose whens can hold together clash. */
  function clash(st, id, key) {
    var c = CMD[id], l = label(key);
    if (RESERVED[key]) return { reserved: true, text: l + ' belongs to ' + (mac ? 'macOS' : 'your system') + '. Press another key.' };
    if (FIXED_KEY[key]) return { fixed: true, text: l + ' ' + FIXED_KEY[key] + ' and stays that way. Press another key.' };
    if (c.mod && !/^(mod|alt)\+/.test(key)) return { fixed: true, text: 'This key also works while you write a note, so it needs ' + (mac ? '⌘ or ⌥' : 'Ctrl or Alt') + '. Press another key.' };
    for (var i = 0; i < COMMANDS.length; i++) {
      var o = COMMANDS[i];
      if (o.id === id) continue;
      if (st.by[o.id].some(function (b) { return b.key === key && !exclusive(b.when, c.when || ''); })) {
        // A command that always keeps a key can trade it, never give it up.
        return { other: o.id, text: l + ' is already ' + o.t + '.', canTake: !(o.need && !keysOf(st, id).filter(function (k) { return k !== key; }).length) };
      }
    }
    return null;
  }
  /** The command a key runs here, or null. */
  function lookup(st, key, ctx) {
    for (var i = 0; i < COMMANDS.length; i++) {
      var c = COMMANDS[i];
      if (st.by[c.id].some(function (b) { return b.key === key && holds(b.when, ctx); })) return c.id;
    }
    return null;
  }
  /** What the page does with a key: null, as it always has; { as: key, id }, the key the command had by default;
   *  { run: id } for a command with no default key; { off: id } for a default key its command no longer has. */
  function route(st, key, ctx) {
    if (!key) return null;
    var id = lookup(st, key, ctx);
    if (id) {
      var c = CMD[id];
      if (c.keys.indexOf(key) >= 0) return null;
      return c.keys.length ? { as: c.keys[0], id: id } : { run: id };
    }
    for (var i = 0; i < COMMANDS.length; i++) {
      var d = COMMANDS[i];
      if (d.keys.indexOf(key) >= 0 && holds(d.when, ctx) && keysOf(st, d.id).indexOf(key) < 0) return { off: d.id };
    }
    return null;
  }
  var KEYNAME = { enter: 'Enter', escape: 'Escape', space: ' ', tab: 'Tab', backspace: 'Backspace', 'delete': 'Delete', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };
  /** A stand-in keydown for a key, from the real one ev: what the page's handler reads, and preventDefault. */
  function synth(key, ev) {
    var p = parse(key), k = p.key;
    return {
      key: KEYNAME[k] || (/^f\d+$/.test(k) ? k.toUpperCase() : p.shift && /^[a-z]$/.test(k) ? k.toUpperCase() : k),
      code: /^[a-z]$/.test(k) ? 'Key' + k.toUpperCase() : /^[0-9]$/.test(k) ? 'Digit' + k : '',
      metaKey: p.mod && !!mac, ctrlKey: p.mod && !mac, altKey: p.alt, shiftKey: p.shift,
      repeat: !!(ev && ev.repeat), target: ev && ev.target, synthetic: true,
      preventDefault: function () { if (ev && ev.preventDefault) ev.preventDefault(); }
    };
  }
  /** Whether a key is plain (no ⌘ or ⌥): it types in a text field, so it never acts there. */
  function plain(key) { return !!key && !/^(mod|alt)\+/.test(key); }

  return {
    COMMANDS: COMMANDS, CMD: CMD, FIXED: FIXED, mac: !!mac,
    parse: parse, norm: norm, comboOf: comboOf, glyphs: glyphs, label: label,
    okWhen: okWhen, holds: holds, exclusive: exclusive,
    build: build, toList: toList, keysOf: keysOf, set: set, swap: swap, reset: reset, isDefault: isDefault,
    clash: clash, lookup: lookup, route: route, synth: synth, plain: plain
  };
}
