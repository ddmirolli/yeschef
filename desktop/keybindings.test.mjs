// Settings → Shortcuts' file on the Mac. Run: node --test desktop/keybindings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ENTRIES, cleanKeybindings, ensureKeybindings, readKeybindings, writeKeybindings } from './keybindings.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'yc-keys-'));

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
    const list = [{ key: 'h', command: 'ticket.reply', when: 'ticket' }, { key: 'mod+shift+u', command: 'view.team' }, { command: '-ticket.hold' }];
    assert.deepEqual(writeKeybindings(f, list), { ok: true });
    assert.equal(readFileSync(f, 'utf8'), '[\n  {"key":"h","command":"ticket.reply","when":"ticket"},\n  {"key":"mod+shift+u","command":"view.team"},\n  {"command":"-ticket.hold"}\n]\n');
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
    assert.match(readKeybindings(f).error, /not valid JSON/);
    writeFileSync(f, 'x'.repeat(300 * 1024));
    assert.match(readKeybindings(f).error, /larger than 256 KB/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('only a list of commands with short text fields is saved; other fields are kept as written', () => {
  assert.match(cleanKeybindings({}).error, /must be a list/);
  assert.match(cleanKeybindings(Array(MAX_ENTRIES + 1).fill({ command: 'x' })).error, /at most 500/);
  assert.match(cleanKeybindings([{ key: 'h' }]).error, /needs a command/);
  assert.match(cleanKeybindings(['h']).error, /needs a command/);
  assert.match(cleanKeybindings([{ key: 7, command: 'x' }]).error, /key must be text/);
  assert.match(cleanKeybindings([{ key: 'k'.repeat(201), command: 'x' }]).error, /at most 200/);
  // Inherited fields are never read; an own field another app wrote stays, as JSON.
  assert.deepEqual(cleanKeybindings([{ key: 'h', command: 'x', args: { a: 1 }, __proto__: { when: 'y' } }]), { list: [{ key: 'h', command: 'x', args: { a: 1 } }] });
  const odd = JSON.parse('[{"command":"x","__proto__":{"p":1},"skip":null}]');
  const kept = cleanKeybindings(odd).list[0];
  assert.equal(Object.getPrototypeOf(kept), Object.prototype, 'a __proto__ field never becomes the prototype');
  assert.equal(JSON.stringify(kept), '{"command":"x","__proto__":{"p":1},"skip":null}');
  assert.deepEqual(cleanKeybindings([{ command: 'x', f() {} }]), { list: [{ command: 'x' }] }, 'nothing that is not JSON');
  const d = dir();
  try {
    const f = join(d, 'keybindings.json');
    assert.match(writeKeybindings(f, 'nope').error, /must be a list/);
    assert.deepEqual(readdirSync(d), [], 'a refused list writes nothing');
    // The most the cleaner lets through can still be more than the reader takes: then nothing is written either.
    const big = Array.from({ length: MAX_ENTRIES }, (_, i) => ({ key: 'k'.repeat(200), command: `c${i}`.padEnd(200, 'x'), when: 'w'.repeat(200) }));
    assert.match(writeKeybindings(f, big).error, /larger than 256 KB/);
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

test('opening the file makes an empty one first, and never replaces one there', () => {
  const d = dir();
  try {
    const f = join(d, 'keybindings.json');
    assert.deepEqual(ensureKeybindings(f), { ok: true });
    assert.equal(readFileSync(f, 'utf8'), '[]\n');
    writeFileSync(f, '[{"key":"y","command":"view.you"}');
    assert.deepEqual(ensureKeybindings(f), { ok: true });
    assert.equal(readFileSync(f, 'utf8'), '[{"key":"y","command":"view.you"}', 'a broken file stays for you to fix');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
