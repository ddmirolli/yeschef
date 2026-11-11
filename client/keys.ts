// Editable shortcuts (⌘K bar PR 4, docs/command-bar-v1_0.md). Settings → Shortcuts records a key for a command, and the
// page's key handler routes each key through the result.
// The saved shape is T3 Code's keybindings.json: a list of { key, command, when }. A key reads as in T3 Code: modifiers
// in the order mod, alt, shift, then the key ("mod+alt+shift+a"); mod is ⌘ on a Mac and Ctrl elsewhere. A when names
// where the key applies, with && and ! ("ticket && !dialog"). There are no chords.
// The list follows T3 Code's rules too. A command the list names has only the list's keys; one it does not name keeps
// its defaults. The defaults come first and the list after them, and of the rules for a key whose whens hold, the last
// runs. A key Settings records goes at the end. The Mac app writes every default into a new file and adds those of a
// new command at start, as T3 Code does (desktop/keybindings.ts). An entry Yes Chef cannot use, or for a command it
// does not have, stays where it is and does nothing.
// keysCore is inlined into the page script by its source text (client/server.mjs), so it is ES5 once Node strips its
// types, holds only types Node can strip, and holds no closing script tag. Its types live out here.

/** A command a key can run. g: its group; t: its title; d: what it does; keys: its default keys. need: it always
 *  keeps a key. mod: its key works while you write, so it needs ⌘ or ⌥. note: a line shown with its default keys. */
export interface Command { id: string; g: string; t: string; d?: string; keys: string[]; when?: string; need?: boolean; mod?: boolean; note?: string }
/** A key that never changes, as the list shows it. */
export interface FixedKey { keys: string[]; t: string; d?: string; more?: boolean }
/** One key, read: its modifiers and the key alone. */
export interface Combo { mod: boolean; alt: boolean; shift: boolean; key: string }
/** A key and where it applies. */
export interface Binding { key: string; when: string }
/** A key in use: the command it runs, its key, and its when. */
export interface KeyRule { id: string; key: string; when: string }
/** An entry of keybindings.json as Settings writes it. */
export interface KeyEntry { key: string; command: string; when?: string }
/** The keys from a saved list (make). */
export interface KeyState { list: unknown[]; rules: KeyRule[]; by: Record<string, Binding[]>; notes: string[]; changed: boolean }
/** Where a key is pressed: the names a when can read, such as { ticket: true, dialog: false }. */
export type KeyContext = Readonly<Record<string, unknown>>;
/** What a keydown gives the handler, real or made by synth. */
export interface KeyEventLike {
  key?: string; code?: string; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; repeat?: boolean;
  target?: unknown; getModifierState?: (key: string) => boolean; preventDefault?: () => void;
}
type Refusal = { reserved?: boolean; fixed?: boolean; why: string };
type Compiled = { note: string; rule?: undefined } | { rule: KeyRule; note?: undefined };
type Trade = { blocked: string; st?: undefined; other?: undefined; gives?: undefined } | { st: KeyState; other: string | undefined; gives: string[]; blocked?: undefined };
/** Why a key cannot simply go to a command (clash). */
export type Clash = { reserved: boolean; fixed: boolean; text: string; other?: undefined } | { other: string; text: string; canTake: boolean; gives: string[] };
/** What the page does with a key (route). */
export type KeyRoute = { as: string; id: string } | { run: string } | { off: string } | null;
type Place = { ticket: boolean; dialog: boolean };
type Mods = 'mod' | 'alt' | 'shift';
export type Keys = ReturnType<typeof keysCore>;

export function keysCore(mac?: boolean) {
  // The group "On a call" is the approved mock's name for the keys that act on the open ticket (mock v3, Dan's yes).
  var CALL = 'On a call';
  // need: a command that always keeps a key. mod: its key also works while you write, so it needs ⌘ or ⌥.
  // note: a line shown only while the command has its default keys.
  var COMMANDS: Command[] = [
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
  // Every table below is looked up by a name from the file or a key, so none has Object's names ("constructor").
  function dict<T>(o: Record<string, T>): Record<string, T> { var d: Record<string, T> = Object.create(null); for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) d[k] = o[k] as T; return d; }
  var CMD: Record<string, Command> = Object.create(null);
  COMMANDS.forEach(function (c) { CMD[c.id] = c; });
  // Keys that never change: shown in the list, and refused when recorded, with what they do.
  var FIXED: FixedKey[] = [
    { keys: ['j', 'k'], t: 'Next and previous ticket', d: '↓ and ↑ too' },
    { keys: ['space'], t: 'Page down the message', d: '⇧ Space pages up' },
    { keys: ['a', 'b', 'c'], more: true, t: 'Pick an option while a question waits', d: 'An option’s letter comes before any other key' },
    { keys: ['arrowleft', 'arrowright'], t: 'Previous and next question, or screenshot' },
    { keys: ['escape'], t: 'Leave the note, close a ticket or a dialog' },
    { keys: ['mod+r'], t: 'Refresh' }
  ];
  var FIXED_KEY = dict({
    j: 'moves to the next ticket', k: 'moves to the previous ticket', arrowdown: 'moves to the next ticket', arrowup: 'moves to the previous ticket',
    arrowleft: 'moves between questions and screenshots', arrowright: 'moves between questions and screenshots',
    space: 'pages down the message', 'shift+space': 'pages up the message', escape: 'closes and leaves', enter: 'presses the button in focus',
    tab: 'moves the focus', 'shift+tab': 'moves the focus', 'mod+r': 'refreshes Yes Chef'
  });
  // What the system keeps for itself. ⇧⌘Tab and ⇧⌘~ switch back, as ⌘Tab and the key left of 1 with ⌘ switch on.
  // ⇧⌘Q and ⌥⇧⌘Q log out, ⌥⌘D shows or hides the Dock, ⌥⌘Space opens a Finder search, ⌥⇧⌘Esc force quits.
  var RESERVED: Record<string, number> = Object.create(null);
  ['mod+q', 'mod+shift+q', 'mod+alt+shift+q', 'mod+w', 'mod+h', 'mod+alt+h', 'mod+m', 'mod+c', 'mod+v', 'mod+x', 'mod+a', 'mod+z', 'mod+shift+z',
    'mod+tab', 'mod+shift+tab', 'mod+space', 'mod+alt+space', 'mod+`', 'mod+~', 'mod+alt+d', 'mod+shift+3', 'mod+shift+4', 'mod+shift+5',
    'mod+alt+escape', 'mod+alt+shift+escape'].forEach(function (k) { RESERVED[k] = 1; });

  var NAMED = dict({ enter: 1, escape: 1, space: 1, tab: 1, backspace: 1, 'delete': 1, arrowup: 1, arrowdown: 1, arrowleft: 1, arrowright: 1, home: 1, end: 1, pageup: 1, pagedown: 1 });
  var ALIAS = dict({ esc: 'escape', 'return': 'enter', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', del: 'delete' });
  // A shifted digit's sign, as on a US keyboard: a keydown names the digit with ⇧ (comboOf), so the file's "!" does too.
  var SHIFT_DIGIT = dict({ '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0' });
  // A sign's shifted sign, as on a US keyboard: the file's "shift+/" is "?", the sign ⇧/ types.
  var SHIFT_SIGN = dict({ '/': '?', '.': '>', ',': '<', ';': ':', '\'': '"', '[': '{', ']': '}', '\\': '|', '-': '_', '=': '+' });
  SHIFT_SIGN[String.fromCharCode(96)] = '~';
  var MOD_ALIAS = dict<Mods>({ mod: 'mod', cmd: 'mod', command: 'mod', meta: 'mod', ctrl: 'mod', control: 'mod', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift' });
  // The key alone, from the key's own name ("mod++" is mod and the plus key).
  function parse(s: unknown): Combo | null {
    if (typeof s !== 'string') return null;
    var t = s.trim().toLowerCase();
    if (!t || t.length > 40) return null;
    var parts: string[], key: string;
    if (t === '+') { key = '+'; parts = []; }
    else if (t.slice(-2) === '++') { key = '+'; parts = t.slice(0, -2).split('+'); }
    else { parts = t.split('+'); key = parts.pop()!; }
    var m: Record<Mods, boolean> = { mod: false, alt: false, shift: false };
    for (var i = 0; i < parts.length; i++) {
      var p = MOD_ALIAS[parts[i]!.trim()];
      if (!p || m[p]) return null;
      m[p] = true;
    }
    key = ALIAS[key] || key;
    if (!(key.length === 1 || NAMED[key] || /^f([1-9]|1[0-9]|20)$/.test(key))) return null;
    if (/\s/.test(key)) return null;
    if (SHIFT_DIGIT[key]) { key = SHIFT_DIGIT[key]!; m.shift = true; }
    // A sign carries its own Shift: "?" is the key. Written with Shift, a US sign names the sign ⇧ types, as a keydown
    // does: "shift+/" is "?", and "alt+shift+/" is "alt+?", never "alt+/". Any other sign keeps its name.
    if (key.length === 1 && !/^[a-z0-9]$/.test(key)) { if (m.shift && SHIFT_SIGN[key]) key = SHIFT_SIGN[key]!; m.shift = false; }
    return { mod: m.mod, alt: m.alt, shift: m.shift, key: key };
  }
  function str(p: Combo): string { return (p.mod ? 'mod+' : '') + (p.alt ? 'alt+' : '') + (p.shift ? 'shift+' : '') + p.key; }
  /** A key as written anywhere ("Cmd+Option+A", "esc"), in T3 Code's form, or null. */
  function norm(s: unknown): string | null { var p = parse(s); return p ? str(p) : null; }
  // A sign key's US character, without and with ⇧, by its physical key.
  var CODE_SIGN = dict({ Slash: '/?', Period: '.>', Comma: ',<', Semicolon: ';:', Quote: '\'"', BracketLeft: '[{', BracketRight: ']}',
    Backslash: '\\|', Minus: '-_', Equal: '=+', Backquote: String.fromCharCode(96) + '~' });
  /** The key a keydown names, or null for a modifier alone. Letters and digits read from the key, so another layout
   *  keeps its letters. ⌥ and ⇧ change what a key types (⌥/ is ÷, ⇧1 is !, ⌥E is a dead key that starts é), so then
   *  the physical key names it, as on a US keyboard: letters and digits with ⌥ or ⇧, signs with ⌥. The page did
   *  this for ⌥⇧⌘A, and a file's keys read the same way (norm). */
  function comboOf(ev: KeyEventLike | null | undefined): string | null {
    var k = ev && ev.key, code = (ev && ev.code) || '', name: string;
    if (!ev || !k) return null;
    // Off a Mac, AltGr types a character (AltGr+E is € on a German keyboard) and reads as Ctrl+Alt: never a shortcut,
    // so € in a note never sends. On a Mac, ⌥ is a shortcut's ⌥ (some browsers call it AltGraph), so there it reads.
    if (!mac && typeof ev.getModifierState === 'function' && ev.getModifierState('AltGraph')) return null;
    if (k.length === 1 && /^[a-z0-9]$/i.test(k)) name = k.toLowerCase();
    else if ((ev.altKey || ev.shiftKey) && /^Key[A-Z]$/.test(code)) name = code.slice(3).toLowerCase();
    else if ((ev.altKey || ev.shiftKey) && /^Digit[0-9]$/.test(code)) name = code.slice(5);
    else if (ev.altKey && CODE_SIGN[code]) name = CODE_SIGN[code]!.charAt(ev.shiftKey ? 1 : 0);
    else if (/^(Shift|Meta|Control|Alt|AltGraph|CapsLock|Fn|FnLock|Hyper|Super|OS|Dead|Unidentified|Process)$/.test(k)) return null;
    else if (k === ' ') name = 'space';
    else name = k.toLowerCase();
    // A sign as typed already carries its Shift (⇧/ types ?, and ⇧: types / on a French keyboard), so it takes none.
    var sh = ev.shiftKey && !(name.length === 1 && !/^[a-z0-9]$/.test(name));
    return norm((ev.metaKey || ev.ctrlKey ? 'mod+' : '') + (ev.altKey ? 'alt+' : '') + (sh ? 'shift+' : '') + (name === '+' ? '+' : name));
  }
  var GLYPH = dict({ enter: '↵', escape: 'esc', space: 'Space', tab: '⇥', backspace: '⌫', 'delete': '⌦', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', home: '↖', end: '↘', pageup: '⇞', pagedown: '⇟' });
  /** The keys of one key, in the order a Mac menu shows them: ["⌥", "⇧", "⌘", "A"]. */
  function glyphs(c: unknown): string[] {
    var p = parse(c); if (!p) return [];
    var out: string[] = [];
    if (mac) { if (p.alt) out.push('⌥'); if (p.shift) out.push('⇧'); if (p.mod) out.push('⌘'); }
    else { if (p.mod) out.push('Ctrl'); if (p.alt) out.push('Alt'); if (p.shift) out.push('Shift'); }
    out.push(GLYPH[p.key] || p.key.toUpperCase());
    return out;
  }
  /** One key as one label: "⌥⇧⌘A" on a Mac, "Ctrl+Alt+Shift+A" elsewhere. */
  function label(c: unknown): string { var g = glyphs(c); return g.join(mac ? '' : '+'); }

  // ----- when -----
  var WHEN = /^\s*!?\s*[A-Za-z][\w.]*\s*(&&\s*!?\s*[A-Za-z][\w.]*\s*)*$/;
  function okWhen(w: unknown): boolean { return w == null || w === '' || (typeof w === 'string' && w.length <= 200 && WHEN.test(w)); }
  function lits(w: unknown): string[] { return w ? String(w).split('&&').map(function (x) { return x.replace(/\s+/g, ''); }) : []; }
  /** Whether a when holds in ctx ({ ticket: true, dialog: false }). A name ctx does not have is false. */
  function holds(w: unknown, ctx: KeyContext | null | undefined): boolean {
    return lits(w).every(function (t) {
      var neg = t.charAt(0) === '!', n = neg ? t.slice(1) : t;
      return !!(ctx && Object.prototype.hasOwnProperty.call(ctx, n) && ctx[n]) !== neg;
    });
  }
  /** Two whens that can never hold together ("x" and "!x"): their keys do not clash. */
  function exclusive(a: unknown, b: unknown): boolean {
    var lb = lits(b);
    return lits(a).some(function (x) { return lb.indexOf(x.charAt(0) === '!' ? x.slice(1) : '!' + x) >= 0; });
  }

  // ----- The keys in use -----
  // T3 Code's rules (packages/shared/src/keybindings.ts, mergeWithDefaultKeybindings; apps/web/src/keybindings.ts,
  // resolveShortcutCommand): the rules are the defaults of every command the list does not name, then the list in
  // order. A command the list names has only the list's keys. Of the rules for a key whose whens hold, the last runs.
  function defaults(id: string): Binding[] { var c = CMD[id]!; return c.keys.map(function (k) { return { key: k, when: c.when || '' }; }); }
  function has(list: Binding[], b: Binding): boolean { return list.some(function (x) { return x.key === b.key && x.when === b.when; }); }
  function same(a: Binding[], b: Binding[]): boolean { return a.length === b.length && a.every(function (x) { return has(b, x); }); }
  /** A rule as T3 Code's Settings writes it: a when only when it has one. */
  function entry(key: string, command: string, when?: string): KeyEntry { var e: KeyEntry = { key: key, command: command }; if (when) e.when = when; return e; }
  /** Every default, in the order T3 Code writes them into a new file. */
  function defaultList(): KeyEntry[] {
    var out: KeyEntry[] = [];
    COMMANDS.forEach(function (c) { defaults(c.id).forEach(function (b) { out.push(entry(b.key, c.id, b.when)); }); });
    return out;
  }
  /** Why id can never have key, as a sentence: { reserved, why } for a key the system keeps, { fixed, why } for a
   *  fixed key or a send key with no ⌘ or ⌥. null when id can have it. Settings and the file both use it. */
  function refuse(id: string, key: string): Refusal | null {
    var c = CMD[id]!, l = label(key);
    if (RESERVED[key]) return { reserved: true, why: l + ' belongs to ' + (mac ? 'macOS' : 'your system') + '.' };
    if (FIXED_KEY[key]) return { fixed: true, why: l + ' ' + FIXED_KEY[key] + ' and stays that way.' };
    if (c.mod && !/^(mod|alt)\+/.test(key)) return { fixed: true, why: c.t + ' also works while you write a note, so its key needs ' + (mac ? '⌘ or ⌥' : 'Ctrl or Alt') + '.' };
    return null;
  }
  /** One entry of the list: { rule: { id, key, when } } when Yes Chef uses it, else { note } saying why not. An entry
   *  with no when applies everywhere, as in T3 Code. */
  function compile(raw: unknown, i: number): Compiled {
    var e = raw as { key?: unknown; command?: unknown; when?: unknown } | null, at = 'Entry ' + (i + 1);
    if (!e || typeof e !== 'object' || typeof e.command !== 'string') return { note: at + ' has no command.' };
    var c = CMD[e.command];
    if (!c) return { note: at + ': ' + e.command + ' is not a Yes Chef command.' };
    if (!okWhen(e.when)) return { note: at + ': Yes Chef cannot read its when.' };
    var w = lits(e.when).join(' && ');
    // A when that can never hold ("ticket && !ticket") would shadow other commands' keys and never run.
    if (exclusive(w, w)) return { note: at + ' is not used: its when can never hold.' };
    var k = norm(e.key);
    // The key is shown only when it is text: converting anything else could run code the file names, or throw.
    if (!k) return { note: at + (typeof e.key === 'string' ? ': “' + e.key.slice(0, 40) + '” is not a key Yes Chef can read.' : e.key == null ? ' has no key.' : ': its key is not text.') };
    var no = refuse(c.id, k);
    if (no) return { note: at + ' is not used: ' + no.why };
    // An open dialog keeps its plain keys and ⌘↵ (route), so such a key that applies only in a dialog would never run.
    if (dialogKey(k) && lits(w).indexOf('dialog') >= 0) return { note: at + ' is not used: its when needs a dialog, and a dialog keeps ' + label(k) + ' for itself.' };
    return { rule: { id: c.id, key: k, when: w } };
  }
  // Every place a key can be pressed: route gets { ticket, dialog }, and any other name in a when is false there.
  var PLACES: Place[] = [{ ticket: false, dialog: false }, { ticket: true, dialog: false }, { ticket: false, dialog: true }, { ticket: true, dialog: true }];
  /** Whether rules[i] runs in ctx: its when holds there and no later rule for its key does. An open dialog keeps its
   *  plain keys and ⌘↵ (route), so those never run there. */
  function runsAt(rules: KeyRule[], i: number, ctx: Place): boolean {
    var r = rules[i]!;
    if ((ctx.dialog && dialogKey(r.key)) || !holds(r.when, ctx)) return false;
    for (var j = i + 1; j < rules.length; j++) if (rules[j]!.key === r.key && holds(rules[j]!.when, ctx)) return false;
    return true;
  }
  function runs(rules: KeyRule[], i: number): boolean { return PLACES.some(function (ctx) { return runsAt(rules, i, ctx); }); }
  /** Whether a command that always keeps a key has one that runs it in every place outside a dialog where its own when
   *  holds: the Action bar with and without a ticket, the suggested action on the open ticket. */
  function reaches(rules: KeyRule[], c: Command): boolean {
    return PLACES.every(function (ctx) {
      if (ctx.dialog || !holds(c.when || '', ctx)) return true;
      return rules.some(function (r, i) { return r.id === c.id && runsAt(rules, i, ctx); });
    });
  }
  /** Each command's keys that run somewhere, as { key, when }: what Settings shows. */
  function shown(rules: KeyRule[]): Record<string, Binding[]> {
    var by: Record<string, Binding[]> = {};
    COMMANDS.forEach(function (c) { by[c.id] = []; });
    rules.forEach(function (r, i) { if (!has(by[r.id]!, r) && runs(rules, i)) by[r.id]!.push({ key: r.key, when: r.when }); });
    return by;
  }
  /** The keys from a saved list: { list, rules, by: { command: [{ key, when }] }, notes, changed }. list is the list as
   *  saved, every entry kept where it is; rules are in the order they apply; notes say what in the list is not used.
   *  guard: a command that always keeps a key, left with none, gets its defaults back after every other rule. That is
   *  Yes Chef's own rule; T3 Code has none. */
  function make(list: unknown, guard: boolean): KeyState {
    var notes: string[] = [], kept: unknown[] = [], mine: KeyRule[] = [], named: Record<string, number> = Object.create(null), rules: KeyRule[] = [];
    if (list != null && !Array.isArray(list)) notes.push('The file is not a list, so every key is its default.');
    (Array.isArray(list) ? list : []).forEach(function (e: unknown, i: number) {
      var r = compile(e, i);
      kept.push(e);
      if (r.rule) { mine.push(r.rule); named[r.rule.id] = 1; } else notes.push(r.note);
    });
    COMMANDS.forEach(function (c) { if (!named[c.id]) defaults(c.id).forEach(function (b) { rules.push({ id: c.id, key: b.key, when: b.when }); }); });
    rules = rules.concat(mine);
    var by = shown(rules), again = guard;
    for (var pass = 0; again && pass < COMMANDS.length; pass++) {
      again = false;
      COMMANDS.forEach(function (c) {
        if (!c.need || reaches(rules, c)) return;
        again = true;
        var was = by;
        defaults(c.id).forEach(function (b) { rules.push({ id: c.id, key: b.key, when: b.when }); });
        by = shown(rules);
        var lost = COMMANDS.filter(function (o) {
          return o.id !== c.id && c.keys.some(function (k) { return keysIn(was[o.id]!).indexOf(k) >= 0 && keysIn(by[o.id]!).indexOf(k) < 0; });
        });
        notes.push(c.t + ' always has a key, so it keeps ' + label(c.keys[0]) + (lost.length ? ', not ' + lost.map(function (o) { return o.t; }).join(' or ') : '') + '.');
      });
    }
    return { list: kept, rules: rules, by: by, notes: notes, changed: COMMANDS.some(function (c) { return !same(by[c.id]!, defaults(c.id)); }) };
  }
  function build(list: unknown): KeyState { return make(list, true); }
  /** The list to save: every entry as it was, in order, with what Settings changed at the end. */
  function toList(st: KeyState): unknown[] { return st.list.slice(); }
  function keysIn(bs: Binding[]): string[] { var out: string[] = []; bs.forEach(function (b) { if (out.indexOf(b.key) < 0) out.push(b.key); }); return out; }
  /** The command's keys now. */
  function keysOf(st: KeyState, id: string): string[] { return keysIn(st.by[id] || []); }
  /** The list with id's rules taken out and rules put at the end, as T3 Code's Settings saves a key: an entry Yes Chef
   *  does not use stays where it is. */
  function put(list: unknown[], id: string, rules: Binding[]): unknown[] {
    return list.filter(function (e, i) { var r = compile(e, i); return !(r.rule && r.rule.id === id); })
      .concat(rules.map<unknown>(function (b) { return entry(b.key, id, b.when); }));
  }
  /** The commands other than id that have key where when can apply too: with id, they would clash. */
  function holders(by: Record<string, Binding[]>, key: string, when: string, id: string): string[] {
    var out: string[] = [];
    COMMANDS.forEach(function (o) {
      if (o.id !== id && by[o.id]!.some(function (b) { return b.key === key && !exclusive(b.when, when); })) out.push(o.id);
    });
    return out;
  }
  /** id now has only key. */
  function set(st: KeyState, id: string, key: string): KeyState { return build(put(st.list, id, [{ key: key, when: CMD[id]!.when || '' }])); }
  /** Swap them: id gets key, after every rule, so it runs key wherever its when holds. The first command that had key
   *  where both apply gets id's other keys, each one it can have, in place of key; with none to give, it keeps its rule
   *  for key, which then runs only where id's does not apply (Take it). { blocked: command } when a command that
   *  always keeps a key would be left without one; else { st, other, gives }, where gives are the keys other got. */
  function trade(st: KeyState, id: string, key: string): Trade {
    var w = CMD[id]!.when || '', old = keysOf(st, id).filter(function (k) { return k !== key; });
    var hs = holders(st.by, key, w, id), other = hs[0], gives: string[] = [];
    var list = put(st.list, id, [{ key: key, when: w }]), s = make(list, false);
    if (other) {
      var o = other, ow = CMD[o]!.when || '';
      old.forEach(function (k) {
        if (refuse(o, k) || holders(s.by, k, ow, o).length || has(s.by[o]!, { key: k, when: ow })) return;
        gives.push(k);
      });
      if (gives.length) {
        list = put(list, other, s.by[other]!.filter(function (b) { return b.key !== key; }).concat(gives.map(function (k) { return { key: k, when: ow }; })));
        s = make(list, false);
      }
    }
    for (var i = 0; i < hs.length; i++) { var h = CMD[hs[i]!]!; if (h.need && !reaches(s.rules, h)) return { blocked: h.id }; }
    return { st: build(list), other: other, gives: gives };
  }
  /** The keys after Swap them, or null when clash() says it cannot be done. */
  function swap(st: KeyState, id: string, key: string): KeyState | null { return trade(st, id, key).st || null; }
  /** Its default keys whether they are free: no other command has one where both can apply. */
  function free(by: Record<string, Binding[]>, id: string): boolean { var w = CMD[id]!.when || ''; return CMD[id]!.keys.every(function (k) { return !holders(by, k, w, id).length; }); }
  /** id gets its default keys back, after every rule, as T3 Code's Reset to default saves them. A command that this
   *  leaves with no key gets its own defaults back too when they are free, and always when it must keep a key. */
  function reset(st: KeyState, id: string): KeyState {
    var list = st.list, cur = make(list, false), queue: string[] = [id], done: Record<string, number> = Object.create(null);
    while (queue.length) {
      var r = queue.shift()!;
      if (done[r]) continue;
      done[r] = 1;
      list = put(list, r, defaults(r));
      var next = make(list, false);
      COMMANDS.forEach(function (h) {
        if (done[h.id]) return;
        if (h.need ? reaches(cur.rules, h) && !reaches(next.rules, h) : cur.by[h.id]!.length && !next.by[h.id]!.length && free(next.by, h.id)) queue.push(h.id);
      });
      cur = next;
    }
    return build(list);
  }
  function isDefault(st: KeyState, id: string): boolean { return same(st.by[id]!, defaults(id)); }
  /** Why key cannot simply go to id: { reserved } or { fixed } with the words, or { other, text, canTake, gives } when
   *  a command has it where both can apply, or null when it is free. canTake: Swap them works. gives: the keys other
   *  would get; with none, the button reads Take it. */
  function clash(st: KeyState, id: string, key: string): Clash | null {
    var no = refuse(id, key);
    if (no) return { reserved: !!no.reserved, fixed: !!no.fixed, text: no.why + ' Press another key.' };
    var hs = holders(st.by, key, CMD[id]!.when || '', id);
    if (!hs.length) return null;
    var t = trade(st, id, key), names = hs.map(function (h) { return CMD[h]!.t; }).join(' and ');
    var tail = !t.blocked ? '.' : hs.length > 1 ? '. ' + CMD[t.blocked]!.t + ' always keeps a key.' : ', which always keeps a key.';
    return { other: hs[0]!, text: label(key) + ' is already ' + names + tail, canTake: !t.blocked, gives: t.gives || [] };
  }
  /** The command a key runs here, or null: the last rule for the key whose when holds, as in T3 Code. */
  function lookup(st: KeyState, key: string, ctx: KeyContext): string | null {
    for (var i = st.rules.length - 1; i >= 0; i--) {
      var r = st.rules[i]!;
      if (r.key === key && holds(r.when, ctx)) return r.id;
    }
    return null;
  }
  /** What the page does with a key: null, as it always has; { as: key, id }, the key the command had by default;
   *  { run: id } for a command with no default key; { off: id } for a default key that no command has here while its
   *  own command applies here, since the page would still act on it. */
  function route(st: KeyState, key: string | null | undefined, ctx: KeyContext): KeyRoute {
    if (!key) return null;
    var id = lookup(st, key, ctx);
    if (id) {
      var c = CMD[id]!;
      if (c.keys.indexOf(key) >= 0) return null;
      return c.keys.length ? { as: c.keys[0]!, id: id } : { run: id };
    }
    for (var i = 0; i < COMMANDS.length; i++) {
      var d = COMMANDS[i]!;
      if (d.keys.indexOf(key) >= 0 && holds(d.when, ctx)) return { off: d.id };
    }
    return null;
  }
  var KEYNAME = dict({ enter: 'Enter', escape: 'Escape', space: ' ', tab: 'Tab', backspace: 'Backspace', 'delete': 'Delete', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' });
  /** A stand-in keydown for a key, from the real one ev: what the page's handler reads, and preventDefault. */
  function synth(key: string, ev: KeyEventLike | null | undefined) {
    var p = parse(key)!, k = p.key;
    return {
      key: KEYNAME[k] || (/^f\d+$/.test(k) ? k.toUpperCase() : p.shift && /^[a-z]$/.test(k) ? k.toUpperCase() : k),
      code: /^[a-z]$/.test(k) ? 'Key' + k.toUpperCase() : /^[0-9]$/.test(k) ? 'Digit' + k : '',
      metaKey: p.mod && !!mac, ctrlKey: p.mod && !mac, altKey: p.alt, shiftKey: p.shift,
      repeat: !!(ev && ev.repeat), target: ev && ev.target, synthetic: true,
      preventDefault: function () { if (ev && ev.preventDefault) ev.preventDefault(); }
    };
  }
  /** Whether a key is plain (no ⌘ or ⌥): it types in a text field, so it never acts there. */
  function plain(key: string | null | undefined): boolean { return !!key && !/^(mod|alt)\+/.test(key); }
  /** Whether an open dialog keeps a key for itself: every plain key, and ⌘↵, which sends in the bar and in New thread. */
  function dialogKey(key: string | null | undefined): boolean { return plain(key) || key === 'mod+enter'; }

  return {
    COMMANDS: COMMANDS, CMD: CMD, FIXED: FIXED, mac: !!mac,
    parse: parse, norm: norm, comboOf: comboOf, glyphs: glyphs, label: label,
    okWhen: okWhen, holds: holds, exclusive: exclusive,
    build: build, compile: compile, defaultList: defaultList, toList: toList, keysOf: keysOf, set: set, swap: swap, reset: reset, isDefault: isDefault,
    clash: clash, refuse: refuse, lookup: lookup, route: route, synth: synth, plain: plain, dialogKey: dialogKey
  };
}
