// The window's preload as Electron loads it (build/preload.ts): one CommonJS file that needs only electron, and the
// bridge it gives the page. The window itself is checked by the capture run (desktop/README.md).
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { preloadCode } from './build/preload.ts';

test('the preload is plain CommonJS, needs only electron, and gives the page the bridge and nothing else', () => {
  const code = preloadCode();
  assert.doesNotMatch(code, /^\s*(import|export)\b/m, 'no module syntax');
  const asked: string[] = [];
  const exposed: Record<string, unknown> = {};
  const invoked: unknown[][] = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { exposed[name] = api; } },
    ipcRenderer: { invoke: (...args: unknown[]) => { invoked.push(args); return Promise.resolve(null); }, on: () => {} },
  };
  // Electron runs a sandboxed preload as the body of a function that gets require; so does this.
  const run = runInNewContext(`(function (require) {\n${code}\n})`, { document: { readyState: 'complete' } }) as (req: (name: string) => unknown) => void;
  run((name) => { asked.push(name); return electron; });
  assert.deepEqual(asked, ['electron']);
  assert.deepEqual(Object.keys(exposed), ['yeschef']);
  const bridge = exposed.yeschef as { act(b: unknown): unknown; theme(t: unknown): unknown; keys: { read(): unknown; write(l: unknown): unknown; open(): unknown } };
  bridge.act(42);
  bridge.theme('dark');
  bridge.keys.read();
  bridge.keys.write([]);
  bridge.keys.open();
  // The first ask is the card's, made as the page loads. Objects made in the preload's context compare as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [
    ['yeschef:card', null], ['yeschef:act', '42'], ['yeschef:theme', 'dark'],
    ['yeschef:keys', { op: 'read' }], ['yeschef:keys', { op: 'write', list: [] }], ['yeschef:keys', { op: 'open' }],
  ]);
});
