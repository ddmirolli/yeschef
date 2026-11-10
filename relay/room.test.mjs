import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeRelay } from './fake.mjs';
import { settings, usagePage } from './room.mjs';
import {
  newId, newMember, authToken, signRoster, newTeamKey, teamKey, seal, sealSigned, openSigned, sealTo, openFrom, aad,
  newInvite, readInvite, joinRequest, openJoin,
} from '../client/seal.mjs';

const MIN = 60000, DAY = 86400000;

/** A team on a fake relay: the lead, the team key, roster v1, and helpers to sign rosters and open sockets. */
async function team(env = {}) {
  const relay = fakeRelay({ env });
  const id = newId();
  const lead = await newMember();
  const raw = newTeamKey(), key = await teamKey(raw);
  const people = new Map([[lead.id, { m: lead, name: 'Sam Lead', role: 'lead' }]]);
  let ver = 0;
  const rosterNow = async (v = ver + 1) => {
    const members = [...people.values()].map((p) => ({ id: p.m.id, sign: p.m.signPub, dh: p.m.dhPub, ...(p.invite ? { invite: true } : {}) }));
    const detail = await seal(key, Object.fromEntries([...people.values()].map((p) => [p.m.id, { name: p.name, role: p.role }])), aad.detail(id, v));
    return signRoster(lead, { team: id, ver: v, lead: lead.id, at: relay.now(), members, detail });
  };
  const created = await relay.http('POST', `/v1/teams/${id}`, { roster: await rosterNow(1) });
  assert.equal(created.status, 201);
  ver = 1;
  const ws = async (m) => relay.connect(`/v1/teams/${id}/ws?auth=${await authToken(m, { team: id, method: 'GET', path: `/v1/teams/${id}/ws`, now: relay.now() })}`);
  const t = {
    relay, id, lead, key, raw, people,
    rosterNow,
    ws,
    /** The lead's new roster, sent over the lead's socket. */
    async push(leadWs, v = ver + 1) { const r = await leadWs.say({ t: 'roster', id: 'r', roster: await rosterNow(v) }); if (r.t === 'ok') ver = r.ver; return r; },
    /** An invite from the lead's socket. */
    async invite(leadWs, days = 7) {
      const inv = await newInvite({ relay: 'https://relay.test', team: id, lead, now: relay.now(), days });
      const box = await seal(key, { secret: inv.secret }, aad.invite(id, inv.record.invite));
      const r = await leadWs.say({ t: 'invite', id: 'i', invite: inv.record.invite, verifier: inv.record.verifier, until: inv.record.until, box });
      return { ...inv, reply: r, parsed: readInvite(inv.link) };
    },
    /** A dev asks to join on an invite. */
    async join(inv, name = 'Ada Lovelace') {
      const dev = await newMember();
      const res = await relay.http('POST', `/v1/teams/${id}/join`, await joinRequest(inv.parsed, dev, { name }));
      return { dev, res };
    },
    /** The lead lets a dev in: a new roster, then the team key sealed to the dev. */
    async approve(leadWs, dev, name = 'Ada Lovelace', role = 'engineer') {
      people.set(dev.id, { m: dev, name, role });
      const r = await t.push(leadWs);
      const blob = await sealTo(lead, dev.dhPub, { teamKey: raw }, aad.welcome(id, lead.id, dev.id));
      const s = await leadWs.say({ t: 'send', id: 'w', to: dev.id, blob, ttl: 7 * DAY });
      return { r, s };
    },
  };
  return t;
}

const dump = (relay) => JSON.stringify(['team', 'summary', 'invite', 'pending', 'inbox'].map((n) => relay.sql.exec(`SELECT * FROM ${n}`).toArray()));

test('a team is made once, with its lead\'s first roster', async () => {
  const t = await team();
  assert.equal(t.relay.created.length, 1);
  assert.equal(t.relay.created[0][0], t.id);
  assert.equal((await t.relay.http('POST', `/v1/teams/${t.id}`, { roster: await t.rosterNow(1) })).status, 409);
  const other = newId();
  const bad = await t.relay.http('POST', `/v1/teams/${other}`, { roster: await t.rosterNow(1) });
  assert.equal(bad.status, 500, 'one room holds one team: the Worker routes each team id to its own object');
});

test('a team the registry did not take is undone, so a retry makes it again', async () => {
  let down = true;
  const relay = fakeRelay({ register: async () => { if (down) throw new Error('registry down'); } });
  const id = newId();
  const lead = await newMember();
  const roster = await signRoster(lead, { team: id, ver: 1, lead: lead.id, at: relay.now(), members: [{ id: lead.id, sign: lead.signPub, dh: lead.dhPub }] });
  assert.equal((await relay.http('POST', `/v1/teams/${id}`, { roster })).status, 500);
  assert.equal(relay.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().length, 0, 'nothing left behind');
  down = false;
  assert.equal((await relay.http('POST', `/v1/teams/${id}`, { roster })).status, 201);
  assert.deepEqual(relay.created.map((c) => c[0]), [id]);
});

test('a stray team id gets a 404 and leaves no tables behind', async () => {
  const relay = fakeRelay();
  const id = newId();
  assert.equal((await relay.http('POST', `/v1/teams/${id}/join`, {})).status, 404);
  assert.equal((await relay.connect(`/v1/teams/${id}/ws?auth=x`)).status, 404);
  assert.equal((await relay.http('GET', '/v1/other')).status, 404);
  assert.equal(relay.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().length, 0);
  // A first roster that is not ver 1, or not signed, makes nothing.
  const lead = await newMember();
  const v2 = await signRoster(lead, { team: id, ver: 2, lead: lead.id, members: [{ id: lead.id, sign: lead.signPub, dh: lead.dhPub }] });
  assert.equal((await relay.http('POST', `/v1/teams/${id}`, { roster: v2 })).status, 400);
  assert.equal((await relay.http('POST', `/v1/teams/${id}`, { roster: { body: '{}', sig: 'x' } })).status, 400);
  assert.equal(relay.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().length, 0);
});

test('invite, ask, approve, welcome: the dev gets the team key and the relay never reads a name', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const hello = lws.last('hello');
  assert.equal(hello.role, 'member');
  assert.equal(hello.ver, 1);
  assert.deepEqual(hello.online, [t.lead.id]);

  const inv = await t.invite(lws);
  assert.equal(inv.reply.t, 'ok');
  const { dev, res } = await t.join(inv);
  assert.equal(res.status, 202);
  assert.equal(res.body.m, dev.id);
  // The lead hears the ask and reads the name with the invite's secret, which the lead keeps sealed on the relay.
  const p = lws.last('pending').pending;
  const { secret } = await (await import('../client/seal.mjs')).open(t.key, (await t.ws(t.lead)).last('hello').invites[0].box, aad.invite(t.id, inv.record.invite));
  assert.deepEqual(await openJoin(secret, { team: t.id, ...p }), { name: 'Ada Lovelace' });

  // The dev waits on a pending socket and cannot speak yet.
  const dws = await t.ws(dev);
  assert.equal(dws.last('hello').role, 'pending');
  assert.equal((await dws.say({ t: 'summary', id: 1, blob: 'a.b' })).code, 'wait');

  const { r, s } = await t.approve(lws, dev);
  assert.equal(r.t, 'ok');
  assert.equal(s.t, 'ok');
  assert.equal(dws.closed.code, 4001, 'the pending socket closes so the dev reconnects as a member');
  const dws2 = await t.ws(dev);
  const dh = dws2.last('hello');
  assert.equal(dh.role, 'member');
  assert.equal(dh.ver, 2);
  assert.equal(dh.inbox.length, 1);
  assert.deepEqual(await openFrom(dev, t.lead.dhPub, dh.inbox[0].blob, aad.welcome(t.id, t.lead.id, dev.id)), { teamKey: t.raw });
  assert.deepEqual(dh.pending, [], 'an engineer does not see asks to join');
  assert.equal((await dws2.say({ t: 'done', id: 2, item: dh.inbox[0].item })).t, 'ok');
  assert.equal((await t.ws(dev)).last('hello').inbox.length, 0);
  assert.ok(lws.heard.some((x) => x.t === 'pending-gone' && x.m === dev.id));

  // Nothing the relay stored spells the name or the team key.
  const stored = dump(t.relay);
  assert.doesNotMatch(stored, /Ada|Lovelace|Sam Lead|engineer/);
  assert.ok(!stored.includes(t.raw));
  assert.ok(!stored.includes(inv.secret));
});

test('a wrong proof, an ended invite and a revoked invite all refuse the ask', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const inv = await t.invite(lws, 1);
  const dev = await newMember();
  const ask = await joinRequest(inv.parsed, dev, { name: 'x' });
  assert.equal((await t.relay.http('POST', `/v1/teams/${t.id}/join`, { ...ask, proof: (ask.proof[0] === 'A' ? 'B' : 'A') + ask.proof.slice(1) })).status, 403);
  assert.equal((await t.relay.http('POST', `/v1/teams/${t.id}/join`, { ...ask, sign: 'short' })).status, 400);
  // A dev's signing key with someone else's key agreement key: the signature does not hold.
  assert.equal((await t.relay.http('POST', `/v1/teams/${t.id}/join`, { ...ask, dh: (await newMember()).dhPub })).status, 403);
  assert.equal((await t.relay.http('POST', `/v1/teams/${t.id}/join`, { ...ask, sig: undefined })).status, 400);
  assert.equal((await t.relay.http('POST', `/v1/teams/${t.id}/join`, ask)).status, 202);
  // A pending socket hears the revoke and closes.
  const dws = await t.ws(dev);
  assert.equal((await lws.say({ t: 'revoke', id: 1, invite: inv.record.invite })).t, 'ok');
  assert.equal(dws.last('declined').text, 'The invite was revoked.');
  assert.equal(dws.closed.code, 4002);
  assert.equal((await t.relay.http('POST', `/v1/teams/${t.id}/join`, ask)).status, 410);
  // An invite ends after its days.
  const inv2 = await t.invite(lws, 1);
  t.relay.tick(DAY + 1);
  assert.equal((await t.relay.http('POST', `/v1/teams/${t.id}/join`, await joinRequest(inv2.parsed, dev, { name: 'x' }))).status, 410);
  // An invite longer than 7 days is refused.
  const long = await newInvite({ relay: 'https://relay.test', team: t.id, lead: t.lead, now: t.relay.now(), days: 8 });
  assert.equal((await lws.say({ t: 'invite', id: 'x', invite: long.record.invite, verifier: long.record.verifier, until: long.record.until, box: 'a.b' })).code, 'bad');
});

test('only the lead answers asks and changes the roster; an engineer cannot invite', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const inv = await t.invite(lws);
  const { dev } = await t.join(inv);
  await t.approve(lws, dev);
  const dws = await t.ws(dev);
  assert.equal((await dws.say({ t: 'decline', id: 1, m: dev.id })).code, 'role');
  assert.equal((await dws.say({ t: 'invite', id: 1, invite: newId(), verifier: 'a'.repeat(43), until: t.relay.now() + MIN, box: 'a.b' })).code, 'role');
  // The dev signs a roster that makes the dev lead: refused by role, and by signature.
  const forged = await signRoster(dev, { team: t.id, ver: 3, lead: dev.id, members: [{ id: dev.id, sign: dev.signPub, dh: dev.dhPub }] });
  assert.equal((await dws.say({ t: 'roster', id: 1, roster: forged })).code, 'role');
  assert.equal((await lws.say({ t: 'roster', id: 1, roster: forged })).code, 'bad');
  // A stale version is refused, with the current one.
  const stale = await lws.say({ t: 'roster', id: 1, roster: await t.rosterNow(2) });
  assert.equal(stale.code, 'stale');
  assert.equal(stale.ver, 2);
  // The lead declines an ask.
  const second = await t.join(inv, 'Grace');
  const sws = await t.ws(second.dev);
  assert.equal((await lws.say({ t: 'decline', id: 1, m: second.dev.id })).t, 'ok');
  assert.equal(sws.closed.code, 4002);
  assert.equal(t.relay.sql.exec('SELECT COUNT(*) AS n FROM pending').toArray()[0].n, 0);
});

test('a deputy with the invite flag can invite, and sees asks', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const { dev } = await t.join(await t.invite(lws));
  await t.approve(lws, dev, 'Dee', 'deputy');
  t.people.get(dev.id).invite = true;
  assert.equal((await t.push(lws)).t, 'ok');
  const dws = await t.ws(dev);
  const inv = await newInvite({ relay: 'https://relay.test', team: t.id, lead: t.lead, now: t.relay.now() });
  assert.equal((await dws.say({ t: 'invite', id: 'i', invite: inv.record.invite, verifier: inv.record.verifier, until: inv.record.until, box: 'a.b' })).t, 'ok');
  assert.ok(lws.heard.some((x) => x.t === 'invite' && x.invite.by === dev.id));
  await t.relay.http('POST', `/v1/teams/${t.id}/join`, await joinRequest(readInvite(inv.link), await newMember(), { name: 'n' }));
  assert.ok(dws.last('pending'));
  assert.ok(lws.last('pending'));
});

test('summaries: the latest one per member, at most one per 10 s, and others hear each one', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const { dev } = await t.join(await t.invite(lws));
  await t.approve(lws, dev);
  const dws = await t.ws(dev);
  const where = aad.summary(t.id, dev.id);
  const first = await sealSigned(t.key, dev, { threads: [{ title: 'Parser rewrite', stage: 'In progress' }] }, where);
  assert.equal((await dws.say({ t: 'summary', id: 1, blob: first })).t, 'ok');
  const heard = lws.last('summary');
  assert.equal(heard.m, dev.id);
  assert.deepEqual(await openSigned(t.key, heard.blob, where, dev.signPub), { threads: [{ title: 'Parser rewrite', stage: 'In progress' }] });
  t.relay.tick(4000);
  const slow = await dws.say({ t: 'summary', id: 2, blob: first });
  assert.equal(slow.code, 'slow');
  assert.equal(slow.retryAfter, 6000);
  t.relay.tick(6000);
  const second = await sealSigned(t.key, dev, { threads: [] }, where);
  assert.equal((await dws.say({ t: 'summary', id: 3, blob: second })).t, 'ok');
  const rows = t.relay.sql.exec('SELECT m, blob FROM summary').toArray();
  assert.equal(rows.length, 1, 'one row per member: no history');
  assert.equal(rows[0].blob, second);
  assert.doesNotMatch(dump(t.relay), /Parser/);
  // Too large, or not a sealed blob.
  t.relay.tick(10000);
  assert.equal((await dws.say({ t: 'summary', id: 4, blob: 'a.' + 'b'.repeat(66000) })).code, 'bad');
  assert.equal((await dws.say({ t: 'summary', id: 5, blob: 'plain text' })).code, 'bad');
  // A new member's hello carries the latest summary of each member.
  assert.equal((await t.ws(t.lead)).last('hello').summaries.length, 1);
  // Forget: the dev stops sharing; the relay drops the summary, keeps only its time, and others hear it.
  assert.equal((await dws.say({ t: 'forget', id: 6 })).t, 'ok');
  assert.equal(lws.last('gone').m, dev.id);
  assert.equal(t.relay.sql.exec('SELECT COUNT(*) AS n FROM summary WHERE blob IS NOT NULL').toArray()[0].n, 0);
  assert.doesNotMatch(dump(t.relay), new RegExp(second.split('.')[1].slice(0, 20)));
  assert.equal((await t.ws(t.lead)).last('hello').summaries.length, 0);
  // Summary and forget share one limit: alternating them does not get around it (PR-Agent r1 on #78).
  assert.equal((await dws.say({ t: 'summary', id: 7, blob: second })).code, 'slow');
  t.relay.tick(10000);
  assert.equal((await dws.say({ t: 'summary', id: 8, blob: second })).t, 'ok');
  assert.equal((await dws.say({ t: 'forget', id: 9 })).code, 'slow');
  // A forget with nothing shared writes nothing.
  t.relay.tick(10000);
  assert.equal((await dws.say({ t: 'forget', id: 10 })).t, 'ok');
  assert.equal((await dws.say({ t: 'forget', id: 11 })).t, 'ok');
});

test('sealed messages reach only their member, wait while they are away, and end after their time', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const { dev } = await t.join(await t.invite(lws));
  await t.approve(lws, dev);
  const where = aad.send(t.id, t.lead.id, dev.id);
  const blob = await sealSigned(t.key, t.lead, { kind: 'go', thread: 't1', nonce: 'n1' }, where);
  // The dev is away: the message waits.
  const sent = await lws.say({ t: 'send', id: 1, to: dev.id, blob });
  assert.equal(sent.t, 'ok');
  const dws = await t.ws(dev);
  const items = dws.last('hello').inbox;
  assert.equal(items.length, 2, 'the welcome and the action');
  const action = items.find((x) => x.item === sent.item);
  assert.equal(action.from, t.lead.id);
  assert.deepEqual(await openSigned(t.key, action.blob, aad.send(t.id, action.from, dev.id), t.lead.signPub), { kind: 'go', thread: 't1', nonce: 'n1' });
  // Online: it arrives at once.
  await lws.say({ t: 'send', id: 2, to: dev.id, blob });
  assert.equal(dws.last('inbox').from, t.lead.id);
  // Another member cannot take the dev's item.
  assert.equal((await lws.say({ t: 'done', id: 3, item: sent.item })).t, 'ok');
  assert.equal(t.relay.sql.exec('SELECT COUNT(*) AS n FROM inbox WHERE item = ?', sent.item).toArray()[0].n, 1);
  // Not a member, or to oneself.
  assert.equal((await lws.say({ t: 'send', id: 4, to: newId(), blob })).code, 'bad');
  assert.equal((await lws.say({ t: 'send', id: 5, to: t.lead.id, blob })).code, 'bad');
  // Unread items end after their time (15 minutes by default), and the next hello prunes them.
  t.relay.tick(16 * MIN);
  const left = (await t.ws(dev)).last('hello').inbox;
  assert.equal(left.length, 1, 'only the welcome, which lasts 7 days');
});

test('a member\'s inbox holds 100 items at most', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const { dev } = await t.join(await t.invite(lws));
  await t.approve(lws, dev);
  for (let i = 0; i < 99; i++) assert.equal((await lws.say({ t: 'send', id: i, to: dev.id, blob: 'a.b' })).t, 'ok');
  assert.equal((await lws.say({ t: 'send', id: 'x', to: dev.id, blob: 'a.b' })).code, 'full');
});

test('removing a member closes their sockets and drops their summary and inbox', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const { dev } = await t.join(await t.invite(lws));
  await t.approve(lws, dev);
  const dws = await t.ws(dev);
  await dws.say({ t: 'summary', id: 1, blob: 'a.b' });
  t.people.delete(dev.id);
  assert.equal((await t.push(lws)).t, 'ok');
  assert.equal(dws.closed.code, 4003);
  assert.equal(t.relay.sql.exec('SELECT COUNT(*) AS n FROM summary').toArray()[0].n, 0);
  assert.equal(t.relay.sql.exec('SELECT COUNT(*) AS n FROM inbox').toArray()[0].n, 0);
  assert.equal((await t.ws(dev)).status, 401);
});

test('presence: others hear a member come online and go offline', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const { dev } = await t.join(await t.invite(lws));
  await t.approve(lws, dev);
  const a = await t.ws(dev);
  assert.deepEqual(lws.last('presence'), { t: 'presence', m: dev.id, on: true });
  const b = await t.ws(dev);
  lws.drain();
  t.relay.close(a);
  assert.equal(lws.last('presence'), null, 'a second socket is still open');
  t.relay.close(b);
  assert.deepEqual(lws.last('presence'), { t: 'presence', m: dev.id, on: false });
});

test('a fifth socket for one member closes the oldest', async () => {
  const t = await team();
  const socks = [];
  for (let i = 0; i < 5; i++) socks.push(await t.ws(t.lead));
  assert.equal(socks[0].closed.code, 4005);
  assert.equal(socks.filter((s) => !s.closed).length, 4);
});

test('a socket needs a fresh token for this team and path', async () => {
  const t = await team();
  const old = await authToken(t.lead, { team: t.id, method: 'GET', path: `/v1/teams/${t.id}/ws`, now: t.relay.now() - 6 * MIN });
  assert.equal((await t.relay.connect(`/v1/teams/${t.id}/ws?auth=${old}`)).status, 401);
  const wrongPath = await authToken(t.lead, { team: t.id, method: 'GET', path: `/v1/teams/${t.id}`, now: t.relay.now() });
  assert.equal((await t.relay.connect(`/v1/teams/${t.id}/ws?auth=${wrongPath}`)).status, 401);
  const res = await t.relay.room.fetch(new Request(`${t.relay.base}/v1/teams/${t.id}/ws?auth=${old}`));
  assert.equal(res.status, 426);
});

test('the caps: empty is off; MAX_DEVS bounds a team; MAX_DAILY_REQUESTS bounds a day', async () => {
  assert.equal(settings({}).maxDevs, 0);
  assert.equal(settings({ MAX_DEVS: '' }).maxDevs, 0);
  assert.equal(settings({ MAX_DAILY_REQUESTS: '' }).maxDaily, 0);
  assert.equal(settings({ SUMMARY_MIN_MS: '2500' }).summaryMs, 2500);

  const t = await team({ MAX_DEVS: '2' });
  const lws = await t.ws(t.lead);
  const inv = await t.invite(lws);
  assert.equal((await t.join(inv)).res.status, 202);
  const third = await t.join(inv);
  assert.equal(third.res.status, 403);
  assert.match(third.res.body.error, /up to 2 people/);

  const d = await team({ MAX_DAILY_REQUESTS: '5' });
  // So far today: the create (1). Open a socket (2), then messages (3, 4, 5).
  const dl = await d.ws(d.lead);
  for (let i = 0; i < 3; i++) assert.notEqual((await dl.say({ t: 'forget', id: i })).code, 'cap');
  // The capped reply carries the request's id, so the app stops waiting on it (PR-Agent r3 on #78).
  const capped = await dl.say({ t: 'forget', id: 9 });
  assert.equal(capped.code, 'cap');
  assert.equal(capped.id, 9);
  assert.equal((await d.ws(d.lead)).status, 429);
  d.relay.tick(DAY);
  assert.equal((await dl.say({ t: 'forget', id: 10 })).t, 'ok', 'a new UTC day starts the count again');
});

test('strangers cannot spend a team\'s cap or make the relay write: refused traffic is counted in memory', async () => {
  const t = await team({ MAX_DAILY_REQUESTS: '5' });
  const before = t.relay.sql.exec('SELECT requests, refused FROM usage').one();
  const writes = () => t.relay.sql.exec('SELECT COUNT(*) AS n FROM usage').one().n + t.relay.sql.exec('SELECT requests + messages + refused AS n FROM usage').one().n;
  const w0 = writes();
  // Someone who knows the team id: bad tokens, stray paths, junk joins, a huge body.
  for (let i = 0; i < 20; i++) {
    assert.equal((await t.relay.connect(`/v1/teams/${t.id}/ws?auth=junk${i}`)).status, 401);
    assert.equal((await t.relay.http('POST', `/v1/teams/${t.id}/join`, { invite: newId() })).status, 400);
    assert.equal((await t.relay.http('GET', `/v1/teams/${t.id}/nothing`)).status, 404);
  }
  assert.equal(writes(), w0, 'nothing written for refused requests');
  // The lead still gets in, and the refused ones are recorded with that real write.
  const lws = await t.ws(t.lead);
  assert.equal(lws.status, undefined);
  const after = t.relay.sql.exec('SELECT requests, refused FROM usage').one();
  assert.equal(after.requests, before.requests + 1);
  assert.equal(after.refused, 60);
  // Over the cap, the lead can still delete the team. /me is capped too, and writes nothing more (PR-Agent r2 on #78).
  for (let i = 0; i < 5; i++) await lws.say({ t: 'forget', id: i });
  assert.equal((await t.ws(t.lead)).status, 429);
  const mePath = `/v1/teams/${t.id}/me`;
  const capped = writes();
  for (let i = 0; i < 5; i++) {
    const tok = await authToken(t.lead, { team: t.id, method: 'GET', path: mePath, now: t.relay.now() });
    assert.equal((await t.relay.http('GET', mePath, undefined, { authorization: `YesChef ${tok}` })).status, 429);
  }
  assert.equal(writes(), capped);
  const del = await authToken(t.lead, { team: t.id, method: 'DELETE', path: `/v1/teams/${t.id}`, now: t.relay.now() });
  assert.equal((await t.relay.http('DELETE', `/v1/teams/${t.id}`, undefined, { authorization: `YesChef ${del}` })).status, 200);
});

test('a frame past the largest real message closes the socket before it is parsed', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const { dev } = await t.join(await t.invite(lws));
  const dws = await t.ws(dev);
  const usage = () => JSON.stringify(t.relay.sql.exec('SELECT requests, messages, rows_written FROM usage').toArray());
  const before = usage();
  const max = settings().frameMax;
  assert.equal(max, 65536 + 4096);
  // A dev still waiting sends a frame of junk past the limit: it is never parsed, and their socket closes.
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = (...a) => { parsed++; return parse(...a); };
  try { await t.relay.room.message(dws, '[' + '0,'.repeat(max / 2) + '0]'); } finally { JSON.parse = parse; }
  assert.equal(parsed, 0, 'not parsed');
  assert.equal(dws.closed.code, 1009);
  assert.equal(usage(), before, 'refused: no write, no cap spent');
  // A member's frame at the limit is still read.
  await t.relay.room.message(lws, JSON.stringify({ t: 'forget', id: 'f', pad: 'x'.repeat(max - 60) }));
  assert.deepEqual(lws.heard.at(-1), { id: 'f', t: 'ok' });
  assert.equal(lws.closed, null);
});

test('a body over 64 KiB is refused as it streams in, before it is all read', async () => {
  const t = await team();
  const big = JSON.stringify({ invite: 'x'.repeat(70000) });
  assert.equal((await t.relay.http('POST', `/v1/teams/${t.id}/join`, big)).status, 413);
  // A body that says nothing of its length is cut off at the limit too.
  let pulled = 0;
  const stream = new ReadableStream({ pull(c) { pulled++; if (pulled > 100) { c.close(); return; } c.enqueue(new Uint8Array(16384)); } });
  const res = await t.relay.room.fetch(new Request(`${t.relay.base}/v1/teams/${t.id}/join`, { method: 'POST', body: stream, duplex: 'half' }));
  assert.equal(res.status, 413);
  assert.ok(pulled <= 6, `read ${pulled} chunks`);
});

test('expired messages free their place, and the alarm drops what expired while the team is idle', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const { dev } = await t.join(await t.invite(lws));
  await t.approve(lws, dev);
  for (let i = 0; i < 99; i++) assert.equal((await lws.say({ t: 'send', id: i, to: dev.id, blob: 'a.b', ttl: MIN })).t, 'ok');
  assert.equal((await lws.say({ t: 'send', id: 'f', to: dev.id, blob: 'a.b', ttl: MIN })).code, 'full');
  t.relay.tick(2 * MIN);
  // Nobody connected since: the old ones no longer hold a place.
  assert.equal((await lws.say({ t: 'send', id: 'g', to: dev.id, blob: 'a.b', ttl: MIN })).t, 'ok');
  assert.ok(t.relay.alarms.length > 0);
  // The team goes quiet. The alarm fires after the last message's time and takes it.
  t.relay.tick(2 * MIN);
  const next = await t.relay.room.alarm();
  // Only the lead's welcome is left: it lasts 7 days.
  assert.deepEqual(t.relay.sql.exec('SELECT from_m FROM inbox').toArray().map((r) => r.from_m), [t.lead.id]);
  // The next alarm is the next thing to expire: the open invite or the welcome.
  const soonest = Math.min(t.relay.sql.exec('SELECT MIN(until) AS u FROM invite').one().u, t.relay.sql.exec('SELECT MIN(until) AS u FROM inbox').one().u);
  assert.equal(next, soonest);
  assert.equal(t.relay.alarms.at(-1), next + 1000);
  t.relay.tick(8 * DAY);
  // Invites and messages are gone. The usage counts are what is left (this alarm's own deletes are counted today),
  // and the alarm is set for when the oldest day of them ends.
  const oldest = t.relay.sql.exec('SELECT MIN(day) AS d FROM usage').one().d;
  assert.equal(oldest, '2026-11-10');
  const usageEnds = Date.parse(oldest) + 91 * DAY;
  assert.equal(await t.relay.room.alarm(), usageEnds);
  assert.equal(t.relay.sql.exec('SELECT (SELECT COUNT(*) FROM inbox) + (SELECT COUNT(*) FROM invite) AS n').one().n, 0);
  // Nobody comes back. At that alarm the counts go too, past the 90 days kept, and nothing is left to wake for
  // (PR-Agent r1 on public #6).
  t.relay.tick(usageEnds - t.relay.now() + 1000);
  const last = Date.parse(t.relay.sql.exec('SELECT MAX(day) AS d FROM usage').one().d) + 91 * DAY;
  await t.relay.room.alarm();
  t.relay.tick(last - t.relay.now() + 1000);
  assert.equal(await t.relay.room.alarm(), null);
  assert.equal(t.relay.sql.exec('SELECT COUNT(*) AS n FROM usage').one().n, 0);
});

test('an ask that ends with its invite tells the waiting dev and the inviters', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const { dev } = await t.join(await t.invite(lws, 1));
  const dws = await t.ws(dev);
  assert.equal(dws.last('hello').role, 'pending');
  // The team goes quiet. The invite's day passes, and the alarm takes the invite and the ask.
  t.relay.tick(DAY + 1);
  await t.relay.room.alarm();
  assert.equal(dws.last('declined').text, 'The invite has ended. Ask the lead for a new link.');
  assert.equal(dws.closed.code, 4002);
  assert.ok(lws.heard.some((x) => x.t === 'pending-gone' && x.m === dev.id));
  assert.equal(t.relay.sql.exec('SELECT COUNT(*) AS n FROM pending').one().n, 0);
});

test('a Mac whose socket keeps failing asks the relay what it knows of it', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const path = `/v1/teams/${t.id}/me`;
  const me = async (m, now = t.relay.now()) => t.relay.http('GET', path, undefined, { authorization: `YesChef ${await authToken(m, { team: t.id, method: 'GET', path, now })}` });
  assert.deepEqual((await me(t.lead)).body, { m: t.lead.id, role: 'member', now: t.relay.now() });
  const { dev } = await t.join(await t.invite(lws));
  assert.equal((await me(dev)).body.role, 'pending');
  // Declined: the relay no longer knows the key.
  await lws.say({ t: 'decline', id: 'd', m: dev.id });
  const gone = await me(dev);
  assert.equal(gone.status, 401);
  assert.equal(gone.body.now, t.relay.now());
  // A Mac clock ten minutes off: the 401 carries the relay's clock, so the app can tell.
  assert.equal((await me(t.lead, t.relay.now() - 10 * MIN)).status, 401);
  assert.equal((await fakeRelay().http('GET', `/v1/teams/${newId()}/me`)).status, 404);
});

test('usage: requests, messages, rows written and bytes per team per UTC day', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const { dev } = await t.join(await t.invite(lws));
  await t.approve(lws, dev);
  const dws = await t.ws(dev);
  await dws.say({ t: 'summary', id: 1, blob: 'a.b' });
  const u = t.relay.room.usage(7);
  assert.equal(u.team, t.id);
  assert.equal(u.members, 2);
  assert.equal(u.days.length, 1);
  const day = u.days[0];
  // Requests: create, lead socket, join, dev socket. Messages: invite, roster, send, summary.
  assert.equal(day.requests, 4);
  assert.equal(day.messages, 4);
  // Rows: team, invite, pending, roster update plus the pending delete, inbox, summary. The usage row's own writes are not in it.
  assert.equal(day.rows_written, 7);
  assert.ok(day.bytes_in > 1000);
  assert.equal(day.refused, 0);
  t.relay.tick(DAY);
  await lws.say({ t: 'forget', id: 2 });
  assert.equal(t.relay.room.usage(7).days.length, 2);
  assert.equal(t.relay.room.usage(1).days.length, 1);
});

test('a team whose delete stopped before the registry heard leaves the registry at the next usage read', async () => {
  // The registry as the Worker's object keeps it: ids in order, a page at a time.
  const ids = new Set(['a1', 'b2', 'c3']);
  const calls = [];
  const reg = {
    list: async (after, n) => [...ids].sort().filter((id) => id > after).slice(0, n),
    remove: async (gone) => { calls.push(gone); for (const id of [].concat(gone)) ids.delete(id); },
    count: async () => ids.size,
  };
  // b2's data went, but its registry row stayed (its delete failed after deleteAll).
  const usageOf = async (id, days) => (id === 'b2' ? null : { team: id, days: [], asked: days });
  const page = await usagePage(reg, usageOf, { days: 3 });
  assert.deepEqual(page.teams.map((u) => u.team), ['a1', 'c3']);
  assert.equal(page.teams[0].asked, 3);
  assert.deepEqual(calls, [['b2']], 'one registry call for every team that is gone');
  assert.equal(page.total, 2);
  assert.equal(page.next, null);
  // Paging: a full page names where the next one starts. Nothing is gone, so the registry is not called.
  const two = await usagePage(reg, usageOf, { page: 1 });
  assert.equal(two.next, 'a1');
  assert.deepEqual((await usagePage(reg, usageOf, { after: two.next, page: 1 })).teams.map((u) => u.team), ['c3']);
  assert.equal(calls.length, 1);
  // A deleted room reads as gone.
  const t = await team();
  const del = await authToken(t.lead, { team: t.id, method: 'DELETE', path: `/v1/teams/${t.id}`, now: t.relay.now() });
  assert.equal((await t.relay.http('DELETE', `/v1/teams/${t.id}`, undefined, { authorization: `YesChef ${del}` })).status, 200);
  assert.equal(t.relay.room.usage(7), null);
});

test('the lead deletes the team, and the relay keeps nothing of it', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const { dev } = await t.join(await t.invite(lws));
  await t.approve(lws, dev);
  const path = `/v1/teams/${t.id}`;
  const devTok = await authToken(dev, { team: t.id, method: 'DELETE', path, now: t.relay.now() });
  assert.equal((await t.relay.http('DELETE', path, undefined, { authorization: `YesChef ${devTok}` })).status, 403);
  const tok = await authToken(t.lead, { team: t.id, method: 'DELETE', path, now: t.relay.now() });
  assert.equal((await t.relay.http('DELETE', path, undefined, { authorization: `YesChef ${tok}` })).status, 200);
  assert.equal(lws.closed.code, 4004);
  assert.deepEqual(t.relay.deleted, [t.id]);
  assert.equal(t.relay.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().length, 0);
  assert.equal((await t.ws(t.lead)).status, 404);
});

test('a message the relay cannot read gets an error, not a crash', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  await t.relay.room.message(lws, 'not json');
  assert.equal(lws.last('err').code, 'bad');
  assert.equal((await lws.say({ t: 'whatever', id: 1 })).code, 'bad');
  assert.equal((await lws.say({ t: 'send', id: 2 })).code, 'bad');
});

test('a delete that fails halfway leaves the team answering, so the lead can try again', async () => {
  let fail = true;
  const relay = fakeRelay({ unregister: async () => { if (fail) throw new Error('storage busy'); } });
  const id = newId();
  const lead = await newMember();
  const roster = await signRoster(lead, { team: id, ver: 1, lead: lead.id, at: relay.now(), members: [{ id: lead.id, sign: lead.signPub, dh: lead.dhPub }] });
  assert.equal((await relay.http('POST', `/v1/teams/${id}`, { roster })).status, 201);
  const path = `/v1/teams/${id}`;
  const del = async () => relay.http('DELETE', path, undefined, { authorization: `YesChef ${await authToken(lead, { team: id, method: 'DELETE', path, now: relay.now() })}` });
  assert.equal((await del()).status, 500);
  // Still there: usage reads it, so /v1/usage keeps it in the registry, and the lead's retry is not a 404.
  assert.ok(relay.room.usage(7));
  fail = false;
  assert.equal((await del()).status, 200);
  assert.equal(relay.room.usage(7), null);
});

test('MAX_DEVS counts the asks still waiting when the lead adds someone else', async () => {
  const t = await team({ MAX_DEVS: '2' });
  const lws = await t.ws(t.lead);
  const inv = await t.invite(lws);
  assert.equal((await t.join(inv)).res.status, 202);
  // Two places: the lead and the waiting ask. A roster that adds someone who never asked would make three.
  const other = await newMember();
  t.people.set(other.id, { m: other, name: 'Bo', role: 'engineer' });
  const r = await t.push(lws);
  assert.equal(r.code, 'cap');
  assert.match(r.text, /asks still waiting/);
});

test('an invite id is taken once: the same invite again is fine, a different one under that id is refused', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const inv = await t.invite(lws);
  assert.equal(inv.reply.t, 'ok');
  const again = { t: 'invite', invite: inv.record.invite, verifier: inv.record.verifier, until: inv.record.until };
  const box = t.relay.sql.exec('SELECT box FROM invite').one().box;
  assert.equal((await lws.say({ ...again, id: 'a', box })).t, 'ok', 'a retry after a lost answer');
  const other = await newInvite({ relay: 'https://relay.test', team: t.id, lead: t.lead, now: t.relay.now() });
  const r = await lws.say({ ...again, id: 'b', verifier: other.record.verifier, box });
  assert.equal(r.code, 'bad');
  assert.equal(t.relay.sql.exec('SELECT verifier FROM invite').one().verifier, inv.record.verifier);
});

test('a revoke that lands while an ask is checked ends that ask: nothing waits on a revoked invite', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  const inv = await t.invite(lws);
  const dev = await newMember();
  const ask = await joinRequest(inv.parsed, dev, { name: 'x' });
  // The relay reads the invite, then waits on WebCrypto. Run the revoke in that wait.
  const room = t.relay.room;
  const proof = room.one.bind(room);
  let revoked = null;
  room.one = (q, ...a) => {
    const out = proof(q, ...a);
    if (!revoked && /SELECT verifier, until FROM invite/.test(q)) revoked = Promise.resolve().then(() => lws.say({ t: 'revoke', id: 'r', invite: inv.record.invite }));
    return out;
  };
  const res = await t.relay.http('POST', `/v1/teams/${t.id}/join`, ask);
  assert.equal((await revoked).t, 'ok');
  assert.equal(res.status, 410);
  assert.equal(t.relay.sql.exec('SELECT COUNT(*) AS n FROM pending').one().n, 0);
});

test('a new team\'s first counts arm the alarm, so they end after 90 days with no invite or message', async () => {
  const t = await team();
  const day = t.relay.sql.exec('SELECT MIN(day) AS d FROM usage').one().d;
  assert.ok(day, 'the create wrote a usage row');
  assert.equal(t.relay.alarms.at(-1), Date.parse(day + 'T00:00:00Z') + 91 * DAY + 1000);
});

test('the same invite sent again with the invites full is still taken once', async () => {
  const t = await team();
  const lws = await t.ws(t.lead);
  let last = null;
  for (let i = 0; i < 20; i++) last = await t.invite(lws);
  assert.equal(last.reply.t, 'ok');
  const box = t.relay.sql.exec('SELECT box FROM invite WHERE id = ?', last.record.invite).one().box;
  const r = await lws.say({ t: 'invite', id: 'again', invite: last.record.invite, verifier: last.record.verifier, until: last.record.until, box });
  assert.equal(r.t, 'ok');
  assert.equal((await t.invite(lws)).reply.code, 'full');
});
