import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeRelay, fakeNet } from '../relay/fake.mjs';
import { Team, createTeam, joinTeam, summarize, identity, notCheckedSince, chartUnder, RETRY, ACT_TTL, BOARD_FRESH_MS } from './team.mjs';
import { grant, allows, refusal, signature, DEFAULTS, PERMS, shares } from './roles.mjs';
import { buildBoard } from './board.mjs';
import { act } from './actions.mjs';
import { sealSigned, sealTo, aad, teamKey, newMember, signRoster } from './seal.mjs';

const MIN = 60000;
const P = 'proj-app', Q = 'proj-private';

/** Timers on the relay's clock: nothing fires until the test moves time. */
function clock(relay) {
  let n = 0;
  const jobs = new Map();
  const t = {
    setTimeout: (fn, ms) => { jobs.set(++n, { fn, at: relay.now() + ms }); return n; },
    clearTimeout: (id) => { jobs.delete(id); },
    setInterval: (fn, ms) => { jobs.set(++n, { fn, at: relay.now() + ms, every: ms }); return n; },
    clearInterval: (id) => { jobs.delete(id); },
    async advance(ms) {
      const end = relay.now() + ms;
      for (;;) {
        const due = [...jobs].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, j] = due;
        if (j.at > relay.now()) relay.tick(j.at - relay.now());
        if (j.every) j.at += j.every; else jobs.delete(id);
        j.fn();
        await settle();
      }
      if (end > relay.now()) relay.tick(end - relay.now());
      await settle();
    },
    count: () => jobs.size,
  };
  return t;
}
const settle = () => new Promise((r) => setTimeout(r, 5));
async function until(cond, what = 'the condition') {
  for (let i = 0; i < 2000; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error(`timed out waiting for ${what}`);
}

/** Threads in two projects: one this dev shares, one it does not. */
function threads(now = Date.UTC(2026, 10, 10, 12)) {
  const at = new Date(now).toISOString();
  const t = (threadId, projectId, title, extra = {}) => ({ threadId, projectId, title, status: 'completed', latestRunId: 'r1', settled: false, snoozed: false, updatedAt: at, pullRequests: [], ...extra });
  return [
    t('th-parser', P, 'Fix the parser', { pullRequests: [{ repository: 'acme/app', number: 12, state: 'open', url: 'https://github.com/acme/app/pull/12' }] }),
    t('th-docs', P, 'Write the docs', { status: 'running' }),
    t('th-secret', Q, 'Private work'),
    t('th-atc', P, 'ATC board'),
  ];
}
const projects = [{ id: P, title: 'app' }, { id: Q, title: 'private' }];
const boardNow = (now) => buildBoard({ projects, threads: threads(now), questions: new Map(), today: new Date(now) });

/** A lead and a dev on one fake relay, each with their own Yes Chef. */
async function crew({ role = 'engineer', perms } = {}) {
  const relay = fakeRelay();
  const net = fakeNet(relay);
  const timers = clock(relay);
  const now = () => relay.now();
  const saved = { lead: [], dev: [] };
  const leadState = await createTeam({ relay: 'https://relay.test', teamName: 'Fernpay', name: 'Sam Lead', net, now });
  const lead = new Team({ state: leadState, save: (s) => saved.lead.push(structuredClone(s)), net, now, timers, random: () => 1 });
  lead.start();
  await until(() => lead.link === 'online', 'the lead online');
  const { link } = await lead.invite({ site: 'https://yeschef.codes' });
  const devState = await joinTeam({ link, name: 'Ada Lovelace', projects: ['app'], shared: [P], net, now });
  const ran = [];
  let devBoard = { board: boardNow(now()), ok: true, at: now() };
  const t3calls = [];
  const dev = new Team({ state: devState, save: (s) => saved.dev.push(structuredClone(s)), net, now, timers, random: () => 1,
    board: () => devBoard,
    run: async (input, prefix, maps) => { ran.push({ input, prefix }); return act({ board: devBoard.board, t3: { call: async (name, args) => { t3calls.push({ name, args }); return {}; } }, input, prefix, ...maps }); } });
  dev.start();
  await until(() => dev.link === 'online' && lead.pending.size === 1, 'the ask at the lead');
  const r = await lead.approve(dev.meId, role, perms);
  assert.equal(r.t, 'ok');
  await until(() => dev.state.status === 'member' && dev.state.key && dev.me?.name === 'Ada Lovelace', 'the dev let in');
  return { relay, net, timers, lead, dev, ran, t3calls, saved, setBoard: (b) => { devBoard = b; } };
}

test('roles: the lead has every box, the Deputy has the approved boxes, see is never off, and unknown roles fall to Viewer', () => {
  assert.deepEqual(grant('lead', []).perms, PERMS.map((p) => p.key));
  assert.deepEqual(grant('deputy').perms, ['see', 'reply', 'projects', 'invite']);
  assert.deepEqual(grant('engineer', ['merge']).perms, ['see', 'merge']);
  assert.deepEqual(grant('owner', ['nonsense', 'reply']).perms, ['see', 'reply']);
  assert.equal(grant('chef').role, 'viewer');
  assert.deepEqual(DEFAULTS.viewer, ['see']);
  assert.equal(shares('viewer'), false);
  assert.equal(allows({ role: 'deputy', perms: ['see', 'reply'] }, 'reply'), true);
  assert.equal(allows({ role: 'deputy', perms: ['see', 'reply'] }, 'go'), false);
  assert.equal(allows({ role: 'lead' }, 'go'), true);
  // Settle and New thread stay the dev's own, even for the lead.
  assert.equal(allows({ role: 'lead' }, 'settle'), false);
  assert.equal(allows({ role: 'lead' }, 'launch'), false);
  assert.match(refusal({ role: 'engineer' }, 'go'), /Engineer.*Merge, Request changes or Hold/);
  assert.equal(signature({ name: '  Sam\n Lead ', role: 'lead' }), 'Sam Lead (Lead), from Yes Chef: ');
});

test('summarize keeps only shared projects, no coordinators, waiting tickets first, and fits the limit', () => {
  const now = Date.UTC(2026, 10, 10, 12);
  const s = summarize(boardNow(now), [P]);
  assert.deepEqual(s.tickets.map((k) => k.thread), ['th-parser', 'th-docs']);
  assert.equal(s.tickets[0].atPass, true);
  assert.deepEqual(s.tickets[0].prs, [{ repo: 'acme/app', n: 12, state: 'open', url: 'https://github.com/acme/app/pull/12' }]);
  assert.doesNotMatch(JSON.stringify(s), /Private work|ATC/);
  assert.equal(summarize(boardNow(now), []).tickets.length, 0);
  const many = { tickets: Array.from({ length: 300 }, (_, i) => ({ thread: { threadId: `t${i}`, projectId: P, title: 'x'.repeat(150) }, project: 'app', place: 'In review', atPass: false, working: 0, asks: [], call: null, prs: [], updatedAt: '' })) };
  const fit = summarize(many, [P], 65536);
  assert.ok(fit.tickets.length <= 100 && fit.more >= 200);
  assert.ok((JSON.stringify(fit.tickets).length * 4) / 3 + 600 <= 65536);
});

test('make a team, invite, ask, approve: the dev gets the key, the names and their own role', async () => {
  const { lead, dev, saved } = await crew();
  const v = dev.view();
  assert.equal(v.status, 'member');
  assert.equal(v.me.role, 'engineer');
  assert.deepEqual(v.people.map((p) => [p.name, p.role]).sort(), [['Ada Lovelace', 'engineer'], ['Sam Lead', 'lead']]);
  assert.equal(lead.view().people.find((p) => p.name === 'Ada Lovelace').role, 'engineer');
  assert.equal(lead.pending.size, 0);
  // The dev's saved state holds the key from the welcome; the first save waited without one.
  assert.equal(saved.dev.at(-1).status, 'member');
  assert.ok(saved.dev.at(-1).key);
  lead.stop(); dev.stop();
});

test('the lead reads only what the dev shares, coalesced to one summary per limit, never shown live while offline', async () => {
  const { relay, net, timers, lead, dev, setBoard } = await crew();
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.size === 1, 'the first summary');
  const seen = lead.view().people.find((p) => p.name === 'Ada Lovelace');
  assert.equal(seen.live, true);
  assert.deepEqual(seen.summary.tickets.map((k) => k.title), ['Fix the parser', 'Write the docs']);
  // Two quick changes: the relay gets only the newest, after the limit.
  const b2 = boardNow(relay.now()); b2.tickets[1].place = 'In review';
  dev.board(b2);
  const b3 = boardNow(relay.now()); b3.tickets[1].place = 'Merged';
  dev.board(b3);
  setBoard({ board: b3, ok: true, at: relay.now() });
  await settle();
  assert.equal(lead.summaries.get(dev.meId).body.tickets[1].place, 'In progress');
  await timers.advance(10000);
  await until(() => lead.summaries.get(dev.meId).body.tickets.find((k) => k.thread === 'th-docs').place === 'Merged', 'the newest summary');
  // The same board again sends nothing.
  const writes = relay.sql.exec('SELECT rows_written FROM usage').one().rows_written;
  dev.board(b3);
  await timers.advance(10000);
  assert.equal(relay.sql.exec('SELECT rows_written FROM usage').one().rows_written, writes);
  // The lead's Mac loses the network: the cached summary stays, but nothing reads as live or online.
  net.down = true;
  net.drop();
  await until(() => lead.link === 'waiting', 'the lead waiting');
  const off = lead.view().people.find((p) => p.name === 'Ada Lovelace');
  assert.ok(off.summary);
  assert.equal(off.live, false);
  assert.equal(off.online, false);
  lead.stop(); dev.stop();
});

test('a lead\'s reply runs on the dev\'s thread through the dev\'s own T3, signed with the lead\'s name', async () => {
  const { lead, dev, ran, t3calls } = await crew();
  const out = await lead.act(dev.meId, { kind: 'reply', thread: 'th-parser', note: 'Rebase on main first.' });
  assert.deepEqual(out, { status: 200, text: 'Reply sent.' });
  assert.equal(ran.length, 1);
  assert.equal(t3calls[0].name, 't3_thread_send');
  assert.equal(t3calls[0].args.message, 'Sam Lead (Lead), from Yes Chef: Rebase on main first.');
  assert.match(t3calls[0].args.clientRequestId, /^pass-t-[\w-]{22}-[\w-]{22}$/);
  lead.stop(); dev.stop();
});

test('the dev\'s Yes Chef refuses what the sender\'s role, the shared projects or the board do not allow', async () => {
  const { relay, lead, dev, ran, setBoard } = await crew();
  // A thread in a project the dev does not share: refused, even for the lead.
  assert.equal((await lead.act(dev.meId, { kind: 'reply', thread: 'th-secret', note: 'x' })).status, 409);
  // Settle and New thread never come from a teammate.
  assert.equal((await lead.act(dev.meId, { kind: 'settle', thread: 'th-parser' })).status, 403);
  // A board that is not fresh: not checked, nothing runs.
  setBoard({ board: boardNow(relay.now()), ok: true, at: relay.now() - BOARD_FRESH_MS - 1 });
  const stale = await lead.act(dev.meId, { kind: 'reply', thread: 'th-parser', note: 'x' });
  assert.equal(stale.status, 409);
  assert.match(stale.text, /^Not checked/);
  setBoard({ board: boardNow(relay.now()), ok: false, at: relay.now() });
  assert.equal((await lead.act(dev.meId, { kind: 'reply', thread: 'th-parser', note: 'x' })).status, 409);
  assert.equal(ran.length, 0);
  lead.stop(); dev.stop();
});

test('an engineer who forges a bigger role on their own Mac is still refused: the dev reads the lead\'s roster', async () => {
  const { relay, net, timers, lead, dev, ran } = await crew();
  // A second dev joins as an engineer.
  const { link } = await lead.invite();
  const evState = await joinTeam({ link, name: 'Eve', shared: [P], net, now: () => relay.now() });
  const eve = new Team({ state: evState, net, now: () => relay.now(), timers });
  eve.start();
  await until(() => lead.pending.size === 1, 'Eve\'s ask');
  await lead.approve([...lead.pending.keys()][0], 'engineer');
  await until(() => eve.state.key && eve.me?.role === 'engineer', 'Eve let in');
  assert.equal((await eve.act(dev.meId, { kind: 'go', thread: 'th-parser' })).status, 403, 'her own Mac refuses first');
  // Eve edits her own copy of the roster to say Lead. The dev's Mac does not believe it.
  eve.people.get(eve.meId).role = 'lead';
  eve.people.get(eve.meId).perms = PERMS.map((p) => p.key);
  const forged = await eve.act(dev.meId, { kind: 'go', thread: 'th-parser' });
  assert.equal(forged.status, 403);
  assert.match(forged.text, /Engineer/);
  assert.equal(ran.length, 0);
  eve.stop(); lead.stop(); dev.stop();
});

test('an action runs once: a replay gets the first answer, and an old one does not run', async () => {
  const { relay, lead, dev, ran } = await crew();
  const me = await lead.member();
  const key = await teamKey(lead.state.key);
  const where = aad.send(lead.state.team, me.id, dev.meId);
  const nonce = 'AAAAAAAAAAAAAAAAAAAAAA';
  const blob = await sealSigned(key, me, { k: 'act', nonce, at: relay.now(), action: { kind: 'reply', thread: 'th-parser', note: 'once' } }, where);
  // The relay (or anyone in the middle) hands the same blob over twice.
  await dev.take({ item: 'i1', from: me.id, blob });
  await dev.take({ item: 'i2', from: me.id, blob });
  assert.equal(ran.length, 1);
  // The memory of it survives a restart: it is in the saved state.
  assert.ok(dev.state.seen.some(([k]) => k === `${me.id}:${nonce}`));
  const old = await sealSigned(key, me, { k: 'act', nonce: 'BBBBBBBBBBBBBBBBBBBBBB', at: relay.now() - ACT_TTL - 1, action: { kind: 'reply', thread: 'th-parser', note: 'late' } }, where);
  await dev.take({ item: 'i3', from: me.id, blob: old });
  assert.equal(ran.length, 1);
  // A blob sealed for another receiver does not open here.
  const other = await sealSigned(key, me, { k: 'act', nonce: 'CCCCCCCCCCCCCCCCCCCCCC', at: relay.now(), action: { kind: 'reply', thread: 'th-parser', note: 'x' } }, aad.send(lead.state.team, me.id, me.id));
  await dev.take({ item: 'i4', from: me.id, blob: other });
  assert.equal(ran.length, 1);
  lead.stop(); dev.stop();
});

test('reconnects: one retry owner, doubling backoff capped at five minutes, a probe on wake', async () => {
  const { net, timers, lead, dev } = await crew();
  net.down = true;
  net.drop();
  await until(() => dev.link === 'waiting', 'dev waiting');
  const waits = [dev.retryMs];
  for (let i = 0; i < 10; i++) {
    await timers.advance(dev.retryMs);
    await until(() => dev.link === 'waiting', 'the next wait');
    waits.push(dev.retryMs);
  }
  assert.deepEqual(waits.slice(0, 4), [RETRY.base, 2 * RETRY.base, 4 * RETRY.base, 8 * RETRY.base]);
  assert.equal(Math.max(...waits), RETRY.cap);
  // A Mac that wakes probes now instead of waiting out five minutes.
  net.down = false;
  dev.wake();
  await until(() => dev.link === 'online', 'dev back online');
  assert.equal(dev.attempts, 0);
  lead.stop(); dev.stop();
});

test('a socket that answers no ping is closed and retried', async () => {
  const { timers, lead, dev } = await crew();
  const links = [];
  dev.on((e) => e.type === 'link' && links.push(e.link));
  // Swallow the ping: the socket looks open but is dead.
  const dead = dev.ws;
  dead.send = () => {};
  await timers.advance(30000);
  assert.deepEqual(links, [], 'still waiting on the pong');
  await timers.advance(10000);
  assert.equal(links[0], 'waiting');
  assert.notEqual(dev.ws, dead);
  await timers.advance(dev.retryMs);
  await until(() => dev.link === 'online', 'a new socket');
  assert.notEqual(dev.ws, dead);
  lead.stop(); dev.stop();
});

test('removed: the dev\'s Yes Chef drops the team key and stops', async () => {
  const { lead, dev, saved } = await crew();
  const r = await lead.remove(dev.meId);
  assert.equal(r.t, 'ok');
  await until(() => dev.state.status === 'removed', 'dev removed');
  assert.equal(dev.link, 'stopped');
  assert.equal(saved.dev.at(-1).key, null);
  assert.equal(dev.view().people.length, 0);
  assert.equal(lead.view().people.length, 1);
  lead.stop();
});

test('declined while offline: the socket fails, the probe asks the relay, and the dev stops', async () => {
  const relay = fakeRelay();
  const net = fakeNet(relay);
  const timers = clock(relay);
  const now = () => relay.now();
  const lead = new Team({ state: await createTeam({ relay: 'https://relay.test', teamName: 'T', name: 'L', net, now }), net, now, timers, random: () => 1 });
  lead.start();
  await until(() => lead.link === 'online');
  const { link } = await lead.invite();
  const dev = new Team({ state: await joinTeam({ link, name: 'D', net, now }), net, now, timers, random: () => 1 });
  await until(() => lead.pending.size === 1);
  // The dev is not connected when the lead declines.
  await lead.decline([...lead.pending.keys()][0]);
  dev.start();
  for (let i = 0; i < 4 && dev.state.status === 'pending'; i++) { await until(() => dev.link === 'waiting' || dev.state.status !== 'pending'); if (dev.state.status === 'pending') await timers.advance(dev.retryMs); }
  await until(() => dev.state.status === 'declined', 'the probe');
  assert.equal(dev.link, 'stopped');
  lead.stop();
});

test('a relay that sends a roster the pinned lead did not sign is dropped', async () => {
  const { relay, net, timers, lead, dev } = await crew();
  const other = await newMember();
  const fooled = new Team({ state: { ...dev.state, leadSign: other.signPub }, net, now: () => relay.now(), timers });
  const errors = [];
  fooled.on((e) => e.type === 'error' && errors.push(e.text));
  fooled.start();
  await until(() => fooled.link === 'stopped', 'the client to stop');
  assert.match(errors[0], /did not sign/);
  lead.stop(); dev.stop();
});

test('a deputy invites; the lead reads the ask made on the deputy\'s invite', async () => {
  const { relay, net, timers, lead, dev } = await crew({ role: 'deputy' });
  assert.equal(dev.me.invite, true);
  const { link } = await dev.invite();
  assert.ok(link);
  const joined = new Team({ state: await joinTeam({ link, name: 'New Person', projects: ['web'], net, now: () => relay.now() }), net, now: () => relay.now(), timers });
  joined.start();
  await until(() => lead.pending.size === 1 && dev.pending.size === 1, 'the ask at both');
  assert.deepEqual([...lead.pending.values()].map((p) => [p.name, p.projects]), [['New Person', ['web']]]);
  // Only the lead answers asks.
  assert.equal((await dev.decline([...dev.pending.keys()][0])).t, 'err');
  joined.stop(); lead.stop(); dev.stop();
});

test('a welcome the relay did not take goes again on the lead\'s next connect', async () => {
  const relay = fakeRelay();
  const net = fakeNet(relay);
  const timers = clock(relay);
  const now = () => relay.now();
  const lead = new Team({ state: await createTeam({ relay: 'https://relay.test', teamName: 'T', name: 'L', net, now }), net, now, timers, random: () => 1 });
  lead.start();
  await until(() => lead.link === 'online');
  const { link } = await lead.invite();
  const dev = new Team({ state: await joinTeam({ link, name: 'D', shared: [P], net, now }), net, now, timers, random: () => 1 });
  dev.start();
  await until(() => lead.pending.size === 1 && dev.link === 'online');
  // The roster goes through; the welcome's send fails.
  const say = lead.say.bind(lead);
  lead.say = (msg) => (msg.t === 'send' ? Promise.resolve({ t: 'err', code: 'timeout', text: 'x' }) : say(msg));
  const r = await lead.approve(dev.meId, 'engineer');
  assert.equal(r.welcome, 'later');
  assert.deepEqual(lead.state.welcomes, [dev.meId]);
  await until(() => dev.state.status === 'member');
  assert.equal(dev.state.key, null);
  // The lead's Mac reconnects: the welcome goes, and the dev gets the key.
  lead.say = say;
  net.drop();
  await until(() => lead.link === 'waiting');
  await timers.advance(lead.retryMs);
  await until(() => dev.state.key && dev.me?.name === 'D', 'the late welcome');
  assert.deepEqual(lead.state.welcomes, []);
  lead.stop(); dev.stop();
});

test('stop sharing: an empty list drops the relay\'s copy of this dev\'s summary', async () => {
  const { relay, lead, dev } = await crew();
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.size === 1);
  const { timers } = dev;
  await dev.share([]);
  // A forget waits out the same limit as a summary.
  await settle();
  assert.equal(lead.summaries.size, 1);
  await timers.advance(10000);
  await until(() => lead.summaries.size === 0, 'the summary gone');
  // Boards after that send nothing.
  dev.board(boardNow(relay.now()));
  await timers.advance(10000);
  assert.equal(lead.summaries.size, 0);
  assert.equal(relay.sql.exec('SELECT COUNT(*) AS n FROM summary WHERE blob IS NOT NULL').one().n, 0);
  lead.stop(); dev.stop();
});

// PR-Agent r1 on #79.

test('after a restart, a relay cannot hand back an older roster: the highest version taken is saved', async () => {
  const { relay, net, timers, lead, dev } = await crew();
  const old = lead.rosterSigned; // version 2: the dev as an Engineer
  assert.equal((await lead.setRole(dev.meId, 'viewer')).t, 'ok');
  await until(() => dev.state.rosterVer === 3 && dev.me?.role === 'viewer', 'the new roster saved');
  dev.stop();
  // The dev's Mac restarts. A relay replays version 2, which still gave the dev an Engineer's role.
  const again = new Team({ state: structuredClone(dev.state), net, now: () => relay.now(), timers });
  const errors = [];
  again.on((e) => e.type === 'error' && errors.push(e.text));
  await again.hello({ t: 'hello', me: dev.meId, role: 'member', roster: old, online: [], inbox: [], summaries: [] });
  assert.match(errors[0] || '', /older one/);
  assert.equal(await again.takeRoster(old), false);
  assert.equal(await again.takeRoster(lead.rosterSigned), true);
  lead.stop();
});

test('a roster the relay took but whose answer was lost still owes the welcome', async () => {
  const relay = fakeRelay();
  const net = fakeNet(relay);
  const timers = clock(relay);
  const now = () => relay.now();
  const lead = new Team({ state: await createTeam({ relay: 'https://relay.test', teamName: 'T', name: 'L', net, now }), net, now, timers, random: () => 1 });
  lead.start();
  await until(() => lead.link === 'online');
  const { link } = await lead.invite();
  const dev = new Team({ state: await joinTeam({ link, name: 'D', shared: [P], net, now }), net, now, timers, random: () => 1 });
  dev.start();
  await until(() => lead.pending.size === 1 && dev.link === 'online');
  // The relay takes the roster, but its answer never reaches the lead.
  const say = lead.say.bind(lead);
  lead.say = (msg) => (msg.t === 'roster' ? say(msg).then(() => ({ t: 'err', code: 'timeout', text: 'The relay did not answer.' })) : say(msg));
  assert.equal((await lead.approve(dev.meId, 'engineer')).t, 'err');
  assert.deepEqual(lead.state.welcomes, [dev.meId], 'owed from before the roster went');
  lead.say = say;
  net.drop();
  await until(() => lead.link === 'waiting');
  await timers.advance(lead.retryMs);
  await until(() => dev.state.key && dev.me?.name === 'D', 'the welcome after the reconnect');
  assert.deepEqual(lead.state.welcomes, []);
  // A roster the relay refused owes nothing: the next connect drops it.
  lead.state.welcomes = ['AAAAAAAAAAAAAAAAAAAAAA'];
  await lead.sendWelcomes();
  assert.deepEqual(lead.state.welcomes, []);
  lead.stop(); dev.stop();
});

test('dropping a project rebuilds the waiting summary: the dropped project\'s tickets never go out', async () => {
  const { relay, timers, lead, dev } = await crew();
  await dev.share([P, Q]);
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.get(dev.meId)?.body.tickets.some((k) => k.title === 'Private work'), 'both projects shared');
  // A change waits out the limit. The dev stops sharing Q before it goes.
  const b2 = boardNow(relay.now()); b2.tickets.find((k) => k.thread.threadId === 'th-secret').place = 'In review';
  dev.board(b2);
  await dev.share([P]);
  await timers.advance(10000);
  await until(() => !lead.summaries.get(dev.meId).body.tickets.some((k) => k.thread === 'th-secret'), 'the rebuilt summary');
  assert.doesNotMatch(JSON.stringify(lead.summaries.get(dev.meId).body), /Private work/);
  lead.stop(); dev.stop();
});

test('made a Viewer: a queued summary does not go, and the relay\'s copy is dropped', async () => {
  const { relay, timers, lead, dev } = await crew();
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.size === 1);
  const b2 = boardNow(relay.now()); b2.tickets[1].place = 'Merged';
  dev.board(b2);
  assert.equal((await lead.setRole(dev.meId, 'viewer')).t, 'ok');
  await until(() => dev.me?.role === 'viewer');
  await timers.advance(10000);
  await until(() => lead.summaries.size === 0, 'the summary gone');
  assert.equal(relay.sql.exec('SELECT COUNT(*) AS n FROM summary WHERE blob IS NOT NULL').one().n, 0);
  // Boards after that send nothing, and a summary queued by any path is checked again at send time.
  dev.board(b2);
  dev.next = { json: '{}', body: summarize(b2, [P]) };
  dev.flush();
  await timers.advance(10000);
  assert.equal(lead.summaries.size, 0);
  assert.equal(dev.next, null);
  lead.stop(); dev.stop();
});

test('a summary the relay refuses is dropped, and a failing relay is retried with a growing wait, not in a loop', async () => {
  const { relay, timers, lead, dev } = await crew();
  const say = dev.say.bind(dev);
  let sent = 0, answer = { t: 'err', code: 'bad', text: 'That summary is empty or too large.' };
  dev.say = (msg) => (msg.t === 'summary' ? (sent++, Promise.resolve(answer)) : say(msg));
  const errors = [];
  dev.on((e) => e.type === 'error' && errors.push(e.text));
  dev.board(boardNow(relay.now()));
  await settle(); await settle();
  assert.equal(sent, 1);
  assert.equal(dev.next, null, 'a refused summary is not sent again');
  assert.match(errors[0], /refused/);
  // A relay that times out: the next try waits 20 s, then 40 s.
  answer = { t: 'err', code: 'timeout', text: 'The relay did not answer.' };
  const b2 = boardNow(relay.now()); b2.tickets[1].place = 'Merged';
  dev.board(b2);
  await settle(); await settle();
  assert.equal(sent, 2);
  await timers.advance(19000);
  assert.equal(sent, 2);
  await timers.advance(1000);
  assert.equal(sent, 3);
  await timers.advance(39000);
  assert.equal(sent, 3);
  await timers.advance(1000);
  assert.equal(sent, 4);
  lead.stop(); dev.stop();
});

test('a summary in any script fits the relay\'s limit once sealed', async () => {
  const many = { tickets: Array.from({ length: 300 }, (_, i) => ({ thread: { threadId: `t${i}`, projectId: P, title: '漢字'.repeat(75) }, project: 'アプリ', place: 'In review', atPass: false, working: 0, asks: [], call: null, prs: [], updatedAt: '' })) };
  const fit = summarize(many, [P], 65536);
  assert.ok((new TextEncoder().encode(JSON.stringify(fit.tickets)).length * 4) / 3 + 600 <= 65536);
  const { relay, timers, lead, dev } = await crew();
  dev.limits.summaryMax = 6000; // a relay with a smaller limit than the estimate assumed
  dev.board(many);
  await until(() => lead.summaries.size === 1, 'a summary that fits');
  const blob = relay.sql.exec('SELECT blob FROM summary WHERE m = ?', dev.meId).one().blob;
  assert.ok(blob.length <= 6000, `sealed ${blob.length}`);
  assert.ok(lead.summaries.get(dev.meId).body.more > 0);
  // Sealing checks the real size even when the estimate was made for a larger limit.
  const sealed = await dev.sealSummary(summarize(many, [P], 65536));
  assert.ok(sealed.length <= 6000, `sealed ${sealed.length}`);
  await timers.advance(0);
  lead.stop(); dev.stop();
});

test('a teammate\'s action that comes before the welcome waits for the key, then runs', async () => {
  const relay = fakeRelay();
  const net = fakeNet(relay);
  const timers = clock(relay);
  const now = () => relay.now();
  const lead = new Team({ state: await createTeam({ relay: 'https://relay.test', teamName: 'T', name: 'Sam Lead', net, now }), net, now, timers, random: () => 1 });
  lead.start();
  await until(() => lead.link === 'online');
  const { link } = await lead.invite();
  const ran = [];
  const board = () => ({ board: boardNow(relay.now()), ok: true, at: relay.now() });
  const dev = new Team({ state: await joinTeam({ link, name: 'D', shared: [P], net, now }), net, now, timers, random: () => 1, board,
    run: async (input, prefix) => { ran.push({ input, prefix }); return { status: 200, text: 'Reply sent.' }; } });
  dev.start();
  await until(() => lead.pending.size === 1 && dev.link === 'online');
  // The welcome is held back; the lead's reply goes first.
  const say = lead.say.bind(lead);
  lead.say = (msg) => (msg.t === 'send' && msg.ttl > ACT_TTL ? Promise.resolve({ t: 'err', code: 'timeout', text: 'x' }) : say(msg));
  await lead.approve(dev.meId, 'engineer');
  await until(() => dev.state.status === 'member' && dev.link === 'online');
  const out = lead.act(dev.meId, { kind: 'reply', thread: 'th-parser', note: 'first' });
  await until(() => dev.later.some((m) => m.t === 'inbox'), 'the action kept');
  assert.equal(ran.length, 0);
  assert.equal(relay.sql.exec('SELECT COUNT(*) AS n FROM inbox WHERE to_m = ?', dev.meId).one().n, 1, 'not taken off the relay');
  // The welcome arrives: the key, then the action.
  lead.say = say;
  await lead.sendWelcomes();
  assert.deepEqual(await out, { status: 200, text: 'Reply sent.' });
  assert.equal(ran.length, 1);
  assert.equal(ran[0].prefix, 'Sam Lead (Lead), from Yes Chef: ');
  await until(() => relay.sql.exec('SELECT COUNT(*) AS n FROM inbox WHERE to_m = ?', dev.meId).one().n === 0, 'both taken');
  lead.stop(); dev.stop();
});

test('a summary shows the time the dev\'s Mac signed, and an older one never replaces a newer one', async () => {
  const { relay, lead, dev } = await crew();
  const me = await dev.member();
  const key = await teamKey(dev.state.key);
  const where = aad.summary(dev.state.team, dev.meId);
  const t1 = relay.now() - 3600000;
  const oldBlob = await sealSigned(key, me, { v: 1, tickets: [], more: 0, at: t1, rev: t1 }, where);
  // A relay replays an hour-old summary with a fresh outer time.
  await lead.takeSummary(dev.meId, oldBlob, relay.now());
  assert.equal(lead.view().people.find((p) => p.id === dev.meId).at, t1);
  const newBlob = await sealSigned(key, me, { v: 1, tickets: [], more: 0, at: relay.now(), rev: relay.now() }, where);
  await lead.takeSummary(dev.meId, newBlob, relay.now());
  await lead.takeSummary(dev.meId, oldBlob, relay.now() + 5000);
  assert.equal(lead.summaries.get(dev.meId).body.at, relay.now());
  lead.stop(); dev.stop();
});

// PR-Agent r2 on #79.

test('a roster the lead signed without this Mac ends it, even when the relay never closes the socket', async () => {
  const { relay, net, timers, lead, dev } = await crew();
  dev.stop();
  assert.equal((await lead.remove(dev.meId)).t, 'ok');
  // The dev's Mac connects to a relay that hands over the new roster but sends no close.
  const again = new Team({ state: structuredClone(dev.state), net, now: () => relay.now(), timers });
  const errors = [];
  again.on((e) => e.type === 'error' && errors.push(e.text));
  await again.hello({ t: 'hello', me: dev.meId, role: 'member', roster: lead.rosterSigned, online: [], inbox: [], summaries: [] });
  assert.equal(again.state.status, 'removed');
  assert.equal(again.state.key, null);
  assert.equal(again.link, 'stopped');
  assert.deepEqual(errors, []);
  // Nothing goes out after: no summary, and no action runs.
  again.board(boardNow(relay.now()));
  assert.equal(again.next, null);
  lead.stop();
});

test('a summary sealed while its project was dropped never goes out', async () => {
  const { relay, lead, dev } = await crew();
  await dev.share([P, Q]);
  const say = dev.say.bind(dev);
  const sent = [];
  dev.say = (msg) => { if (msg.t === 'summary') sent.push(msg.blob); return say(msg); };
  // The seal is held until the dev drops Q.
  const seal = dev.sealSummary.bind(dev);
  let release;
  const gate = new Promise((r) => { release = r; });
  dev.sealSummary = async (body) => { await gate; return seal(body); };
  dev.board(boardNow(relay.now()));
  await settle();
  assert.equal(dev.flushing, true);
  dev.sealSummary = seal;
  await dev.share([P]);
  release();
  await until(() => lead.summaries.size === 1, 'the rebuilt summary');
  assert.equal(sent.length, 1, 'only the rebuilt summary went');
  assert.doesNotMatch(JSON.stringify(lead.summaries.get(dev.meId).body), /Private work/);
  lead.stop(); dev.stop();
});

test('a summary that fails to seal backs off, not a hot loop', async () => {
  const { relay, timers, lead, dev } = await crew();
  let seals = 0;
  dev.sealSummary = async () => { seals++; throw new Error('the saved key does not import'); };
  const errors = [];
  dev.on((e) => e.type === 'error' && errors.push(e.text));
  dev.board(boardNow(relay.now()));
  await settle(); await settle(); await settle();
  assert.equal(seals, 1, 'one try, then a wait');
  assert.equal(dev.flushing, false);
  assert.match(errors[0], /could not seal/);
  await timers.advance(20000);
  assert.equal(seals, 2, 'tried again after the wait');
  lead.stop(); dev.stop();
});

test('a dev whose welcome expired unread asks the lead for another, at most once a day', async () => {
  const relay = fakeRelay();
  const net = fakeNet(relay);
  const timers = clock(relay);
  const now = () => relay.now();
  const lead = new Team({ state: await createTeam({ relay: 'https://relay.test', teamName: 'T', name: 'L', net, now }), net, now, timers, random: () => 1 });
  lead.start();
  await until(() => lead.link === 'online');
  const { link } = await lead.invite();
  const dev = new Team({ state: await joinTeam({ link, name: 'D', shared: [P], net, now }), net, now, timers, random: () => 1 });
  dev.start();
  await until(() => lead.pending.size === 1 && dev.link === 'online');
  // The dev's Mac goes away; the lead approves, and the relay takes the welcome.
  dev.stop();
  assert.equal((await lead.approve(dev.meId, 'engineer')).t, 'ok');
  assert.deepEqual(lead.state.welcomes, []);
  assert.equal(relay.sql.exec('SELECT COUNT(*) AS n FROM inbox WHERE to_m = ?', dev.meId).one().n, 1);
  // Eight days later the welcome has expired unread. The dev comes back: on the roster, with no key.
  relay.tick(8 * 86400000);
  dev.start();
  await until(() => dev.state.key && dev.me?.name === 'D', 'a new welcome');
  assert.equal(dev.state.keyAskAt, relay.now());
  assert.deepEqual(lead.state.welcomes, []);
  // A second ask within the day sends nothing.
  dev.state.key = null;
  await dev.askKey();
  assert.equal(relay.sql.exec('SELECT COUNT(*) AS n FROM inbox WHERE to_m = ?', lead.meId).one().n, 0);
  lead.stop(); dev.stop();
});

// PR-Agent r1 on public #7.

test('a probe the relay never answers ends in a retry, not a stall', async () => {
  const relay = fakeRelay();
  const net = fakeNet(relay);
  const timers = clock(relay);
  const now = () => relay.now();
  const lead = new Team({ state: await createTeam({ relay: 'https://relay.test', teamName: 'T', name: 'L', net, now }), net, now, timers, random: () => 1 });
  lead.start();
  await until(() => lead.link === 'online');
  const { link } = await lead.invite();
  const state = await joinTeam({ link, name: 'D', net, now });
  lead.stop();
  // Sockets fail to open, and /me takes the request and never answers.
  let probes = 0;
  const hung = { ...net, http: (method, url, ...rest) => (url.endsWith('/me') ? (probes++, new Promise(() => {})) : net.http(method, url, ...rest)), socket: (url) => { net.down = true; return net.socket(url); } };
  const dev = new Team({ state, net: hung, now, timers, random: () => 1 });
  dev.start();
  for (let i = 0; i < 3 && probes === 0; i++) { await until(() => dev.link === 'waiting' || probes > 0, 'a retry or the probe'); if (probes === 0) await timers.advance(dev.retryMs); }
  assert.equal(probes, 1);
  assert.equal(dev.link, 'connecting');
  await timers.advance(15000);
  assert.equal(dev.link, 'waiting', 'the probe gave up and a retry is set');
  dev.stop();
});

test('a hello whose socket was stopped while it read the roster goes no further', async () => {
  const { relay, net, timers, lead, dev } = await crew();
  dev.stop();
  const again = new Team({ state: structuredClone(dev.state), net, now: () => relay.now(), timers });
  const take = again.takeRoster.bind(again);
  let release;
  const gate = new Promise((r) => { release = r; });
  again.takeRoster = async (r) => { await gate; return take(r); };
  again.ws = { close() {} }; // the socket this hello came in on
  const hello = again.hello({ t: 'hello', me: dev.meId, role: 'member', roster: lead.rosterSigned, online: [lead.meId], inbox: [], summaries: [] });
  again.stop();
  release();
  await hello;
  assert.equal(again.link, 'stopped');
  assert.equal(again.online.size, 0, 'nobody reads as online on a stopped team');
  lead.stop();
});

test('a reconnect does not let a relay hand back an older summary', async () => {
  const { relay, lead, dev } = await crew();
  const me = await dev.member();
  const key = await teamKey(dev.state.key);
  const where = aad.summary(dev.state.team, dev.meId);
  const oldBlob = await sealSigned(key, me, { v: 1, tickets: [], more: 0, at: relay.now() - 3600000, rev: relay.now() - 3600000 }, where);
  const newBlob = await sealSigned(key, me, { v: 1, tickets: [], more: 0, at: relay.now(), rev: relay.now() }, where);
  await lead.takeSummary(dev.meId, newBlob, relay.now());
  // The lead's socket comes back, and the relay's hello carries the hour-old summary.
  await lead.hello({ t: 'hello', me: lead.meId, role: 'member', roster: lead.rosterSigned, online: [], inbox: [], summaries: [{ m: dev.meId, blob: oldBlob, at: relay.now() }] });
  assert.equal(lead.summaries.has(dev.meId), false, 'the older one is not shown');
  lead.stop(); dev.stop();
});

test('a full list of recent actions refuses new ones rather than forget one that ran', async () => {
  const { relay, lead, dev, ran } = await crew();
  const me = await lead.member();
  const key = await teamKey(lead.state.key);
  const where = aad.send(lead.state.team, me.id, dev.meId);
  const seal = (nonce) => sealSigned(key, me, { k: 'act', nonce, at: relay.now(), action: { kind: 'reply', thread: 'th-parser', note: nonce } }, where);
  const first = await seal('AAAAAAAAAAAAAAAAAAAAAA');
  await dev.take({ item: 'i1', from: me.id, blob: first });
  assert.equal(ran.length, 1);
  // 499 more within the last minutes, refused or not: the list is full of ids still live.
  for (let i = 0; i < 499; i++) dev.seen.set(`${me.id}:x${i}`, { at: relay.now(), status: 403, text: 'no' });
  await dev.take({ item: 'i2', from: me.id, blob: await seal('BBBBBBBBBBBBBBBBBBBBBB') });
  assert.equal(ran.length, 1, 'the new one waits');
  await dev.take({ item: 'i3', from: me.id, blob: first });
  assert.equal(ran.length, 1, 'the first one still never runs twice');
  lead.stop(); dev.stop();
});

test('an action opened after this Mac was removed does not run', async () => {
  const { relay, lead, dev, ran } = await crew();
  const me = await lead.member();
  const key = await teamKey(lead.state.key);
  const blob = await sealSigned(key, me, { k: 'act', nonce: 'DDDDDDDDDDDDDDDDDDDDDD', at: relay.now(), action: { kind: 'reply', thread: 'th-parser', note: 'late' } }, aad.send(lead.state.team, me.id, dev.meId));
  // The removal lands while the blob is being opened.
  const got = dev.teamKey.bind(dev);
  dev.teamKey = async () => { const k = await got(); dev.end('removed'); return k; };
  await dev.take({ item: 'i1', from: me.id, blob });
  assert.equal(ran.length, 0);
  lead.stop();
});

test('an action\'s id is saved before it runs, so a crash mid-run never runs it twice', async () => {
  const { relay, lead, dev, saved } = await crew();
  const me = await lead.member();
  const key = await teamKey(lead.state.key);
  const nonce = 'EEEEEEEEEEEEEEEEEEEEEE';
  const blob = await sealSigned(key, me, { k: 'act', nonce, at: relay.now(), action: { kind: 'reply', thread: 'th-parser', note: 'once' } }, aad.send(lead.state.team, me.id, dev.meId));
  let onDisk = null;
  dev.run = async () => { onDisk = saved.dev.at(-1).seen.find(([k]) => k === `${me.id}:${nonce}`); return { status: 200, text: 'Reply sent.' }; };
  await dev.take({ item: 'i1', from: me.id, blob });
  assert.ok(onDisk, 'the id was on disk while the action ran');
  assert.match(onDisk[1].text, /Not confirmed/);
  lead.stop(); dev.stop();
});

test('a relay that opens the socket and never says hello is left and retried', async () => {
  const { relay, net, timers, lead, dev } = await crew();
  dev.stop();
  // The hello never comes; pings still get their pong.
  const quiet = { ...net, socket(url) {
    const s = net.socket(url);
    const add = s.addEventListener;
    s.addEventListener = (type, fn) => add(type, type === 'message' ? (ev) => { if (!String(ev.data).includes('"hello"')) fn(ev); } : fn);
    return s;
  } };
  const again = new Team({ state: structuredClone(dev.state), net: quiet, now: () => relay.now(), timers, random: () => 1 });
  again.start();
  await until(() => again.ws?.readyState === 1, 'the socket open');
  assert.equal(again.link, 'connecting');
  await timers.advance(15000);
  assert.equal(again.link, 'waiting');
  again.stop(); lead.stop();
});

test('their answer that comes before the relay\'s slow ack is the answer', async () => {
  const { lead, dev } = await crew();
  const say = lead.say.bind(lead);
  lead.say = async (msg) => {
    if (msg.t !== 'send') return say(msg);
    await say(msg);
    await until(() => lead.out.size === 0, 'their answer');
    return { t: 'err', code: 'closed', text: 'Not sent: the relay did not answer.' };
  };
  const out = await lead.act(dev.meId, { kind: 'reply', thread: 'th-parser', note: 'Rebase on main first.' });
  assert.deepEqual(out, { status: 200, text: 'Reply sent.' });
  lead.stop(); dev.stop();
});

test('an edit read from an older roster is refused, so it never undoes a newer one', async () => {
  const { lead, dev } = await crew();
  const before = lead.current();
  assert.equal((await lead.setRole(dev.meId, 'viewer')).t, 'ok');
  const late = await lead.pushRoster(before);
  assert.equal(late.code, 'stale');
  await until(() => dev.me?.role === 'viewer', 'the dev a Viewer');
  assert.equal(lead.people.get(dev.meId).role, 'viewer', 'the older list did not put the old role back');
  lead.stop(); dev.stop();
});

test('an action whose id cannot be saved does not run, sends no answer, and stays on the relay', async () => {
  const { relay, lead, dev, ran } = await crew();
  const me = await lead.member();
  const key = await teamKey(lead.state.key);
  const blob = await sealSigned(key, me, { k: 'act', nonce: 'FFFFFFFFFFFFFFFFFFFFFF', at: relay.now(), action: { kind: 'reply', thread: 'th-parser', note: 'no disk' } }, aad.send(lead.state.team, me.id, dev.meId));
  dev.saveFn = async () => { throw new Error('disk full'); };
  const sent = [];
  const say = dev.say.bind(dev);
  dev.say = async (msg) => { sent.push(msg); return say(msg); };
  await dev.take({ item: 'i1', from: me.id, blob });
  assert.equal(ran.length, 0);
  assert.equal(sent.some((m) => m.t === 'send'), false, 'no "not run" goes: a lost ack would let it run later');
  assert.equal(sent.some((m) => m.t === 'done'), false, 'the relay keeps it');
  assert.equal(dev.seen.has(`${me.id}:FFFFFFFFFFFFFFFFFFFFFF`), false, 'a later try may run it');
  lead.stop(); dev.stop();
});

test('an answer the relay did not take leaves the action on the relay, so it comes again', async () => {
  const { relay, lead, dev, ran } = await crew();
  const me = await lead.member();
  const key = await teamKey(lead.state.key);
  const blob = await sealSigned(key, me, { k: 'act', nonce: 'GGGGGGGGGGGGGGGGGGGGGG', at: relay.now(), action: { kind: 'reply', thread: 'th-parser', note: 'lost answer' } }, aad.send(lead.state.team, me.id, dev.meId));
  const sent = [];
  const say = dev.say.bind(dev);
  dev.say = async (msg) => { sent.push(msg); return msg.t === 'send' ? { t: 'err', code: 'closed', text: 'Not sent.' } : say(msg); };
  await dev.take({ item: 'i1', from: me.id, blob });
  assert.equal(ran.length, 1);
  assert.equal(sent.some((m) => m.t === 'done'), false, 'no ack: the relay keeps it');
  // It comes again: the seen id answers with the same result, and nothing runs twice.
  dev.say = async (msg) => { sent.push(msg); return say(msg); };
  await dev.take({ item: 'i1', from: me.id, blob });
  assert.equal(ran.length, 1);
  assert.ok(sent.some((m) => m.t === 'done'));
  lead.stop(); dev.stop();
});

test('two edits that cross never sign two rosters with one version', async () => {
  const { lead, dev } = await crew();
  const sent = [];
  const say = lead.say.bind(lead);
  lead.say = async (msg) => { if (msg.t === 'roster') sent.push(msg.roster); return say(msg); };
  const [a, b] = await Promise.all([lead.setRole(dev.meId, 'viewer'), lead.setRole(dev.meId, 'deputy')]);
  assert.equal(a.t, 'ok');
  assert.equal(b.code, 'stale', 'the second edit read the older team');
  const vers = sent.map((r) => JSON.parse(r.body).ver);
  assert.equal(new Set(vers).size, vers.length, 'one roster per version');
  lead.stop(); dev.stop();
});

test('a second roster the lead signed at a version this Mac took is refused', async () => {
  const { lead, dev } = await crew();
  assert.equal((await lead.setRole(dev.meId, 'viewer')).t, 'ok');
  await until(() => dev.me?.role === 'viewer', 'the dev a Viewer');
  const body = JSON.parse(lead.rosterSigned.body);
  const { v, ...rest } = body;
  const sibling = await signRoster(await lead.member(), { ...rest, at: body.at + 1 });
  assert.equal(await dev.takeRoster(sibling), false);
  assert.equal(dev.state.rosterHash.length, 64);
  lead.stop(); dev.stop();
});

test('a roster whose answer was lost goes again as it was, never signed anew', async () => {
  const { lead, dev, timers } = await crew();
  const sent = [];
  const say = lead.say.bind(lead);
  let lose = true;
  lead.say = async (msg) => {
    if (msg.t !== 'roster') return say(msg);
    sent.push(msg.roster);
    const r = await say(msg);
    if (lose) { lose = false; return { t: 'err', code: 'closed', text: 'Not sent: the relay did not answer.' }; }
    return r;
  };
  assert.equal((await lead.setRole(dev.meId, 'viewer')).code, 'closed');
  assert.ok(lead.state.unsent, 'kept until the relay answers');
  const again = await lead.setRole(dev.meId, 'deputy');
  assert.equal(again.code, 'stale');
  assert.equal(sent[1].body, sent[0].body, 'the same roster went again');
  // The relay had it: the lead reads the team again, and only then signs the next version.
  const read = () => lead.state.unsent === undefined && lead.roster.ver === JSON.parse(sent[0].body).ver && lead.link === 'online';
  for (let i = 0; i < 30 && !read(); i++) await timers.advance(5000);
  assert.ok(read(), 'the roster read again');
  assert.equal((await lead.setRole(dev.meId, 'deputy')).t, 'ok');
  const vers = sent.map((r) => JSON.parse(r.body).ver);
  assert.equal(new Set(sent.map((r) => r.body)).size, new Set(vers).size, 'one roster per version');
  lead.stop(); dev.stop();
});

test('a roster floor that does not reach the disk is said on the screen', async () => {
  const { lead, dev } = await crew();
  dev.saveFn = async () => { throw new Error('disk full'); };
  assert.equal((await lead.setRole(dev.meId, 'viewer')).t, 'ok');
  await until(() => dev.me?.role === 'viewer', 'the newer roster taken all the same');
  assert.equal(dev.view().unsaved, true);
  lead.stop(); dev.stop();
});

test('a project dropped while the action\'s id is saved stops the action', async () => {
  const { relay, lead, dev, ran } = await crew();
  const me = await lead.member();
  const key = await teamKey(lead.state.key);
  const blob = await sealSigned(key, me, { k: 'act', nonce: 'HHHHHHHHHHHHHHHHHHHHHH', at: relay.now(), action: { kind: 'reply', thread: 'th-parser', note: 'late share' } }, aad.send(lead.state.team, me.id, dev.meId));
  const saveFn = dev.saveFn;
  dev.saveFn = async (s) => { if (dev.state.shared.length) { dev.state.shared = []; } return saveFn(s); };
  await dev.take({ item: 'i1', from: me.id, blob });
  assert.equal(ran.length, 0);
  lead.stop(); dev.stop();
});

test('a clock set right while /me was out is not read as a removal', async () => {
  const { relay, net, timers, lead, dev } = await crew();
  dev.stop();
  let off = -10 * MIN;
  const http = net.http.bind(net);
  const fixing = { ...net, http: async (...a) => { const r = await http(...a); off = 0; return r; } };
  const again = new Team({ state: structuredClone(dev.state), net: fixing, now: () => relay.now() + off, timers, random: () => 1 });
  assert.equal(await again.probe(), null);
  assert.equal(again.state.status, 'member');
  again.stop(); lead.stop();
});

test('a dev removed while the welcome is opened keeps no team key', async () => {
  const { lead, dev } = await crew();
  const me = await lead.member();
  const devDh = dev.people.get(dev.meId).dh;
  const blob = await sealTo(me, devDh, { teamKey: lead.state.key }, aad.welcome(lead.state.team, me.id, dev.meId));
  dev.state.key = null; dev.key = null;
  const member = dev.member.bind(dev);
  let ended = false;
  dev.member = async () => { const x = await member(); if (!ended) { ended = true; dev.end('removed'); } return x; };
  await dev.take({ item: 'w2', from: me.id, blob });
  assert.equal(dev.state.status, 'removed');
  assert.equal(dev.state.key, null);
  lead.stop();
});

test('a clock set forward and back again does not run an action twice', async () => {
  const { relay, lead, dev, ran, setBoard } = await crew();
  const me = await lead.member();
  const key = await teamKey(lead.state.key);
  const seal1 = (nonce, at) => sealSigned(key, me, { k: 'act', nonce, at, action: { kind: 'reply', thread: 'th-parser', note: 'once' } }, aad.send(lead.state.team, me.id, dev.meId));
  const first = await seal1('JJJJJJJJJJJJJJJJJJJJJJ', relay.now());
  await dev.take({ item: 'a1', from: me.id, blob: first });
  assert.equal(ran.length, 1);
  let off = 60 * MIN;
  dev.now = () => relay.now() + off;
  await dev.take({ item: 'a2', from: me.id, blob: await seal1('KKKKKKKKKKKKKKKKKKKKKK', relay.now() + off) });
  off = 0;
  setBoard({ board: boardNow(relay.now()), ok: true, at: relay.now() });
  await dev.take({ item: 'a1', from: me.id, blob: first });
  assert.equal(ran.length, 1, 'the first action did not run again');
  lead.stop(); dev.stop();
});

test('a shared list that does not reach the disk is reported, and is in use all the same', async () => {
  const { lead, dev } = await crew();
  dev.saveFn = () => Promise.reject(new Error('the Keychain said no'));
  assert.equal(await dev.share([]), false);
  assert.deepEqual(dev.state.shared, []);
  assert.equal(dev.view().unsaved, true);
  dev.saveFn = () => Promise.resolve();
  assert.equal(await dev.share([P]), true);
  assert.equal(dev.view().unsaved, false);
  lead.stop(); dev.stop();
});

test('a project dropped while the list saves is out of the waiting summary at once', async () => {
  const { relay, timers, lead, dev } = await crew();
  await dev.share([P, Q]);
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.get(dev.meId)?.body.tickets.some((k) => k.title === 'Private work'), 'both projects shared');
  const b2 = boardNow(relay.now()); b2.tickets.find((k) => k.thread.threadId === 'th-secret').place = 'In review';
  dev.board(b2);
  let release;
  const saveFn = dev.saveFn;
  dev.saveFn = (s) => new Promise((r) => { release = r; }).then(() => saveFn(s));
  // Nothing sent after the drop carries Q, even while the list saves; the summary waits for its revision on disk
  // (PR-Agent r14 on public #7).
  const sealed = [];
  const seal = dev.sealSummary.bind(dev);
  dev.sealSummary = async (body, at) => { sealed.push(JSON.stringify(body)); return seal(body, at); };
  const saving = dev.share([P]);
  await timers.advance(10000);
  await settle();
  for (const j of sealed) assert.doesNotMatch(j, /Private work/);
  dev.saveFn = saveFn;
  release();
  assert.equal(await saving, true);
  await timers.advance(10000);
  await until(() => !JSON.stringify(lead.summaries.get(dev.meId).body).includes('Private work'), 'Q gone at the lead');
  for (const j of sealed) assert.doesNotMatch(j, /Private work/);
  lead.stop(); dev.stop();
});

test('writes land in order: an older one never lands after a newer one', async () => {
  const { lead, dev } = await crew();
  let stored = null, n = 0;
  dev.saveFn = (s) => { const c = structuredClone(s); const slow = ++n === 1; return new Promise((r) => setTimeout(r, slow ? 30 : 1)).then(() => { stored = c; }); };
  dev.state.mark = 1; dev.save();
  dev.state.mark = 2; assert.equal(await dev.saveNow(), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stored.mark, 2);
  lead.stop(); dev.stop();
});

test('the lead keeps the signed roster until its version is on disk', async () => {
  const { lead, dev } = await crew();
  const snaps = [];
  const saveFn = lead.saveFn;
  lead.saveFn = (s) => { snaps.push(structuredClone(s)); return saveFn(s); };
  const ver = lead.roster.ver + 1;
  assert.equal((await lead.setRole(dev.meId, 'viewer')).t, 'ok');
  const from = snaps.findIndex((s) => s.unsent);
  assert.ok(from >= 0, 'the signed roster was kept');
  for (const s of snaps.slice(from)) assert.ok(s.unsent || s.rosterVer >= ver, 'never without both');
  lead.stop(); dev.stop();
});

test('an invite another inviter revoked leaves this Mac\'s open links', async () => {
  const { lead, dev } = await crew();
  const { id } = await lead.invite({ site: 'https://yeschef.codes' });
  assert.ok(lead.invites.has(id));
  await lead.handle({ t: 'invite-gone', invite: id });
  assert.equal(lead.invites.has(id), false);
  lead.stop(); dev.stop();
});

// PR 3: the match code and the areas (Dan's 1b and 2a, 2026-11-10).

test('the match code: the dev\'s waiting screen and the lead\'s ask show the same six digits', async () => {
  const relay = fakeRelay();
  const net = fakeNet(relay);
  const timers = clock(relay);
  const now = () => relay.now();
  const lead = new Team({ state: await createTeam({ relay: 'https://relay.test', teamName: 'Northwind', name: 'Sam Lead', net, now }), net, now, timers, random: () => 1 });
  lead.start();
  await until(() => lead.link === 'online');
  const { link } = await lead.invite();
  const state = await joinTeam({ link, name: 'Maya Rios', projects: ['Fernpay', 'Loopline'], net, now });
  assert.match(state.code, /^\d{3} \d{3}$/);
  await until(() => lead.pending.size === 1, 'the ask');
  const ask = lead.view().pending[0];
  assert.equal(ask.code, state.code);
  assert.deepEqual(ask.projects, ['Fernpay', 'Loopline']);
  const dev = new Team({ state, net, now, timers, random: () => 1 });
  assert.equal(dev.view().code, state.code, 'the waiting screen shows it');
  lead.stop();
});

test('areas travel sealed in the roster: names and each member\'s area reach the dev, never the relay', async () => {
  const { relay, lead, dev } = await crew();
  assert.equal((await lead.addArea('Desktop')).t, 'ok');
  assert.equal((await lead.addArea('Mobile')).t, 'ok');
  assert.equal((await lead.addArea('desktop')).code, 'bad', 'one name once');
  const desktop = lead.areas.find((a) => a.name === 'Desktop').id;
  assert.equal((await lead.setRole(dev.meId, 'owner', undefined, desktop)).t, 'ok');
  await until(() => dev.me?.area === desktop && dev.me?.role === 'owner', 'the dev\'s new place');
  assert.deepEqual(dev.view().areas.map((a) => a.name), ['Desktop', 'Mobile']);
  // The relay keeps the signed roster as it came. No area name is in it.
  assert.doesNotMatch(relay.sql.exec('SELECT roster FROM team').one().roster, /Desktop|Mobile/);
  // A Viewer or a Deputy sits in no area.
  assert.equal((await lead.setRole(dev.meId, 'viewer', undefined, desktop)).t, 'ok');
  await until(() => dev.me?.role === 'viewer', 'made a Viewer');
  assert.equal(dev.me.area, null);
  // Taking an area away keeps its people on the team, with no area.
  assert.equal((await lead.setRole(dev.meId, 'engineer', undefined, desktop)).t, 'ok');
  await until(() => dev.me?.area === desktop, 'back in Desktop');
  assert.equal((await lead.removeArea(desktop)).t, 'ok');
  await until(() => dev.areas.length === 1, 'the area gone');
  assert.equal(dev.me.area, null);
  assert.equal(dev.me.role, 'engineer');
  lead.stop(); dev.stop();
});

test('the lead\'s Yes Chef shows an open invite\'s link again, and it still lets a dev ask', async () => {
  const { relay, net, lead } = await crew();
  const made = await lead.invite({ site: 'https://yeschef.codes' });
  const shown = lead.links({ site: 'https://yeschef.codes' }).find((l) => l.id === made.id);
  assert.equal(shown.link, made.link);
  const state = await joinTeam({ link: shown.link, name: 'Jon Park', net, now: () => relay.now() });
  assert.equal(state.status, 'pending');
  lead.stop();
});

test('under: each member reports to whom the chart says, sealed in the roster, and a bad one reads as not checked', async () => {
  const { relay, lead, dev } = await crew();
  assert.equal(dev.me.under, lead.meId, 'an Engineer in no area reports to the lead');
  assert.equal((await lead.addArea('Site')).t, 'ok');
  const site = lead.areas[0].id;
  assert.equal((await lead.setRole(dev.meId, 'engineer', undefined, site)).t, 'ok');
  await until(() => dev.me?.area === site, 'the dev in Site');
  assert.equal(dev.me.under, lead.meId, 'no Area owner yet: still the lead');
  assert.equal(dev.view().people.find((p) => p.id === lead.meId).under, null, 'the lead reports to nobody');
  assert.doesNotMatch(relay.sql.exec('SELECT roster FROM team').one().roster, /under/);
  // The chart rule alone: an Engineer in an area with an owner reports to that owner.
  const people = new Map([['L', { role: 'lead' }], ['O', { role: 'owner', area: 'a' }], ['E', { role: 'engineer', area: 'a' }],
    ['F', { role: 'engineer', area: 'b' }], ['D', { role: 'deputy' }], ['V', { role: 'viewer' }]]);
  assert.deepEqual(Object.fromEntries(chartUnder(people, 'L', [{ id: 'a' }, { id: 'b' }])), { O: 'L', E: 'O', F: 'L', D: 'L', V: 'L' });
  lead.stop(); dev.stop();
});

test('under from a roster that loops or names a stranger reads as not checked', async () => {
  const p = (id, under) => [id, { id, under }];
  const people = new Map([p('L', 'X'), p('A', 'B'), p('B', 'A'), p('C', 'nobody'), p('D', 'D'), p('E', 'L'), p('F', 'E')]);
  // The check takeRoster runs on every roster it reads.
  const { readUnderForTest } = await import('./team.mjs');
  readUnderForTest(people, 'L');
  assert.deepEqual(Object.fromEntries([...people].map(([id, x]) => [id, x.under])), { L: null, A: null, B: null, C: null, D: null, E: 'L', F: 'E' });
});

test('a socket that never opens is left and retried, not kept connecting', async () => {
  const { relay, timers, lead, dev } = await crew();
  dev.stop();
  // A relay or proxy that takes the connection and never finishes the upgrade: no open, no close.
  const hung = { http: async () => ({ status: 503, body: {} }), socket: () => ({ readyState: 0, addEventListener() {}, close() {} }) };
  const again = new Team({ state: structuredClone(dev.state), net: hung, now: () => relay.now(), timers, random: () => 1 });
  again.start();
  await until(() => again.ws, 'the socket made');
  assert.equal(again.link, 'connecting');
  await timers.advance(15000);
  assert.equal(again.link, 'waiting');
  again.stop(); lead.stop();
});

test('a board read before the clock went back is not fresh', async () => {
  const { relay, lead, dev, ran, setBoard } = await crew();
  setBoard({ board: boardNow(relay.now()), ok: true, at: relay.now() + 5 * 60000 });
  const out = await lead.act(dev.meId, { kind: 'reply', thread: 'th-parser', note: 'x' });
  assert.equal(out.status, 409);
  assert.match(out.text, /^Not checked/);
  assert.equal(ran.length, 0);
  lead.stop(); dev.stop();
});

test('a summary whose answer was lost does not count as sent: the one before it goes again', async () => {
  const { relay, timers, lead, dev } = await crew();
  const say = dev.say.bind(dev);
  let lose = false;
  // The relay takes the summary; its answer is lost.
  dev.say = async (msg) => { const r = await say(msg); return lose && msg.t === 'summary' ? { t: 'err', code: 'timeout', text: 'The relay did not answer.' } : r; };
  const a = boardNow(relay.now());
  dev.board(a);
  await until(() => lead.summaries.size === 1, 'summary A');
  const tickets = () => JSON.stringify(lead.summaries.get(dev.meId)?.body.tickets);
  const first = tickets();
  lose = true;
  await timers.advance(10000);
  const b = boardNow(relay.now()); b.tickets[1].place = 'Merged';
  dev.board(b);
  await until(() => tickets() !== first, 'summary B at the relay');
  lose = false;
  dev.board(a);
  await timers.advance(20000);
  await until(() => tickets() === first, 'summary A again');
  lead.stop(); dev.stop();
});

test('a stop and start while the keys load opens one socket, not two', async () => {
  const { relay, net, timers, lead, dev } = await crew();
  dev.stop();
  let made = 0;
  const counting = { ...net, socket: (url) => { made++; return net.socket(url); } };
  const again = new Team({ state: structuredClone(dev.state), net: counting, now: () => relay.now(), timers, random: () => 1 });
  const member = again.member.bind(again);
  let go;
  const gate = new Promise((r) => { go = r; });
  again.member = async () => { await gate; return member(); };
  again.start();
  again.stop();
  again.start();
  go();
  await until(() => again.link === 'online', 'online');
  await settle(); await settle();
  assert.equal(made, 1);
  again.stop(); lead.stop();
});

test('a project dropped just before a restart still leaves the relay\'s copy', async () => {
  const { relay, timers, lead, dev, saved } = await crew();
  await dev.share([P, Q]);
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.get(dev.meId)?.body.tickets.some((k) => k.title === 'Private work'), 'both projects shared');
  // Q is dropped; its replacement waits out the limit, and the Mac quits before it goes.
  await dev.share([P]);
  dev.stop();
  const again = new Team({ state: structuredClone(saved.dev.at(-1)), save: () => {}, net: dev.net, now: () => relay.now(), timers, random: () => 1 });
  again.start();
  await until(() => again.link === 'online', 'online again');
  await timers.advance(10000);
  await until(() => !lead.summaries.get(dev.meId)?.body.tickets.some((k) => k.title === 'Private work'), 'Q gone from the relay');
  again.stop(); lead.stop();
});

test('a probe that answers after a stop and start leaves the new connection alone', async () => {
  const relay = fakeRelay();
  const net = fakeNet(relay);
  const timers = clock(relay);
  const now = () => relay.now();
  const lead = new Team({ state: await createTeam({ relay: 'https://relay.test', teamName: 'T', name: 'L', net, now }), net, now, timers, random: () => 1 });
  lead.start();
  await until(() => lead.link === 'online');
  const { link } = await lead.invite();
  const state = await joinTeam({ link, name: 'D', net, now });
  // Sockets fail to open, and /me waits until the test answers it.
  let probes = 0, answer = null, fail = true;
  const slow = { ...net, http: (method, url, ...rest) => (url.endsWith('/me') ? (probes++, new Promise((r) => { answer = r; })) : net.http(method, url, ...rest)), socket: (url) => { net.down = fail; return net.socket(url); } };
  const dev = new Team({ state, net: slow, now, timers, random: () => 1 });
  dev.start();
  for (let i = 0; i < 3 && probes === 0; i++) { await until(() => dev.link === 'waiting' || probes > 0, 'a retry or the probe'); if (probes === 0) await timers.advance(dev.retryMs); }
  assert.equal(probes, 1);
  dev.stop();
  fail = false;
  dev.start();
  await until(() => dev.link === 'online', 'the new connection online');
  answer({ status: 503, body: {} });
  await settle(); await settle();
  assert.equal(dev.link, 'online');
  dev.stop(); lead.stop();
});

test('start() during a backoff leaves no retry to knock the new connection offline', async () => {
  const { net, timers, lead, dev } = await crew();
  net.drop();
  await until(() => dev.link === 'waiting', 'a retry set');
  const ms = dev.retryMs;
  dev.start();
  await until(() => dev.link === 'online', 'online again');
  await timers.advance(ms);
  await settle(); await settle();
  assert.equal(dev.link, 'online');
  lead.stop(); dev.stop();
});

test('a summary held through an outage carries the time its board was read', async () => {
  const { relay, timers, lead, dev } = await crew();
  const say = dev.say.bind(dev);
  let lose = true;
  dev.say = (msg) => (lose && msg.t === 'summary' ? Promise.resolve({ t: 'err', code: 'closed', text: 'Not sent.' }) : say(msg));
  const read = relay.now();
  dev.board(boardNow(read));
  await settle(); await settle();
  lose = false;
  await timers.advance(60000);
  await until(() => lead.summaries.size === 1, 'the summary at the lead');
  assert.equal(lead.summaries.get(dev.meId).body.at, read);
  lead.stop(); dev.stop();
});

test('after the clock goes back, a forget waits one limit, not the whole jump', async () => {
  const { relay, timers, lead, dev } = await crew();
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.size === 1);
  dev.now = () => relay.now() - 3600000;
  await dev.share([]);
  await timers.advance(10000);
  await until(() => lead.summaries.size === 0, 'the summary gone');
  lead.stop(); dev.stop();
});

test('a summary dated far ahead is not taken, so right-dated ones still show', async () => {
  const { relay, timers, lead, dev } = await crew();
  dev.now = () => relay.now() + 86400000;
  dev.board(boardNow(relay.now()));
  await settle(); await settle(); await settle();
  await timers.advance(10000);
  dev.now = () => relay.now();
  const b = boardNow(relay.now()); b.tickets[1].place = 'Merged';
  dev.board(b);
  await timers.advance(10000);
  await until(() => lead.summaries.get(dev.meId)?.body.tickets.some((k) => k.place === 'Merged'), 'the right-dated summary');
  lead.stop(); dev.stop();
});

test('a Mac waiting for its key keeps one summary per teammate, the latest', async () => {
  const { lead, dev } = await crew();
  dev.key = null; dev.state.key = null;
  for (let i = 0; i < 5; i++) await dev.takeSummary(lead.meId, `blob-${i}`, i);
  const held = dev.later.filter((x) => x.t === 'summary' && x.m === lead.meId);
  assert.equal(held.length, 1);
  assert.equal(held[0].blob, 'blob-4');
  lead.stop(); dev.stop();
});

test('a teammate who unshares while this Mac waits for its key stays unshared once the key comes', async () => {
  const { lead, dev } = await crew();
  dev.key = null; dev.state.key = null;
  await dev.takeSummary(lead.meId, 'blob', 1);
  await dev.heard(JSON.stringify({ t: 'gone', m: lead.meId }));
  assert.equal(dev.later.filter((x) => x.t === 'summary' && x.m === lead.meId).length, 0);
  lead.stop(); dev.stop();
});

test('a replacement built from the same board is newer, so the relay cannot hand back the one it replaced', async () => {
  const { relay, timers, lead, dev } = await crew();
  await dev.share([P, Q]);
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.get(dev.meId)?.body.tickets.some((k) => k.title === 'Private work'), 'both projects shared');
  const old = relay.sql.exec('SELECT blob FROM summary WHERE m = ?', dev.meId).one().blob;
  await dev.share([P]);
  await timers.advance(10000);
  await until(() => !lead.summaries.get(dev.meId)?.body.tickets.some((k) => k.title === 'Private work'), 'Q dropped');
  // The relay replays the summary from before the drop.
  await lead.takeSummary(dev.meId, old, relay.now());
  assert.ok(!lead.summaries.get(dev.meId).body.tickets.some((k) => k.title === 'Private work'), 'the replay is not taken');
  lead.stop(); dev.stop();
});

test('a Mac with no key asks again on its heartbeat once a day has passed', async () => {
  const { relay, timers, lead, dev } = await crew();
  dev.key = null; dev.state.key = null;
  dev.state.keyAskAt = relay.now() - 86400000 - 1;
  await timers.advance(30000);
  await until(() => dev.state.key, 'a new welcome');
  lead.stop(); dev.stop();
});

test('a Mac waiting for its key keeps a bounded inbox: no copies, nothing past an action\'s age', async () => {
  const { relay, lead, dev } = await crew();
  dev.key = null; dev.state.key = null;
  const inbox = () => dev.later.filter((x) => x.t === 'inbox');
  for (let i = 0; i < 3; i++) await dev.take({ item: `old${i}`, from: lead.meId, blob: 'x', at: relay.now() - ACT_TTL - 1 });
  await dev.take({ item: 'new', from: lead.meId, blob: 'x', at: relay.now() });
  await dev.take({ item: 'new', from: lead.meId, blob: 'x', at: relay.now() });
  assert.deepEqual(inbox().map((x) => x.item), ['new']);
  for (let i = 0; i < 250; i++) await dev.take({ item: `n${i}`, from: lead.meId, blob: 'x', at: relay.now() });
  assert.equal(inbox().length, 100);
  assert.equal(inbox().at(-1).item, 'n249');
  lead.stop(); dev.stop();
});

test('a teammate whose clock went back still replaces their summary: a dropped project leaves', async () => {
  const { relay, timers, lead, dev } = await crew();
  await dev.share([P, Q]);
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.get(dev.meId)?.body.tickets.some((k) => k.title === 'Private work'), 'both projects shared');
  dev.now = () => relay.now() - 3600000;
  dev.board(boardNow(dev.now()));
  await dev.share([P]);
  await timers.advance(10000);
  await until(() => !lead.summaries.get(dev.meId)?.body.tickets.some((k) => k.title === 'Private work'), 'Q dropped at the lead');
  lead.stop(); dev.stop();
});

test('an action whose relay answer was lost is not called unsent: it may still run', async () => {
  const { timers, lead, dev } = await crew();
  dev.stop();
  const say = lead.say.bind(lead);
  lead.say = async (msg) => { if (msg.t !== 'send') return say(msg); await say(msg); return { t: 'err', code: 'closed', text: 'Not sent: the team connection dropped.' }; };
  const out = lead.act(dev.meId, { kind: 'reply', thread: 'th-parser', note: 'Rebase on main first.' });
  await settle(); await settle(); await settle();
  await timers.advance(30000);
  const r = await out;
  assert.notEqual(r.status, 503);
  assert.match(r.text, /^Not confirmed/);
  lead.stop();
});

test('a teammate\'s withdrawn summary is not taken again when the relay replays it', async () => {
  const { relay, timers, lead, dev } = await crew();
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.size === 1);
  const old = relay.sql.exec('SELECT blob FROM summary WHERE m = ?', dev.meId).one().blob;
  await dev.share([]);
  await timers.advance(10000);
  await until(() => lead.summaries.size === 0, 'the summary gone');
  await lead.takeSummary(dev.meId, old, relay.now());
  assert.equal(lead.summaries.size, 0);
  lead.stop(); dev.stop();
});

test('a summary whose revision did not reach the disk does not go out', async () => {
  const { relay, timers, lead, dev } = await crew();
  dev.saveFn = async () => { throw new Error('disk full'); };
  dev.board(boardNow(relay.now()));
  await settle(); await settle(); await settle();
  await timers.advance(10000);
  await settle();
  assert.equal(lead.summaries.size, 0);
  assert.equal(relay.sql.exec('SELECT COUNT(*) AS n FROM summary WHERE m = ? AND blob IS NOT NULL', dev.meId).one().n, 0);
  lead.stop(); dev.stop();
});

test('a refused action\'s id is on disk before the refusal goes', async () => {
  const { relay, lead, dev, saved, setBoard } = await crew();
  setBoard({ board: boardNow(relay.now()), ok: true, at: relay.now() - BOARD_FRESH_MS - 1 });
  let onDisk = null;
  const reply = dev.reply.bind(dev);
  dev.reply = async (...args) => { onDisk = (saved.dev.at(-1)?.seen || []).some(([, v]) => v?.status === 409); return reply(...args); };
  const out = await lead.act(dev.meId, { kind: 'reply', thread: 'th-parser', note: 'x' });
  assert.equal(out.status, 409);
  assert.equal(onDisk, true, 'the refused id was on disk when the refusal went');
  lead.stop(); dev.stop();
});

test('an offline teammate\'s summary shows as cached, not live', async () => {
  const { relay, lead, dev } = await crew();
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.size === 1);
  const person = () => lead.view().people.find((p) => p.id === dev.meId);
  assert.equal(person().live, true);
  dev.stop();
  await until(() => !lead.online.has(dev.meId), 'the dev offline');
  assert.ok(person().summary, 'the summary is still shown');
  assert.equal(person().live, false);
  lead.stop();
});

test('a refusal that did not reach the disk does not go: the relay keeps the action', async () => {
  const { relay, timers, lead, dev, setBoard } = await crew();
  setBoard({ board: boardNow(relay.now()), ok: true, at: relay.now() - BOARD_FRESH_MS - 1 });
  dev.saveFn = async () => { throw new Error('disk full'); };
  const out = lead.act(dev.meId, { kind: 'reply', thread: 'th-parser', note: 'x' });
  await settle(); await settle(); await settle(); await settle();
  await timers.advance(30000);
  const r = await out;
  assert.notEqual(r.status, 409, 'no refusal was sent');
  assert.equal(relay.sql.exec('SELECT COUNT(*) AS n FROM inbox WHERE to_m = ?', dev.meId).one().n, 1, 'the relay still holds it');
  lead.stop(); dev.stop();
});

test('a revoked invite or an answered ask does not come back when the key arrives', async () => {
  const { lead, dev } = await crew();
  dev.key = null; dev.state.key = null;
  dev.later.push({ t: 'invite', invite: { id: 'inv1' } }, { t: 'pending', pending: { m: 'm1', invite: 'inv1' } }, { t: 'pending', pending: { m: 'm2', invite: 'inv2' } });
  await dev.heard(JSON.stringify({ t: 'invite-gone', invite: 'inv1' }));
  await dev.heard(JSON.stringify({ t: 'pending-gone', m: 'm2' }));
  assert.deepEqual(dev.later.filter((x) => x.t === 'invite' || x.t === 'pending'), []);
  lead.stop(); dev.stop();
});

test('a hello queued behind a slow step does not speak for a newer socket', async () => {
  const { lead, dev } = await crew();
  let hello = null;
  const handle = dev.handle.bind(dev);
  dev.handle = (msg) => { if (msg.t === 'hello') hello = msg; return handle(msg); };
  dev.stop(); dev.start();
  await until(() => dev.link === 'online' && hello, 'the dev back online');
  const old = dev.ws;
  let release;
  dev.chain = new Promise((r) => { release = r; });
  const done = dev.heard(JSON.stringify(hello));
  dev.ws = { send() {}, close() {}, addEventListener() {} };
  dev.link = 'connecting';
  release();
  await done;
  assert.equal(dev.link, 'connecting', 'the old socket\'s hello did not open the new one');
  dev.ws = old;
  lead.stop(); dev.stop();
});

test('a key ask saved in the future does not hold the next one for days', async () => {
  const { relay, lead, dev } = await crew();
  dev.state.keyAskAt = relay.now() + 30 * 86400000;
  let sent = 0;
  const say = dev.say.bind(dev);
  dev.say = (msg) => { if (msg.t === 'send' && msg.to === lead.meId) sent++; return say(msg); };
  await dev.askKey();
  assert.equal(sent, 1);
  assert.ok(dev.state.keyAskAt <= relay.now());
  lead.stop(); dev.stop();
});

test('a pending hello to a saved member is refused, and no summary goes without its own signed role', async () => {
  const { relay, lead, dev } = await crew();
  dev.people = new Map();
  await dev.handle({ t: 'hello', role: 'pending' });
  dev.board(boardNow(relay.now()));
  await settle(); await settle(); await settle();
  assert.equal(relay.sql.exec('SELECT COUNT(*) AS n FROM summary WHERE m = ? AND blob IS NOT NULL', dev.meId).one().n, 0);
  assert.equal(dev.stopped, true);
  lead.stop(); dev.stop();
});

test('an identical board read while a summary seals does not throw the sealed one away', async () => {
  const { relay, lead, dev } = await crew();
  const b = boardNow(relay.now());
  const seal = dev.sealSummary.bind(dev);
  let n = 0;
  dev.sealSummary = async (...a) => { n++; if (n < 6) dev.board(b); return seal(...a); };
  dev.board(b);
  await until(() => lead.summaries.size === 1, 'the summary in');
  assert.equal(n, 1);
  lead.stop(); dev.stop();
});

test('a repeated withdrawal does not raise the summary floor again', async () => {
  const { lead, dev } = await crew();
  lead.summaryFloor.set(dev.meId, 1000);
  for (let i = 0; i < 3; i++) await lead.handle({ t: 'gone', m: dev.meId });
  assert.equal(lead.summaryFloor.get(dev.meId), 1000.5);
  lead.stop(); dev.stop();
});

test('a clock set a day ahead and then right again does not shut out teammate actions for a day', async () => {
  const { relay, lead, dev, ran, setBoard } = await crew();
  dev.state.clockHigh = relay.now() + 86400000;
  setBoard({ board: boardNow(relay.now()), ok: true, at: relay.now() });
  const out = await lead.act(dev.meId, { kind: 'reply', thread: 'th-parser', note: 'x' });
  assert.equal(ran.length, 1, out.text);
  lead.stop(); dev.stop();
});

test('a full list of action ids sends no "not run" and leaves the action on the relay', async () => {
  const { relay, lead, dev, ran, setBoard } = await crew();
  setBoard({ board: boardNow(relay.now()), ok: true, at: relay.now() });
  for (let i = 0; i < 500; i++) dev.seen.set(`x:${i}`, { at: relay.now(), status: 200, text: '' });
  const me = await lead.member();
  const key = await teamKey(lead.state.key);
  const blob = await sealSigned(key, me, { k: 'act', nonce: 'HHHHHHHHHHHHHHHHHHHHHH', at: relay.now(), action: { kind: 'reply', thread: 'th-parser', note: 'full' } }, aad.send(lead.state.team, me.id, dev.meId));
  const sent = [];
  const say = dev.say.bind(dev);
  dev.say = async (msg) => { sent.push(msg); return say(msg); };
  await dev.take({ item: 'i1', from: me.id, blob });
  assert.equal(ran.length, 0);
  assert.equal(sent.some((m) => m.t === 'send'), false);
  assert.equal(sent.some((m) => m.t === 'done'), false);
  lead.stop(); dev.stop();
});

test('a welcome whose key did not reach the disk stays on the relay', async () => {
  const { lead, dev } = await crew();
  const me = await lead.member();
  const devDh = dev.people.get(dev.meId).dh;
  const blob = await sealTo(me, devDh, { teamKey: lead.state.key }, aad.welcome(lead.state.team, me.id, dev.meId));
  dev.state.key = null; dev.key = null;
  dev.saveFn = async () => { throw new Error('disk full'); };
  const sent = [];
  const say = dev.say.bind(dev);
  dev.say = async (msg) => { sent.push(msg); return say(msg); };
  await dev.take({ item: 'w2', from: me.id, blob });
  assert.equal(sent.some((m) => m.t === 'done' && m.item === 'w2'), false);
  lead.stop(); dev.stop();
});

test('a welcome that comes again while its key is not on disk stays on the relay until a save works', async () => {
  const { lead, dev } = await crew();
  const me = await lead.member();
  const devDh = dev.people.get(dev.meId).dh;
  const blob = await sealTo(me, devDh, { teamKey: lead.state.key }, aad.welcome(lead.state.team, me.id, dev.meId));
  dev.state.key = null; dev.key = null;
  const saveFn = dev.saveFn;
  dev.saveFn = async () => { throw new Error('disk full'); };
  const done = [];
  const say = dev.say.bind(dev);
  dev.say = async (msg) => { if (msg.t === 'done') done.push(msg.item); return say(msg); };
  await dev.take({ item: 'w2', from: me.id, blob });
  await dev.take({ item: 'w2', from: me.id, blob });
  assert.deepEqual(done, [], 'not let go while the key is not on disk');
  dev.saveFn = saveFn;
  await dev.take({ item: 'w2', from: me.id, blob });
  assert.deepEqual(done, ['w2']);
  lead.stop(); dev.stop();
});

test('an id dated ahead by a clock set right again does not keep expired ids from leaving', async () => {
  const { relay, timers, lead, dev, ran, setBoard } = await crew();
  setBoard({ board: boardNow(relay.now()), ok: true, at: relay.now() });
  dev.seen.clear();
  dev.seen.set('x:ahead', { at: relay.now() + 86400000, status: 409, text: '' });
  for (let i = 0; i < 499; i++) dev.seen.set(`x:${i}`, { at: relay.now() - 25 * MIN, status: 200, text: '' });
  const out = lead.act(dev.meId, { kind: 'reply', thread: 'th-parser', note: 'x' });
  await settle(); await settle(); await settle(); await settle();
  await timers.advance(30000);
  assert.equal(ran.length, 1, (await out).text);
  lead.stop(); dev.stop();
});

test('a welcome owed by an approval while welcomes were sending stays owed', async () => {
  const { lead, dev } = await crew();
  lead.state.welcomes = [dev.meId];
  lead.say = async (msg) => { if (msg.t === 'send') lead.state.welcomes = [...lead.state.welcomes, 'BBBBBBBBBBBBBBBBBBBBBB']; return { t: 'ok' }; };
  const left = await lead.sendWelcomes();
  assert.deepEqual(lead.state.welcomes, ['BBBBBBBBBBBBBBBBBBBBBB']);
  assert.deepEqual(left, ['BBBBBBBBBBBBBBBBBBBBBB']);
  lead.stop(); dev.stop();
});

test('a welcome pass while an approval waits on its roster keeps that welcome', async () => {
  const { relay, net, timers, lead } = await crew();
  const now = () => relay.now();
  const { link } = await lead.invite();
  const d2 = new Team({ state: await joinTeam({ link, name: 'Bo', shared: [P], net, now }), net, now, timers, random: () => 1 });
  d2.start();
  await until(() => lead.pending.size === 1 && d2.meId, 'the second ask at the lead');
  const id = d2.meId;
  d2.stop();
  let release = null;
  const say = lead.say.bind(lead);
  lead.say = async (msg) => { if (msg.t === 'roster') await new Promise((r) => { release = r; }); return say(msg); };
  const ap = lead.approve(id, 'engineer');
  await until(() => release, 'the roster waiting');
  await lead.sendWelcomes();
  release();
  assert.equal((await ap).t, 'ok');
  assert.equal(relay.sql.exec('SELECT COUNT(*) AS n FROM inbox WHERE to_m = ?', id).one().n, 1, 'the welcome went');
  lead.stop();
});


// The event-driven design (11-10): summaries go out on change, live comes from presence and health, and every inbox
// item is committed before it is answered or acked.

test('read times are not news: identity drops every key named at, and nothing else', () => {
  const a = { v: 1, at: 1, tickets: [{ thread: 't', changes: { at: 5, files: 2 }, prs: [{ n: 1, readyAt: 9 }] }] };
  const b = { v: 1, at: 2, tickets: [{ thread: 't', changes: { at: 6, files: 2 }, prs: [{ n: 1, readyAt: 9 }] }] };
  assert.equal(identity(a), identity(b));
  assert.notEqual(identity(a), identity({ ...b, tickets: [{ ...b.tickets[0], prs: [{ n: 1, readyAt: 10 }] }] }));
});

test('not checked since: failing uses health.since, offline uses lastSeen, both the earlier, none no time', () => {
  assert.equal(notCheckedSince({ online: true, health: { ok: false, since: 100 }, lastSeen: undefined }), 100);
  assert.equal(notCheckedSince({ online: false, health: { ok: true, since: 50 }, lastSeen: 200 }), 200);
  assert.equal(notCheckedSince({ online: false, health: { ok: false, since: 300 }, lastSeen: 200 }), 200);
  assert.equal(notCheckedSince({ online: false, health: { ok: false, since: 100 }, lastSeen: 200 }), 100);
  assert.equal(notCheckedSince({ online: false, health: { ok: true, since: 50 }, lastSeen: undefined }), null);
  assert.equal(notCheckedSince({ online: false, health: null, lastSeen: undefined }), null);
});

test('an unchanged board sends nothing however long it runs; only a change goes', async () => {
  const { relay, timers, lead, dev } = await crew();
  const sent = [];
  const say = dev.say.bind(dev);
  dev.say = async (msg) => { if (msg.t === 'summary') sent.push(msg); return say(msg); };
  const b = boardNow(relay.now());
  dev.board(b);
  await until(() => lead.summaries.size === 1);
  for (let i = 0; i < 6; i++) { await timers.advance(10 * MIN); dev.board(b); await settle(); }
  assert.equal(sent.length, 1, 'one summary in an hour of identical reads');
  assert.equal(lead.view().people.find((p) => p.id === dev.meId).live, true, 'still live: online and the board reads');
  const c = boardNow(relay.now()); c.tickets[1].place = 'Merged';
  dev.board(c);
  await timers.advance(10000);
  assert.equal(sent.length, 2);
  lead.stop(); dev.stop();
});

test('a failing board read goes out once, and the teammate reads not checked since it began', async () => {
  const { relay, timers, lead, dev } = await crew();
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.size === 1);
  const person = () => lead.view().people.find((p) => p.id === dev.meId);
  assert.equal(person().live, true);
  assert.equal(person().notCheckedSince, null);
  await timers.advance(MIN);
  const failedAt = relay.now();
  dev.health(false);
  dev.health(false);
  await timers.advance(10000);
  await until(() => person().live === false, 'the failing health at the lead');
  assert.equal(person().notCheckedSince, failedAt);
  assert.ok(person().summary.tickets.length, 'the last tickets stay, marked not checked');
  dev.board(boardNow(relay.now()));
  await timers.advance(10000);
  await until(() => person().live === true, 'live again once a read works');
  lead.stop(); dev.stop();
});

test('a teammate the relay saw go reads not checked since the relay\'s time, whatever the clocks say', async () => {
  const { relay, lead, dev } = await crew();
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.size === 1);
  const person = () => lead.view().people.find((p) => p.id === dev.meId);
  lead.now = () => relay.now() - 20 * MIN;  // the lead's clock is behind: it does not matter
  assert.equal(person().live, true);
  lead.takePresence({ m: dev.meId, on: false, at: 1234 });
  assert.equal(person().live, false);
  assert.equal(person().notCheckedSince, 1234);
  lead.takePresence({ m: dev.meId, on: false });
  assert.equal(person().notCheckedSince, 1234, 'a going without a time keeps the last one known');
  lead.takePresence({ m: dev.meId, on: true });
  assert.equal(person().notCheckedSince, null);
  lead.takeHelloPresence({ online: [], seen: { [dev.meId]: 999 } });
  assert.equal(person().notCheckedSince, 999);
  lead.stop(); dev.stop();
});

test('while this Mac is offline, a teammate last seen online reads not checked since this Mac lost the relay', async () => {
  const { relay, net, lead, dev } = await crew();
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.size === 1);
  const lostAt = relay.now();
  net.down = true;
  net.drop();
  await until(() => lead.link !== 'online', 'the lead offline');
  const p = lead.view().people.find((x) => x.id === dev.meId);
  assert.equal(p.live, false);
  assert.equal(p.notCheckedSince, lostAt);
  lead.stop(); dev.stop();
});

test('a member on a roster the relay has not confirmed is still owed a welcome', async () => {
  const { lead, dev } = await crew();
  const ghost = 'BBBBBBBBBBBBBBBBBBBBBB';
  const me = await lead.member();
  lead.state.unsent = await signRoster(me, { team: lead.state.team, ver: lead.roster.ver + 1, lead: me.id, at: 0, members: [{ id: me.id, sign: me.signPub, dh: me.dhPub }, { id: ghost, sign: me.signPub, dh: me.dhPub }], detail: 'x' });
  lead.state.welcomes = [ghost];
  const left = await lead.sendWelcomes();
  assert.deepEqual(left, [ghost]);
  delete lead.state.unsent;
  assert.deepEqual(await lead.sendWelcomes(), []);
  lead.stop(); dev.stop();
});

test('a key ask that does not reach the disk is not acked, so the relay keeps it', async () => {
  const { lead, dev } = await crew();
  const me = await dev.member();
  const leadDh = lead.people.get(lead.meId).dh;
  const blob = await sealTo(me, leadDh, { k: 'key', at: 1 }, aad.rekey(lead.state.team, me.id, lead.meId));
  const done = [];
  const say = lead.say.bind(lead);
  lead.say = async (msg) => { if (msg.t === 'done') done.push(msg.item); return say(msg); };
  const saveFn = lead.saveFn;
  lead.saveFn = async () => { throw new Error('disk full'); };
  await lead.take({ item: 'k1', from: dev.meId, blob });
  assert.deepEqual(done, []);
  lead.saveFn = saveFn;
  await lead.take({ item: 'k1', from: dev.meId, blob });
  assert.deepEqual(done, ['k1']);
  lead.stop(); dev.stop();
});

test('a board failure reported before the roster loads still goes out once the team is up', async () => {
  const { relay, net, timers, lead, dev } = await crew();
  dev.board(boardNow(relay.now()));
  await until(() => lead.summaries.get(dev.meId)?.body.health?.ok === true, 'the healthy summary');
  dev.stop();
  await until(() => !lead.online.has(dev.meId), 'the dev offline');
  const again = new Team({ state: structuredClone(dev.state), net, now: () => relay.now(), timers, random: () => 1 });
  const failedAt = relay.now();
  again.health(false);
  again.start();
  await until(() => again.link === 'online', 'the dev back');
  await timers.advance(10000);
  await until(() => lead.summaries.get(dev.meId)?.body.health?.ok === false, 'the failing health at the lead');
  const p = lead.view().people.find((x) => x.id === dev.meId);
  assert.equal(p.live, false);
  assert.equal(p.notCheckedSince, failedAt);
  lead.stop(); again.stop();
});

test('after a clock is set right, fresh actions keep running: a saved high time does not expire their ids', async () => {
  const { relay, lead, dev, ran, setBoard } = await crew();
  const me = await lead.member();
  const key = await teamKey(lead.state.key);
  const seal1 = (nonce, at) => sealSigned(key, me, { k: 'act', nonce, at, action: { kind: 'reply', thread: 'th-parser', note: 'n' } }, aad.send(lead.state.team, me.id, dev.meId));
  dev.state.clockHigh = relay.now() + 86400000; // from a clock that ran a day fast, now set right
  setBoard({ board: boardNow(relay.now()), ok: true, at: relay.now() });
  await dev.take({ item: 'c1', from: me.id, blob: await seal1('CCCCCCCCCCCCCCCCCCCCC1', relay.now()) });
  relay.tick(1000);
  setBoard({ board: boardNow(relay.now()), ok: true, at: relay.now() });
  await dev.take({ item: 'c2', from: me.id, blob: await seal1('CCCCCCCCCCCCCCCCCCCCC2', relay.now()) });
  relay.tick(1000);
  setBoard({ board: boardNow(relay.now()), ok: true, at: relay.now() });
  await dev.take({ item: 'c3', from: me.id, blob: await seal1('CCCCCCCCCCCCCCCCCCCCC3', relay.now()) });
  assert.equal(ran.length, 3);
  lead.stop(); dev.stop();
});
