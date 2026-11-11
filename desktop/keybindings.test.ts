// Settings → Shortcuts' file on the Mac. Run: npm test --prefix desktop -- keybindings.test.ts
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ENTRIES, cleanKeybindings, ensureKeybindings, readKeybindings, syncKeybindings, writeKeybindings } from './keybindings.ts';
import { keysCore } from '../client/keys.ts';
import { nth } from '../client/test/expect.ts';

const DEFAULTS = keysCore(true).defaultList();

const dir = () => mkdtempSync(join(tmpdir(), 'yc-keys-'));
/** The error a result carries, or the test fails. */
const errorOf = (r: { error?: string | undefined }): string => { assert.ok(r.error !== undefined, 'no error'); return r.error; };

test('no file is no list yet; an empty file is an empty list', () => {
  const d = dir();
  try {
    const f = join(d, 'keybindings.json');
    assert.deepEqual(readKeybindings(f), { list: null });
    writeFileSync(f, '  \n');
    assert.deepEqual(readKeybindings(f), { list: [] });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the list round-trips, one entry a line, in T3 Code\'s shape, and nothing is left behind', () => {
  const d = dir();
  try {
    const f = join(d, 'sub', 'keybindings.json');
    const list = [{ key: 'h', command: 'ticket.reply', when: 'ticket' }, { key: 'mod+shift+u', command: 'view.team' }, { command: 'thread.stop' }];
    assert.deepEqual(writeKeybindings(f, list), { ok: true });
    assert.equal(readFileSync(f, 'utf8'), '[\n  {"key":"h","command":"ticket.reply","when":"ticket"},\n  {"key":"mod+shift+u","command":"view.team"},\n  {"command":"thread.stop"}\n]\n');
    assert.deepEqual(readKeybindings(f), { list });
    assert.deepEqual(readdirSync(join(d, 'sub')), ['keybindings.json']);
    assert.deepEqual(writeKeybindings(f, []), { ok: true });
    assert.equal(readFileSync(f, 'utf8'), '[]\n');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a file that is not JSON is named, never guessed at', () => {
  const d = dir();
  try {
    const f = join(d, 'keybindings.json');
    writeFileSync(f, '[{"key": "h",');
    assert.match(errorOf(readKeybindings(f)), /not valid JSON/);
    writeFileSync(f, 'x'.repeat(300 * 1024));
    assert.match(errorOf(readKeybindings(f)), /larger than 256 KB/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('only a list of commands with short text fields is saved; other fields are kept as written', () => {
  assert.match(errorOf(cleanKeybindings({})), /must be a list/);
  assert.match(errorOf(cleanKeybindings(Array(MAX_ENTRIES + 1).fill({ command: 'x' }))), /at most 500/);
  assert.match(errorOf(cleanKeybindings([{ key: 'h' }])), /needs a command/);
  assert.match(errorOf(cleanKeybindings(['h'])), /needs a command/);
  assert.match(errorOf(cleanKeybindings([{ key: 7, command: 'x' }])), /key must be text/);
  assert.match(errorOf(cleanKeybindings([{ key: 'k'.repeat(201), command: 'x' }])), /at most 200/);
  // Inherited fields are never read; an own field another app wrote stays, as JSON.
  assert.deepEqual(cleanKeybindings([{ key: 'h', command: 'x', args: { a: 1 }, __proto__: { when: 'y' } }]), { list: [{ key: 'h', command: 'x', args: { a: 1 } }] });
  const odd = JSON.parse('[{"command":"x","__proto__":{"p":1},"skip":null}]');
  const kept = nth(cleanKeybindings(odd).list);
  assert.equal(Object.getPrototypeOf(kept), Object.prototype, 'a __proto__ field never becomes the prototype');
  assert.equal(JSON.stringify(kept), '{"command":"x","__proto__":{"p":1},"skip":null}');
  assert.deepEqual(cleanKeybindings([{ command: 'x', f() {} }]), { list: [{ command: 'x' }] }, 'nothing that is not JSON');
  const d = dir();
  try {
    const f = join(d, 'keybindings.json');
    assert.match(errorOf(writeKeybindings(f, 'nope')), /must be a list/);
    assert.deepEqual(readdirSync(d), [], 'a refused list writes nothing');
    // The most the cleaner lets through can still be more than the reader takes: then nothing is written either.
    const big = Array.from({ length: MAX_ENTRIES }, (_, i) => ({ key: 'k'.repeat(200), command: `c${i}`.padEnd(200, 'x'), when: 'w'.repeat(200) }));
    assert.match(errorOf(writeKeybindings(f, big)), /larger than 256 KB/);
    assert.deepEqual(readdirSync(d), [], 'a list too large to read back writes nothing');
    const most = big.slice(0, 100);
    assert.deepEqual(writeKeybindings(f, most), { ok: true });
    assert.deepEqual(readKeybindings(f), { list: most }, 'what is written reads back');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a change in Settings keeps another command\'s entry as written, args too', () => {
  const d = dir();
  try {
    const f = join(d, 'keybindings.json');
    const theirs = { key: 'mod+shift+t', command: 'terminal.split', when: 'terminalFocus', args: { cwd: 'here', n: 2 } };
    assert.deepEqual(writeKeybindings(f, [{ key: 'y', command: 'view.you' }, theirs]), { ok: true });
    assert.deepEqual(readKeybindings(f).list, [{ key: 'y', command: 'view.you' }, theirs]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('opening the file writes every default first, as T3 Code does, and never replaces one there', () => {
  const d = dir();
  try {
    const f = join(d, 'keybindings.json');
    assert.deepEqual(ensureKeybindings(f, true), { ok: true });
    assert.deepEqual(readKeybindings(f).list, DEFAULTS);
    writeFileSync(f, '[{"key":"y","command":"view.you"}');
    assert.deepEqual(ensureKeybindings(f, true), { ok: true });
    assert.equal(readFileSync(f, 'utf8'), '[{"key":"y","command":"view.you"}', 'a broken file stays for you to fix');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('start-up sync, as T3 Code\'s: no file or an empty list gets every default', () => {
  const d = dir();
  try {
    const f = join(d, 'keybindings.json');
    assert.deepEqual(syncKeybindings(f, true), { ok: true, wrote: true });
    assert.deepEqual(readKeybindings(f).list, DEFAULTS);
    assert.deepEqual(syncKeybindings(f, true), { ok: true, wrote: false }, 'a second start changes nothing');
    writeFileSync(f, '[]\n');
    assert.deepEqual(syncKeybindings(f, true), { ok: true, wrote: true });
    assert.deepEqual(readKeybindings(f).list, DEFAULTS);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('start-up sync: the defaults of a command the file does not name go before its entries, unless an entry has their key and when', () => {
  const d = dir();
  try {
    const f = join(d, 'keybindings.json');
    // A file from an older Yes Chef: Reply on G, and View: You on ⌘K, the Action bar's key and when.
    const mine = [{ key: 'g', command: 'ticket.reply', when: 'ticket' }, { key: 'mod+k', command: 'view.you', args: { keep: true } }];
    writeKeybindings(f, mine);
    assert.deepEqual(syncKeybindings(f, true), { ok: true, wrote: true });
    const list = readKeybindings(f).list;
    assert.ok(Array.isArray(list));
    assert.deepEqual(list.slice(-2), mine, 'its entries stay last, as written, so they win');
    const added = list.slice(0, -2);
    assert.deepEqual(added, DEFAULTS.filter((e) => e.command !== 'ticket.reply' && e.command !== 'commandPalette.toggle'));
    assert.ok(!added.some((e) => e.command === 'ticket.reply'), 'Reply keeps only G');
    assert.ok(!added.some((e) => e.key === 'mod+k'), 'the Action bar default is left out: View: You has ⌘K');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('start-up sync leaves a file alone when Yes Chef cannot use an entry, or cannot read it', () => {
  const d = dir();
  try {
    const f = join(d, 'keybindings.json');
    for (const text of ['[{"key":"y","command":"chat.newLocal"}]\n', '[{"key":"mod+q","command":"view.you"}]\n', '{"key":"y"}\n']) {
      writeFileSync(f, text);
      assert.deepEqual(syncKeybindings(f, true), { ok: true, wrote: false }, text);
      assert.equal(readFileSync(f, 'utf8'), text);
    }
    writeFileSync(f, '[{"key": "h",');
    assert.match(errorOf(syncKeybindings(f, true)), /not valid JSON/);
    assert.equal(readFileSync(f, 'utf8'), '[{"key": "h",');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
