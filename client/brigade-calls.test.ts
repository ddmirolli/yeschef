// French Brigade's calls (step 7 PR 2): Ready for your look with Ship, and Blocked. Run: vp test run brigade-calls.test.ts, in client/
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { openKitchen, finesOf, callId, featuresOf } from './open-kitchen.ts';
import type { Kind, TeamCall, TeamView } from './open-kitchen.ts';
import { fixtureView } from './open-kitchen.fixture.ts';
import { renderApp } from './board.ts';

// A teammate's summary is JSON from another Mac, so the tests write it as untyped JSON.
type Wire = any;
type CallOf<K extends Kind> = Extract<TeamCall, { kind: K }>;
const NOW = Date.UTC(2026, 10, 10, 14, 3);
const MIN = 60000;
const ago = (m: number) => NOW - m * MIN;
const who = (v: Wire, id: string): Wire => v.people.find((p: Wire) => p.id === id);
const tk = (v: Wire, thread: string): Wire => v.people.flatMap((p: Wire) => p.summary?.tickets ?? []).find((t: Wire) => t.thread === thread);
const READY = callId('ready', 'p-tok', null);

/** The made-up team with one feature, Tokens: Maya's, Sam's and Priya's merged threads, its list read whole and done,
 *  and Priya its lead in Linear. */
const tokens = (feature: Wire = {}): Wire => {
  const v: Wire = fixtureView(NOW);
  for (const t of ['mcp:maya-0', 'mcp:sam-0', 'mcp:priya-0']) tk(v, t).feature = { id: 'p-tok', name: 'Tokens' };
  who(v, 'maya').summary.features = [{ id: 'p-tok', name: 'Tokens', lead: 'Priya', leadAt: ago(5), list: { n: 3, closed: 3, unread: 0, at: ago(4) }, ...feature }];
  return v;
};
const calls = (v: TeamView) => { const ok = openKitchen(v, { now: NOW }); return [...ok.pass, ...ok.held]; };
function get<K extends Kind>(v: TeamView, kind: K): CallOf<K> | undefined {
  return calls(v).find((c): c is CallOf<K> => c.kind === kind);
}
const page = (view: TeamView) => renderApp({ board: { tickets: [], runsChecked: false }, link: () => 'x', status: { ok: true, at: NOW, ms: 1 },
  origin: 'https://t3.example', team: { view, now: NOW } });

test('Ready for your look: every thread merged and the whole list done; it goes to the lead at once', () => {
  const ok = openKitchen(tokens(), { now: NOW });
  const c = ok.pass.find((x): x is CallOf<'ready'> => x.kind === 'ready');
  assert.ok(c, 'the call is in The Pass');
  assert.equal(c.id, READY);
  assert.deepEqual(c.reach, { lead: true, why: 'look' });
  assert.deepEqual([...c.who].sort(), ['maya', 'priya', 'sam']);
  assert.deepEqual(c.facts.list, { n: 3, closed: 3, unread: 0, at: ago(4) });
  assert.deepEqual(c.facts.lead, { name: 'Priya', at: ago(5), person: 'priya', thread: 'mcp:priya-0' });
});

test('Ready for your look stays down while any part is not done or not read (1A)', () => {
  assert.ok(get(tokens(), 'ready'));
  assert.equal(get(tokens({ list: { n: 4, closed: 3, unread: 0, at: ago(4) } }), 'ready'), undefined, 'a ticket not done');
  assert.equal(get(tokens({ list: { n: 3, closed: 2, unread: 1, at: ago(4) } }), 'ready'), undefined, 'a ticket not read');
  assert.equal(get(tokens({ list: undefined }), 'ready'), undefined, 'no list read');
  assert.equal(get(tokens({ list: { n: 0, closed: 0, unread: 0, at: ago(4) } }), 'ready'), undefined, 'an empty list');
  assert.equal(get(tokens({ list: { n: 3, closed: 4, unread: 0, at: ago(4) } }), 'ready'), undefined, 'a list that does not add up');
  const open = tokens();
  tk(open, 'mcp:priya-1').feature = { id: 'p-tok', name: 'Tokens' };
  assert.equal(get(open, 'ready'), undefined, 'a thread still in progress');
});

test('the newest read of a feature wins, from any summary', () => {
  const v = tokens({ list: { n: 4, closed: 3, unread: 0, at: ago(30) } });
  who(v, 'sam').summary.features = [{ id: 'p-tok', name: 'Tokens', lead: 'Priya', leadAt: ago(40), list: { n: 3, closed: 3, unread: 0, at: ago(2) } }];
  const f = featuresOf(v.people).get('p-tok');
  assert.deepEqual(f, { id: 'p-tok', name: 'Tokens', lead: { name: 'Priya', at: ago(5) }, list: { n: 3, closed: 3, unread: 0, at: ago(2) } });
  assert.equal(featuresOf([{ summary: { features: [{ id: 'a b', name: 'X' }, { id: 'ok', name: '' }] } }]).size, 0, 'bad ids and names are dropped');
});

test('Ship goes to the lead’s agent only when a project read names a lead on the team (2A)', () => {
  const lead = (feature: Wire) => get(tokens(feature), 'ready')!.facts.lead;
  assert.equal(lead({ lead: undefined, leadAt: undefined }), null, 'no project read');
  assert.deepEqual(lead({ lead: null }), { name: null, at: ago(5), person: null, thread: null }, 'the project has no lead');
  assert.deepEqual(lead({ lead: 'Grace' }), { name: 'Grace', at: ago(5), person: null, thread: null }, 'not on the team');
  assert.deepEqual(lead({ lead: '  maya ' }), { name: 'maya', at: ago(5), person: 'maya', thread: 'mcp:maya-0' }, 'case and spaces aside');
  const twins = tokens();
  who(twins, 'sam').name = 'Priya';
  assert.equal(get(twins, 'ready')!.facts.lead!.person, null, 'two teammates of that name: no one');
});

test('the Ready reader: the list, the lead, Ship with its words, and why Ship is off', () => {
  const html = page(tokens());
  assert.match(html, /Tokens is ready for your look/);
  assert.match(html, /3 of 3 done/);
  assert.match(html, /name="kind" value="ship"/);
  const plate = html.split('<article class="plate team-plate"').slice(1).find((x) => x.includes('Tokens is ready for your look')) ?? '';
  assert.match(plate, /value="ship"/);
  assert.doesNotMatch(plate, /value="hold"/, 'no Hold on a merged thread');
  assert.match(html, /3 people/);
  assert.ok(html.includes(`name="call" value="${READY}"`));
  assert.match(html, /name="to" value="priya"/);
  assert.match(html, /name="thread" value="mcp:priya-0"/);
  assert.match(html, /Ship Tokens\. Every ticket is done \(3 of 3\)/);
  const off = (feature: Wire) => page(tokens(feature));
  assert.doesNotMatch(off({ lead: undefined, leadAt: undefined }), /value="ship"/);
  assert.match(off({ lead: undefined, leadAt: undefined }), /Not checked: no project read names the lead/);
  assert.match(off({ lead: null }), /Tokens has no lead in Linear/);
  assert.match(off({ lead: 'Grace' }), /no one on your team is named Grace/);
  assert.match(off({ lead: 'Dana' }), /You lead Tokens in Linear: ship it from your own thread\./);
  assert.doesNotMatch(off({ lead: 'Dana' }), /value="ship"/);
  assert.match(off({ lead: 'Elena' }), /Elena has no thread on Tokens/);
});

test('a Ship mark clears the call from every Pass for 30 days, from a role that may ship', () => {
  const v = tokens();
  v.ships = { [READY]: ago(60) };
  assert.equal(get(v, 'ready'), undefined, 'my own mark');
  assert.deepEqual(finesOf(v, NOW).get(READY), { by: 'me', at: ago(60), ship: true });
  v.ships = { [READY]: NOW - 31 * 24 * 60 * MIN };
  assert.ok(get(v, 'ready'), 'a mark older than 30 days');
  const t = tokens();
  who(t, 'priya').summary.ships = { [READY]: ago(10) };
  assert.ok(get(t, 'ready'), 'Priya may only see, so her mark clears nothing');
  who(t, 'priya').perms = ['see', 'merge'];
  assert.equal(get(t, 'ready'), undefined, 'with Merge it does');
  v.ships = { 'overlap:x:1': ago(1) };
  assert.equal(finesOf(v, NOW).size, 0, 'only Ready for your look ids');
});

test('Blocked: a live thread waiting on something a read shows open; to the lead after 30 unseen minutes', () => {
  const v: Wire = fixtureView(NOW);
  tk(v, 'mcp:elena-1').blocked = [{ id: 'ENG-12', title: 'Payout API', at: ago(40) }, { id: 'acme/quillo#9', title: null, at: ago(20) }];
  tk(v, 'mcp:maya-0').blocked = [{ id: 'ENG-13', title: 'x', at: ago(40) }];
  const ok = openKitchen(v, { now: NOW });
  const c = ok.pass.find((x): x is CallOf<'blocked'> => x.kind === 'blocked');
  assert.ok(c);
  assert.deepEqual(c.who, ['elena']);
  assert.equal(c.since, ago(40));
  assert.deepEqual(c.reach, { lead: true, why: 'unseen', min: 30 });
  assert.equal(c.id, callId('blocked', 'mcp:elena-1:ENG-12,acme/quillo#9', null));
  assert.equal(calls(v).filter((x) => x.kind === 'blocked').length, 1, 'a merged thread raises nothing');
  tk(v, 'mcp:elena-1').blocked = [{ id: 'ENG-12', title: 'Payout API', at: ago(10) }];
  assert.deepEqual(get(v, 'blocked')!.reach, { lead: false }, 'held by the dev for 30 minutes');
  tk(v, 'mcp:elena-1').blocked = [{ id: 'bad id', title: 'x', at: ago(40) }, { id: 'ENG-1', title: 'x', at: null }];
  assert.equal(get(v, 'blocked'), undefined, 'a bad id or no read time');
  assert.doesNotMatch(page(fixtureView(NOW)), /is blocked by/);
});

test('the Blocked reader names each blocker and offers Reply', () => {
  const v: Wire = fixtureView(NOW);
  tk(v, 'mcp:elena-1').blocked = [{ id: 'ENG-12', title: 'Payout API', at: ago(40) }, { id: 'acme/quillo#9', title: null, at: ago(40) }];
  const html = page(v);
  assert.match(html, /Elena’s thread is blocked by ENG-12 and 1 more/);
  assert.match(html, /Payout API/);
  assert.match(html, /acme\/quillo#9/);
  assert.match(html, /name="kind" value="reply"/);
});
