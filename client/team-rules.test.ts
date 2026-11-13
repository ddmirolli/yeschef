import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { cleanTeamRules, cleanAreaRules, changeTeamRule, changeArea, callRules, teamMode, areaScopes, TEAM_DEFAULTS } from './team-rules.ts';
import { RULES } from './open-kitchen.ts';

test('a team starts with the brief\'s proposed rules, and the model checks off', () => {
  const t = cleanTeamRules(null);
  assert.deepEqual(t, { escalateMin: 15, stuckMin: 20, waitMin: 15, failRuns: 3, bigLines: 800, bigFiles: 30, checks: false, comparesDay: 50, dupAt: 90 });
  assert.deepEqual(t, { ...TEAM_DEFAULTS });
  // The calls' rules come out as they were before Rules.
  assert.deepEqual(callRules(null), RULES);
});

test('a value from a roster that is not one of the choices is the default', () => {
  const t = cleanTeamRules({ escalateMin: 7, stuckMin: '30', waitMin: 30, failRuns: 5, bigLines: 800, bigFiles: 60, checks: 'yes', comparesDay: 0, dupAt: 95 });
  assert.equal(t.escalateMin, 15);
  assert.equal(t.stuckMin, 20, 'a string is not a number');
  assert.equal(t.waitMin, 30);
  assert.equal(t.failRuns, 5);
  assert.deepEqual([t.bigLines, t.bigFiles], [800, 30], 'a size that is not one pair of the choices is the default pair');
  assert.equal(t.checks, false, 'only true turns the model on');
  assert.equal(t.comparesDay, 0, 'no limit is a choice');
  assert.equal(t.dupAt, 95);
  for (const odd of [[], 'x', 5]) assert.deepEqual(cleanTeamRules(odd), { ...TEAM_DEFAULTS });
});

test('a change from Settings must be one of the choices', () => {
  const t = cleanTeamRules(null);
  assert.equal(changeTeamRule(t, 'stuckMin', '30').rules?.stuckMin, 30);
  assert.deepEqual(changeTeamRule(t, 'big', '1500:60').rules && [changeTeamRule(t, 'big', '1500:60').rules!.bigLines, changeTeamRule(t, 'big', '1500:60').rules!.bigFiles], [1500, 60]);
  assert.equal(changeTeamRule(t, 'checks', 'on').rules?.checks, true);
  assert.equal(changeTeamRule(t, 'comparesDay', '0').rules?.comparesDay, 0);
  for (const [k, v] of [['stuckMin', '25'], ['stuckMin', ''], ['big', '800:60'], ['checks', 'true'], ['dupAt', '9e1x'], ['comparesDay', ' ']]) {
    assert.equal(changeTeamRule(t, k!, v!).error, 'That is not one of the choices.', `${k}=${v}`);
  }
  assert.equal(changeTeamRule(t, 'quietMin', '10').error, 'There is no such rule.');
  assert.equal(changeTeamRule(t, 'stuckMin', '30').rules === t, false, 'a change never edits the rules it was given');
  assert.equal(t.stuckMin, 20);
});

test('the calls use the team\'s thresholds; the lead\'s steps keep their ratios', () => {
  const r = callRules({ ...TEAM_DEFAULTS, escalateMin: 30, stuckMin: 60, waitMin: 5, failRuns: 2, bigLines: 400, bigFiles: 15 });
  assert.deepEqual(r, { ...RULES, escalateMin: 30, stuckMin: 60, waitMin: 5, waitLeadMin: 10, failRuns: 2, failLeadRuns: 4, bigLines: 400, bigFiles: 15 });
});

test('an area keeps its project names once, its mode and its budget', () => {
  assert.deepEqual(cleanAreaRules(null), { projects: [], mode: 'open', budget: 10 });
  assert.deepEqual(cleanAreaRules({ projects: [' Fernpay ', 'Fernpay', '', 3, 'Loop\nline'], mode: 'brigade', budget: 20 }), { projects: ['Fernpay', '3', 'Loop line'], mode: 'brigade', budget: 20 });
  assert.deepEqual(cleanAreaRules({ projects: 'Fernpay', mode: 'BRIGADE', budget: 15 }), { projects: [], mode: 'open', budget: 10 });
  assert.equal(cleanAreaRules({ projects: Array.from({ length: 80 }, (_, i) => `p${i}`) }).projects.length, 50);
  const a = { id: 'a1', name: 'Payments', projects: ['Fernpay'], mode: 'open' as const, budget: 10 };
  assert.deepEqual(changeArea(a, 'project', 'Loopline', true).area?.projects, ['Fernpay', 'Loopline']);
  assert.deepEqual(changeArea(a, 'project', 'Fernpay', false).area?.projects, []);
  assert.deepEqual(changeArea(a, 'project', 'Fernpay', true).area?.projects, ['Fernpay'], 'in twice is in once');
  assert.equal(changeArea(a, 'mode', 'brigade').area?.mode, 'brigade');
  assert.equal(changeArea(a, 'mode', 'closed').error, 'That is not one of the modes.');
  assert.equal(changeArea(a, 'budget', '7').error, 'That is not one of the choices.');
  assert.equal(changeArea(a, 'project', '  ', true).error, 'That project has no name.');
  assert.equal(changeArea(a, 'owner', 'x').error, 'There is no such area setting.');
});

test('the view is French Brigade once any area is; a project\'s scopes are its areas in the team\'s order', () => {
  assert.equal(teamMode([]), 'open');
  assert.equal(teamMode(null), 'open');
  assert.equal(teamMode([{ mode: 'open' }, { mode: 'brigade' }]), 'brigade');
  const areas = [{ id: 'a1', projects: ['Fernpay'] }, { id: 'a2', projects: ['Loopline'] }, { id: 'a3', projects: ['Fernpay', 'Loopline'] }];
  assert.deepEqual(areaScopes(areas, 'Fernpay'), ['area:a1', 'area:a3']);
  assert.deepEqual(areaScopes(areas, 'Quillo'), []);
  assert.deepEqual(areaScopes(areas, null), []);
  assert.deepEqual(areaScopes(undefined, 'Fernpay'), []);
});
