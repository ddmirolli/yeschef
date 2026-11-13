// T3 Code's changed-file kinds (client/changed-file-kind.ts): T3's own cases (changedFileKind.test.ts), then the
// files Too big's "Hide test files" hides.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { classifyChangedFile, isTestChangedFile } from './changed-file-kind.ts';

test("a path's kind is T3 Code's", () => {
  for (const [path, kind] of [
    ['src/contest.py', 'code'],
    ['test/fixtures/pr.json', 'mocks'],
    ['pnpm-lock.yaml', 'generated'],
    ['convex/_generated/api.d.ts', 'generated'],
    ['src/agent.eval.ts', 'tests'],
    ['evals/title-generation.ts', 'tests'],
    ['README.md', 'docs'],
    ['tests/README.md', 'tests'],
  ] as const) assert.equal(classifyChangedFile(path), kind, path);
});

test('test files are tests and their support; code, docs and lockfiles are not', () => {
  for (const path of ['packages/statements/src/csv/__tests__/writer.test.ts', 'src/a.spec.tsx', 'app/models/user_test.go', 'tests/test_api.py',
    'src/FooTest.java', 'src/__snapshots__/a.snap', 'src/__mocks__/fs.ts', 'web/user.fixture.json', 'vitest.setup.ts'])
    assert.equal(isTestChangedFile(path), true, path);
  for (const path of ['src/Latest.java', 'src/contest.py', 'pnpm-lock.yaml', 'docs/testing.md', 'src/attest.ts', 'apps/web/src/statements/ExportButton.tsx'])
    assert.equal(isTestChangedFile(path), false, path);
});
