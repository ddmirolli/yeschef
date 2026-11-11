// The public copy stays clean (tools/public-tree.ts).
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PRIVATE, build, check, scanBytes, scanText } from './public-tree.ts';

const rules = (text: string) => scanText('x', text).map((h) => h[2]);

test('each rule catches its case', () => {
  // Built at run time, so this file never holds a banned string itself.
  const cases: [rule: string, text: string][] = [
    ['tailnet address', 'https://mac.' + 'tail' + '1a2b3c.ts' + '.net:8494'],
    ['tailnet address', '/mac\\.' + 'tail' + '1a2b3c\\.ts\\.net/'], // as written in a regex
    ['tailnet address', 'the ' + 'tail' + '1a2b3c tailnet'],
    ['tailnet address', 'https://mac.yak-' + 'bebop.ts' + '.net:8494'], // a word-style tailnet name (r3 on #63)
    ['home path', '/Us' + 'ers/realname/rw-artifacts/a.png'],
    ['home path', '/\\/Us' + 'ers\\/realname\\/rw-artifacts/'], // as written in a regex or JSON
    ['home path', 'HOME=/Us' + 'ers/realname'], // the folder itself (r3 on #63)
    ['home path', '/Us' + 'ers/meredith/x'], // a name that starts like a placeholder
    ['pitch name', 'Offer b to ' + 'The' + 'o when you pitch'],
    ['1Password reference', 'op:' + '//Vault/Item/field'],
    ['1Password reference', '{"key": "op:' + '\\/\\/Vault\\/Item\\/field"}'], // JSON-escaped (r4 on #63)
    ['private key', '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'],
    ['API key', 'sk-' + 'a'.repeat(24)],
    ['API key', 'LINEAR_API_KEY=' + 'lin_api_' + 'a1'.repeat(20)],
    ['API key', 'bb_' + 'live_' + 'a1'.repeat(12)],
    ['API key', 'OP_SERVICE_ACCOUNT_TOKEN=' + 'ops_' + 'eyJ' + 'a'.repeat(60)],
  ];
  for (const [rule, text] of cases) assert.deepEqual(new Set(rules(text)), new Set([rule]), text);
});

test('a secret is never kept in a hit', () => {
  // PR-Agent r1 on #63: a found key must not reach the terminal or a failed test's output.
  for (const text of ['lin_api_' + 'a1'.repeat(20), 'op:' + '//Vault/Item/field', '-----BEGIN ' + 'PRIVATE KEY-----']) {
    const hits = scanText('x', text);
    assert.deepEqual(hits.map((h) => h[3]), ['(hidden)'], hits[0]?.[2]);
  }
});

test('placeholders pass', () => {
  for (const text of ['/Users/chef/rw-artifacts/a.png', '/Users/<name>/x', '/Users/you', '/Users/Shared/x',
    'https://mac.example.ts.net:8443', 'https://<mac>.<tailnet>.ts.net:8494',
    'LINEAR_API_KEY=<op:// reference>', 'Theory and theorems', 'Theodore']) {
    assert.deepEqual(rules(text), [], text);
  }
});

test('line numbers follow every line ending', () => {
  const hit = 'The' + 'o';
  assert.deepEqual(scanText('x', `a\r\nb\rc\n${hit}`).map((h) => h[1]), [4]);
  assert.deepEqual(scanText('x', `a\u2028${hit}`).map((h) => h[1]), [2]);
});

test('binary files are skipped', () => {
  assert.deepEqual(scanBytes('a.png', Buffer.from('\x89PNG\0' + 'tail' + '1a2b3c.ts' + '.net', 'latin1')), []);
});

test('private files are not scanned', (ctx) => {
  const root = mkdtempSync(join(tmpdir(), 'public-tree-'));
  ctx.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const priv = [...PRIVATE].sort()[0]!;
  mkdirSync(join(root, dirname(priv)), { recursive: true });
  writeFileSync(join(root, priv), 'The' + 'o\n');
  writeFileSync(join(root, 'a.md'), 'The' + 'o\n');
  assert.deepEqual(check(root, [priv, 'a.md']).map((h) => h[0]), ['a.md']);
});

test('the tracked files are clean', () => {
  const hits = check().map((h) => h.slice(0, 3)); // file, line and rule only
  assert.deepEqual(hits, [], hits.map((h) => h.join(':')).join('\n'));
});

test('build leaves the private files out', (ctx) => {
  const parent = mkdtempSync(join(tmpdir(), 'public-tree-'));
  ctx.onTestFinished(() => rmSync(parent, { recursive: true, force: true }));
  const out = join(parent, 'public');
  const { files, hits } = build(out);
  assert.deepEqual(hits.map((h) => h.slice(0, 3)), []);
  assert.ok(files.includes('LICENSE'));
  for (const p of PRIVATE) {
    assert.ok(!files.includes(p), p);
    assert.ok(!existsSync(join(out, p)), p);
  }
  assert.throws(() => build(out), /already exists/);
});
