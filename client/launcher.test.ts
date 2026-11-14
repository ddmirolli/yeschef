// New thread's launcher (client/launcher.ts): T3's models as the launcher reads them, what a launch may send, and the
// pure parts the page runs.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { capsFrom, launchDialog, launchSettings, launcherCore } from './launcher.ts';
import { nodeSource } from './test/node-source.ts';

const CORE_SRC = nodeSource(new URL('./launcher.ts', import.meta.url), 'launcherCore');
const INSTALL_SRC = nodeSource(new URL('./launcher.ts', import.meta.url), 'installLauncher');

// orchestrator_capabilities, cut down from a real answer (2026-11-14).
const RAW = {
  runtimeMode: 'auto',
  interactionMode: 'default',
  providers: [
    { providerInstanceId: 'codex', driverKind: 'codex', displayName: 'Codex', constraints: [], models: [
      { id: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default: 'low' }, { id: 'serviceTier', values: ['default', 'priority'], default: 'default' }] },
    ] },
    { providerInstanceId: 'claudeAgent', driverKind: 'claudeAgent', displayName: 'Claude — Personal', constraints: ['Provider instance is disabled.'], models: [{ id: 'claude-opus-5-5' }] },
    { providerInstanceId: 'claude_pooled', driverKind: 'claudeAgent', displayName: 'Claude (pooled)', constraints: [], models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', options: [{ id: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'], default: 'medium' }, { id: 'ultracode', values: [false, true] }] },
    ] },
    { providerInstanceId: 'cursor', driverKind: 'cursor', displayName: 'Cursor', constraints: [], models: [] },
    { providerInstanceId: 'kiro', driverKind: 'kiro', displayName: 'Kiro', constraints: [], runtimeModes: ['approval-required', 'full-access'], models: [{ id: 'default', label: 'Kiro default' }] },
  ],
};

test('the launcher lists the providers T3 can start a thread on, without the disabled or empty ones', () => {
  const caps = capsFrom(RAW);
  assert.ok(caps.ok);
  assert.deepEqual(caps.providers.map((p) => p.id), ['codex', 'claude_pooled', 'kiro']);
  assert.equal(caps.ceiling, 'auto');
  const [codex, claude, kiro] = caps.providers;
  // A model with no label is named the way T3 names it; the effort is the option T3 gives, with its default.
  assert.deepEqual(codex!.models[0], { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', effort: { id: 'reasoningEffort', values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], def: 'low' } });
  assert.equal(claude!.models[0]!.effort!.id, 'effort');
  assert.deepEqual(kiro!.models[0]!.effort, null);
  assert.deepEqual(kiro!.modes, ['approval-required', 'full-access']);
  assert.equal(capsFrom({}).ok, false);
  assert.equal(capsFrom(null).ok, false);
});

test('a launch sends only what was picked, and refuses anything T3 could not have listed', () => {
  assert.deepEqual(launchSettings({}), {});
  assert.deepEqual(launchSettings({ instance: 'codex', model: 'gpt-6.1-sol', effortId: 'reasoningEffort', effort: 'high', runtime: 'auto' }), {
    modelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'high' }] }, runtimeMode: 'auto',
  });
  assert.deepEqual(launchSettings({ instance: 'kiro', model: 'default' }), { modelSelection: { instanceId: 'kiro', model: 'default' } });
  assert.deepEqual(launchSettings({ runtime: 'approval-required' }), { runtimeMode: 'approval-required' });
  for (const bad of [{ instance: 'codex' }, { model: 'x' }, { instance: 'a b', model: 'x' }, { instance: 'codex', model: 'm', effortId: 'serviceTier', effort: 'priority' }, { instance: 'codex', model: 'm', effortId: 'effort', effort: 'HIGH' }, { runtime: 'root' }]) {
    assert.ok('error' in launchSettings(bad), JSON.stringify(bad));
  }
});

test('the effort glyph is T3’s: named levels are words, the rest are rising bars', () => {
  const c = launcherCore();
  const claude = ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'];
  assert.deepEqual(c.glyph(claude, 'high'), { count: 4, filled: 3 });
  assert.equal(c.glyph(claude, 'max'), null);
  assert.equal(c.glyph(claude, 'ultrathink'), null);
  assert.deepEqual(c.heights(4, 10), [4, 6, 8, 10]);
  assert.equal(c.word('xhigh'), 'Extra high');
  assert.equal(c.short('Claude Opus 5.5'), 'Opus 5.5');
  assert.equal(c.short('GPT-6.1 Sol'), 'GPT-6.1 Sol');
});

test('permissions never go past what Yes Chef was approved for, or what the provider runs', () => {
  const c = launcherCore();
  assert.deepEqual(c.modesFor('auto', null), ['approval-required', 'auto-accept-edits', 'auto']);
  // Before T3 says the approved level, only the project default is offered (PR-Agent r1 on #79).
  assert.deepEqual(c.modesFor(null, null), []);
  assert.deepEqual(c.modesFor('full-access', null), c.ORDER);
  assert.deepEqual(c.modesFor('full-access', { modes: ['approval-required', 'full-access'] }), ['approval-required', 'full-access']);
  assert.equal(c.MODES['approval-required']!.label, 'Supervised');
});

test('the dialog keeps the fields the page and server read, and the picker code runs on its own', () => {
  const html = launchDialog();
  for (const name of ['nonce', 'title', 'project', 'prompt', 'workspace', 'instance', 'model', 'effortId', 'effort', 'runtime']) assert.match(html, new RegExp(`name="${name}"`), name);
  assert.match(html, /<button type="submit" name="kind" value="launch" class="primary/);
  // Inlined by source text into the page's <script>: no names from the module, and nothing that closes the script.
  const ctx = vm.createContext({});
  const core = vm.runInContext(`(${CORE_SRC})()`, ctx);
  assert.equal(core.word('low'), 'Low');
  const install = vm.runInContext(`(${INSTALL_SRC})`, vm.createContext({ document: { getElementById: () => null } }));
  assert.equal(install({ $: () => null, $$: () => [], store: () => null }, core), null);
  for (const name of ['RUNTIME_MODES', 'EFFORT_IDS', 'capsFrom', 'launchDialog', 'named(']) assert.equal(INSTALL_SRC.includes(name) || CORE_SRC.includes(name), false, name);
  for (const src of [CORE_SRC, INSTALL_SRC]) assert.equal(/<\/script/i.test(src), false);
});
