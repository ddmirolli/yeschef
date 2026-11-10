import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalize, forProject, brief, visualCall, missingShots, MAX_NOTES } from './kitchen.mjs';

const call = (question, ...options) => ({ calls: [{ question, options: options.map((text, i) => ({ letter: 'abcd'[i], text })) }] });

test('a new kitchen starts with the defaults', () => {
  assert.deepEqual(normalize(null), { all: { ...DEFAULTS }, projects: {} });
  assert.equal(DEFAULTS.screens, 'on');
  assert.equal(DEFAULTS.missing, 'flag');
  assert.equal(DEFAULTS.reviewer, 'none');
});

test('unknown rules, bad values and bad project ids are dropped', () => {
  const r = normalize({ all: { reviewer: 'coderabbit', browser: 'netscape', evil: 'x' }, projects: { 'ok-1': { browser: 'local', bad: 1 }, '../x': { browser: 'local' }, empty: { browser: 'nope' } } });
  assert.equal(r.all.reviewer, 'coderabbit');
  assert.equal(r.all.browser, DEFAULTS.browser);
  assert.equal('evil' in r.all, false);
  assert.deepEqual(r.projects, { 'ok-1': { browser: 'local' } });
});

test('a project override wins over All projects; other rules inherit', () => {
  const rules = { all: { reviewer: 'coderabbit', council: 'ask' }, projects: { yc: { reviewer: 'pr-agent' } } };
  assert.equal(forProject(rules, 'yc').reviewer, 'pr-agent');
  assert.equal(forProject(rules, 'yc').council, 'ask');
  assert.equal(forProject(rules, 'other').reviewer, 'coderabbit');
});

test('notes are kept, capped, and can be overridden per project', () => {
  const long = 'x'.repeat(MAX_NOTES + 50);
  assert.equal(normalize({ all: { notes: long } }).all.notes.length, MAX_NOTES);
  assert.equal(forProject({ all: { notes: 'a' }, projects: { p: { notes: 'b' } } }, 'p').notes, 'b');
});

test('the brief lists each rule that adds a line, then the notes', () => {
  const b = brief({ all: { reviewer: 'coderabbit', browser: 'browserbase', notes: 'Use the run skill.' } }, null);
  assert.match(b, /^\n\n---\nRules \(Yes Chef\):\n- /);
  assert.match(b, /screenshot of each option/);
  assert.match(b, /CodeRabbit is the pull-request reviewer/);
  assert.match(b, /Browserbase/);
  assert.match(b, /Use the run skill\.$/);
  assert.doesNotMatch(b, /Linear/);
});

test('a kitchen with every rule off sends no brief', () => {
  assert.equal(brief({ all: { screens: 'off', form: 'any', council: 'agent' } }, null), '');
});

test('a call about something you can see is visual; a merge call is not', () => {
  assert.equal(visualCall(call('On a phone, the Save $996/mo pill sits below the plan cards. Should it also show at the top of the location picker?', 'Yes, also show it at the top.', 'No, keep it where it is.')), true);
  assert.equal(visualCall(call('Which layout should the hero use?', 'Centered headline', 'Split')), true);
  assert.equal(visualCall(call('Merge #2362 into staging?', 'Yes. I merge with the gate script.', 'Wait for CodeRabbit.')), false);
  assert.equal(visualCall(null), false);
});

test('the Pass flags a visual call with no screenshots, only when the rules say so', () => {
  const v = call('Should the pill show at the top of the page?', 'Yes', 'No');
  assert.equal(missingShots({}, 'p', v, 0), true);
  assert.equal(missingShots({}, 'p', v, 2), false);
  assert.equal(missingShots({ all: { missing: 'off' } }, 'p', v, 0), false);
  assert.equal(missingShots({ all: { screens: 'off' } }, 'p', v, 0), false);
  assert.equal(missingShots({ projects: { p: { missing: 'off' } } }, 'p', v, 0), false);
  assert.equal(missingShots({}, 'p', call('Merge #1?', 'Yes', 'No'), 0), false);
});

test('a change from Settings touches one rule and keeps the rest (PR-Agent on #49: a stale tab puts nothing back)', async () => {
  const { change } = await import('./kitchen.mjs');
  const now = { all: { reviewer: 'coderabbit', browser: 'browserbase' }, projects: { yc: { reviewer: 'pr-agent' } } };
  const a = change(now, { key: 'browser', value: 'local' }).rules;
  assert.equal(a.all.reviewer, 'coderabbit');
  assert.equal(a.all.browser, 'local');
  assert.equal(a.projects.yc.reviewer, 'pr-agent');
  const b = change(a, { scope: 'yc', key: 'council', value: 'never' }).rules;
  assert.deepEqual(b.projects.yc, { reviewer: 'pr-agent', council: 'never' });
  const c = change(change(b, { scope: 'yc', key: 'reviewer', reset: true }).rules, { scope: 'yc', key: 'council', reset: true }).rules;
  assert.equal('yc' in c.projects, false);
  assert.equal(change(now, { scope: 'yc', key: 'notes', value: 'x'.repeat(MAX_NOTES + 9) }).rules.projects.yc.notes.length, MAX_NOTES);
  assert.ok(change(now, { key: 'browser', value: 'netscape' }).error);
  assert.ok(change(now, { key: 'evil', value: 'on' }).error);
  assert.ok(change(now, { scope: '../x', key: 'browser', value: 'local' }).error);
  assert.ok(change(now, { key: 'browser', reset: true }).error);
});
