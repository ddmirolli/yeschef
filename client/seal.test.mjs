import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64u, unb64u, newId, isId, memberId, newMember, saveMember, loadMember, sign, verify, authToken, checkAuth, AUTH_SKEW_MS,
  signRoster, readRoster, newTeamKey, teamKey, seal, open, aad, sealSigned, openSigned, sealTo, openFrom,
  newInvite, readInvite, joinRequest, openJoin, proofMatches,
} from './seal.mjs';

const T = 'AAAAAAAAAAAAAAAAAAAAAA';

test('base64url round-trips any bytes and refuses anything else', () => {
  const big = new Uint8Array(100000).map((_, i) => i % 256);
  assert.deepEqual(unb64u(b64u(big)), big);
  for (const n of [0, 1, 2, 3, 31, 32, 33]) assert.deepEqual(unb64u(b64u(new Uint8Array(n).fill(255))), new Uint8Array(n).fill(255));
  assert.throws(() => unb64u('a+b/'));
  assert.throws(() => unb64u('abcde'));
  assert.ok(isId(newId()));
  assert.equal(isId('short'), false);
});

test('a member is two key pairs; the id comes from the signing key; a saved member loads back and is checked', async () => {
  const m = await newMember();
  assert.ok(isId(m.id));
  assert.equal(m.id, await memberId(m.signPub));
  assert.equal(m.signPub.length, 87);
  const back = await loadMember(await saveMember(m));
  assert.equal(back.id, m.id);
  assert.ok(await verify(m.signPub, await sign(back, 'x'), 'x'));
  const bad = JSON.parse(await saveMember(m));
  bad.id = (await newMember()).id;
  await assert.rejects(loadMember(bad), /does not match/);
});

test('verify says false, never throws, for a wrong key, wrong text or garbage', async () => {
  const a = await newMember(), b = await newMember();
  const s = await sign(a, 'hello');
  assert.equal(await verify(a.signPub, s, 'hello'), true);
  assert.equal(await verify(a.signPub, s, 'hellO'), false);
  assert.equal(await verify(b.signPub, s, 'hello'), false);
  assert.equal(await verify('not-a-key', s, 'hello'), false);
  assert.equal(await verify(a.signPub, '!!', 'hello'), false);
});

test('an auth token holds for its team, method, path and five minutes only', async () => {
  const a = await newMember(), b = await newMember();
  const now = Date.UTC(2026, 10, 10, 12);
  const keys = new Map([[a.id, a.signPub], [b.id, b.signPub]]);
  const opts = { team: T, method: 'GET', path: `/v1/teams/${T}/ws`, signPubOf: (id) => keys.get(id) || null };
  const tok = await authToken(a, { ...opts, now });
  assert.equal(await checkAuth(tok, { ...opts, now }), a.id);
  assert.equal(await checkAuth(tok, { ...opts, now: now + AUTH_SKEW_MS + 1 }), null);
  assert.equal(await checkAuth(tok, { ...opts, now, path: `/v1/teams/${T}` }), null);
  assert.equal(await checkAuth(tok, { ...opts, now, method: 'DELETE' }), null);
  assert.equal(await checkAuth(tok, { ...opts, now, team: newId() }), null);
  assert.equal(await checkAuth(tok, { ...opts, now, signPubOf: () => null }), null);
  // A token that names a member but carries another member's key does not pass.
  assert.equal(await checkAuth(tok, { ...opts, now, signPubOf: () => b.signPub }), null);
  // Someone else's id on a's signature fails.
  const [, ts, sig] = tok.split('.');
  assert.equal(await checkAuth(`${b.id}.${ts}.${sig}`, { ...opts, now }), null);
  for (const junk of ['', 'a.b', `${a.id}.12.x`, `${tok}.extra`]) assert.equal(await checkAuth(junk, { ...opts, now }), null);
});

async function roster(lead, members, { ver = 1, team = T } = {}) {
  return signRoster(lead, { team, ver, lead: lead.id, at: 1, members: members.map((m) => ({ id: m.id, sign: m.signPub, dh: m.dhPub })), detail: 'x.y' });
}

test('a roster reads only when its lead signed it, and a pinned lead must match', async () => {
  const lead = await newMember(), dev = await newMember();
  const r = await roster(lead, [lead, dev]);
  const body = await readRoster(r, { team: T });
  assert.equal(body.members.length, 2);
  assert.ok(await readRoster(r, { team: T, leadSignPub: lead.signPub }));
  assert.equal(await readRoster(r, { team: T, leadSignPub: dev.signPub }), null);
  assert.equal(await readRoster(r, { team: newId() }), null);
  assert.equal(await readRoster({ ...r, body: r.body.replace('"ver":1', '"ver":2') }, { team: T }), null);
  // The dev signs a roster that names the dev as lead: it reads alone, but not against the pinned lead.
  const forged = await signRoster(dev, { team: T, ver: 2, lead: dev.id, members: [lead, dev].map((m) => ({ id: m.id, sign: m.signPub, dh: m.dhPub })) });
  assert.ok(await readRoster(forged, { team: T }));
  assert.equal(await readRoster(forged, { team: T, leadSignPub: lead.signPub }), null);
  // Signed by the dev but naming the real lead: the signature fails.
  const wrongSigner = await signRoster(dev, { team: T, ver: 2, lead: lead.id, members: [lead, dev].map((m) => ({ id: m.id, sign: m.signPub, dh: m.dhPub })) });
  assert.equal(await readRoster(wrongSigner, { team: T }), null);
  // A member whose id does not come from its key, or a repeated id, fails.
  const odd = await signRoster(lead, { team: T, ver: 1, lead: lead.id, members: [{ id: lead.id, sign: lead.signPub, dh: lead.dhPub }, { id: lead.id, sign: dev.signPub, dh: dev.dhPub }] });
  assert.equal(await readRoster(odd, { team: T }), null);
  assert.equal(await readRoster(null), null);
  assert.equal(await readRoster({ body: '{', sig: 'x' }), null);
});

test('a seal opens only with its key and in its place', async () => {
  const k = await teamKey(newTeamKey()), other = await teamKey(newTeamKey());
  const blob = await seal(k, { title: 'Fix the parser' }, aad.summary(T, 'a'));
  assert.deepEqual(await open(k, blob, aad.summary(T, 'a')), { title: 'Fix the parser' });
  assert.doesNotMatch(blob, /parser/);
  await assert.rejects(open(other, blob, aad.summary(T, 'a')));
  await assert.rejects(open(k, blob, aad.summary(T, 'b')));
  const [iv, ct] = blob.split('.');
  await assert.rejects(open(k, `${iv}.${ct[0] === 'A' ? 'B' : 'A'}${ct.slice(1)}`, aad.summary(T, 'a')));
  await assert.rejects(open(k, 'nonsense', aad.summary(T, 'a')));
});

test('a signed seal proves its sender even to members who hold the team key', async () => {
  const k = await teamKey(newTeamKey());
  const lead = await newMember(), dev = await newMember(), mallory = await newMember();
  const where = aad.send(T, lead.id, dev.id);
  const blob = await sealSigned(k, lead, { kind: 'go', thread: 't1' }, where);
  assert.deepEqual(await openSigned(k, blob, where, lead.signPub), { kind: 'go', thread: 't1' });
  // Mallory holds the team key and seals "from the lead": the seal opens, the signature does not hold.
  const forged = await sealSigned(k, mallory, { kind: 'go', thread: 't1' }, where);
  await assert.rejects(openSigned(k, forged, where, lead.signPub), /bad signature/);
  // The relay moves the lead's blob to another receiver: the seal fails.
  await assert.rejects(openSigned(k, blob, aad.send(T, lead.id, mallory.id), lead.signPub));
});

test('a seal to one member opens for that member and nobody else', async () => {
  const lead = await newMember(), dev = await newMember(), eve = await newMember();
  const where = aad.welcome(T, lead.id, dev.id);
  const blob = await sealTo(lead, dev.dhPub, { key: 'k' }, where);
  assert.deepEqual(await openFrom(dev, lead.dhPub, blob, where), { key: 'k' });
  await assert.rejects(openFrom(eve, lead.dhPub, blob, where));
  await assert.rejects(openFrom(dev, eve.dhPub, blob, where));
});

test('an invite keeps its secret after the #; the relay can check a join but not read it', async () => {
  const lead = await newMember(), dev = await newMember();
  const now = Date.UTC(2026, 10, 10, 12);
  const { link, record, secret } = await newInvite({ relay: 'https://relay.example.com', team: T, lead, leadName: 'Sam', teamName: 'Fernpay', now });
  const [before, frag] = link.split('#');
  assert.equal(before, 'https://yeschef.codes/join');
  assert.ok(!before.includes(secret));
  assert.equal(record.until, now + 7 * 86400000);
  const inv = readInvite(link);
  assert.equal(inv.team, T);
  assert.equal(inv.secret, secret);
  assert.equal(inv.leadSignPub, lead.signPub);
  assert.equal(inv.teamName, 'Fernpay');
  assert.deepEqual(readInvite(frag), inv);
  const ask = await joinRequest(inv, dev, { name: 'Ada Lovelace' });
  assert.ok(await proofMatches(ask.proof, record.verifier));
  // Change the first character: its 6 bits are all data (the last character's low bits are padding).
  assert.equal(await proofMatches((ask.proof[0] === 'A' ? 'B' : 'A') + ask.proof.slice(1), record.verifier), false);
  assert.doesNotMatch(JSON.stringify(ask), /Ada Lovelace|Lovelace/);
  assert.deepEqual(await openJoin(secret, { team: T, m: dev.id, ...ask }), { name: 'Ada Lovelace' });
  // The proof alone (all the relay ever sees) does not open the ask.
  await assert.rejects(openJoin(ask.proof, { team: T, m: dev.id, ...ask }));
  // The dev's signature binds the two keys: someone who swaps in their own key agreement key, or claims another id, fails.
  const eve = await newMember();
  await assert.rejects(openJoin(secret, { team: T, m: dev.id, ...ask, dh: eve.dhPub }), /bad signature/);
  await assert.rejects(openJoin(secret, { team: T, m: eve.id, ...ask }), /bad signature/);
});

test('readInvite refuses junk and a relay that is not https', () => {
  assert.equal(readInvite('https://yeschef.codes/join#nope'), null);
  assert.equal(readInvite(''), null);
  const p = (r) => 'x#' + b64u(new TextEncoder().encode(JSON.stringify({ v: 1, r, t: T, i: T, k: 'k', l: 'l', u: 1 })));
  assert.equal(readInvite(p('http://relay.example.com')), null);
  assert.equal(readInvite(p('javascript:alert(1)')), null);
  assert.equal(readInvite(p('http://127.0.0.1:8790')).relay, 'http://127.0.0.1:8790');
  assert.equal(readInvite(p('https://relay.example.com/some/path')).relay, 'https://relay.example.com');
});
