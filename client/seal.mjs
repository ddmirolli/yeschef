// The team's keys and seals (docs/team-relay-v0_1.md). WebCrypto only, so this one file runs in the app (Node, in
// Electron's utility process) and in the relay (a Cloudflare Worker, which bundles it from here).
//
// Who holds what:
//   - Each member's Yes Chef makes two P-256 key pairs on its own Mac: one signs (ECDSA), one agrees keys (ECDH).
//     A member's id is the first 16 bytes of SHA-256 over its signing key. The private keys never leave the Mac.
//   - The team key (AES-GCM, 256 bits) seals summaries, actions and the roster's names and roles. The relay never has it.
//   - The invite link carries an invite secret after the `#`, so no server sees it. The secret lets a dev ask to join,
//     sealed so only the team can read the ask. The team key reaches the dev only after the lead approves, sealed to
//     the dev's own ECDH key. A leaked link reads nothing.
const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const text = new TextDecoder();
export const VERSION = 1;
const P256 = { name: 'ECDSA', namedCurve: 'P-256' };
const DH = { name: 'ECDH', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };

/** base64url without padding, for bytes. Workers have no Buffer, so this uses btoa and atob. */
export function b64u(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Bytes from base64url. Anything that is not base64url throws. */
export function unb64u(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) throw new Error('not base64url');
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
/** An id: 16 random bytes, 22 characters. Teams, invites and inbox items use it. */
export const newId = () => b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
export const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{22}$/.test(s);
export const sha256 = async (data) => new Uint8Array(await subtle.digest('SHA-256', typeof data === 'string' ? utf8.encode(data) : data));

/** A member's id from its signing key (base64url, raw P-256 point). */
export async function memberId(signPub) {
  return b64u((await sha256(unb64u(signPub))).subarray(0, 16));
}

/** A new member: the two key pairs and the id. Private keys stay extractable only so the app can save them (sealed by
 *  the macOS Keychain); the relay never makes members. */
export async function newMember() {
  const sign = await subtle.generateKey(P256, true, ['sign', 'verify']);
  const dh = await subtle.generateKey(DH, true, ['deriveBits']);
  const signPub = b64u(await subtle.exportKey('raw', sign.publicKey));
  const dhPub = b64u(await subtle.exportKey('raw', dh.publicKey));
  return { id: await memberId(signPub), signPub, dhPub, signKey: sign.privateKey, dhKey: dh.privateKey };
}
/** A member as JSON, to save. Holds private keys: the app seals it before it touches a disk. */
export async function saveMember(m) {
  return JSON.stringify({ v: VERSION, id: m.id, signPub: m.signPub, dhPub: m.dhPub,
    sign: await subtle.exportKey('jwk', m.signKey), dh: await subtle.exportKey('jwk', m.dhKey) });
}
export async function loadMember(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  const m = { id: d.id, signPub: d.signPub, dhPub: d.dhPub,
    signKey: await subtle.importKey('jwk', d.sign, P256, true, ['sign']),
    dhKey: await subtle.importKey('jwk', d.dh, DH, true, ['deriveBits']) };
  if (m.id !== await memberId(m.signPub)) throw new Error('saved member does not match its key');
  return m;
}

const pubCache = new Map();
async function signPubKey(signPub) {
  let k = pubCache.get(signPub);
  if (!k) {
    k = await subtle.importKey('raw', unb64u(signPub), P256, false, ['verify']);
    if (pubCache.size > 500) pubCache.delete(pubCache.keys().next().value);
    pubCache.set(signPub, k);
  }
  return k;
}
/** Sign a string with a member's signing key. */
export async function sign(member, data) {
  return b64u(await subtle.sign(SIG, member.signKey, utf8.encode(data)));
}
/** True when sig is signPub's signature over data. A bad key or signature is false, never a throw. */
export async function verify(signPub, sig, data) {
  try { return await subtle.verify(SIG, await signPubKey(signPub), unb64u(sig), utf8.encode(data)); }
  catch { return false; }
}

// The relay checks who opens a socket, or deletes a team, by a signed token: id.time.signature over the team,
// the method, the path and the time. It holds for five minutes either side of the relay's clock.
export const AUTH_SKEW_MS = 5 * 60 * 1000;
const authText = (team, method, path, ts) => `yc${VERSION} auth|${team}|${method}|${path}|${ts}`;
export async function authToken(member, { team, method, path, now = Date.now() }) {
  return `${member.id}.${now}.${await sign(member, authText(team, method, path, now))}`;
}
/** The member id a token proves, or null. signPubOf(id) gives that member's signing key, or null if unknown. */
export async function checkAuth(token, { team, method, path, now = Date.now(), signPubOf }) {
  const [id, ts, sig, extra] = String(token || '').split('.');
  if (extra !== undefined || !isId(id) || !/^\d{13}$/.test(ts || '') || !sig) return null;
  if (Math.abs(now - Number(ts)) > AUTH_SKEW_MS) return null;
  const pub = await signPubOf(id);
  if (!pub || await memberId(pub) !== id) return null;
  return (await verify(pub, sig, authText(team, method, path, ts))) ? id : null;
}

// The roster: the team's members, signed by the lead. The relay reads its plain part (ids and public keys, to check
// who connects) and checks the lead's signature. Names, roles and permissions sit in `detail`, sealed with the team key.
/** A signed roster from its body. */
export async function signRoster(lead, body) {
  const json = JSON.stringify({ v: VERSION, ...body });
  return { body: json, sig: await sign(lead, `yc${VERSION} roster|${json}`) };
}
/** The roster's body when its lead signed it, else null. leadSignPub pins the lead: the relay pins the key the team was
 *  made with, and a member pins the key its invite named. Without it, the roster's own lead entry is trusted (team setup). */
export async function readRoster(roster, { team, leadSignPub = null } = {}) {
  try {
    if (!roster || typeof roster.body !== 'string' || typeof roster.sig !== 'string') return null;
    const body = JSON.parse(roster.body);
    if (body.v !== VERSION || (team && body.team !== team) || !isId(body.lead) || !Number.isSafeInteger(body.ver) || body.ver < 1) return null;
    if (!Array.isArray(body.members) || !body.members.length) return null;
    const ids = new Set();
    for (const m of body.members) {
      if (!m || !isId(m.id) || typeof m.sign !== 'string' || typeof m.dh !== 'string' || ids.has(m.id)) return null;
      if (m.id !== await memberId(m.sign)) return null;
      ids.add(m.id);
    }
    const lead = body.members.find((m) => m.id === body.lead);
    if (!lead || (leadSignPub && lead.sign !== leadSignPub)) return null;
    return (await verify(lead.sign, roster.sig, `yc${VERSION} roster|${roster.body}`)) ? body : null;
  } catch { return null; }
}

// The team key, and seals made with it.
export const newTeamKey = () => b64u(globalThis.crypto.getRandomValues(new Uint8Array(32)));
export const teamKey = (raw) => subtle.importKey('raw', unb64u(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
/** Seal JSON with an AES-GCM key. aad binds the seal to where it travels (team, kind, sender, receiver), so the relay
 *  cannot move a sealed blob to another member or another kind without the open failing. */
export async function seal(key, value, aad) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(aad) }, key, utf8.encode(JSON.stringify(value)));
  return `${b64u(iv)}.${b64u(ct)}`;
}
/** Open a seal. Throws on a wrong key, a changed blob or a different aad. */
export async function open(key, blob, aad) {
  const [iv, ct, extra] = String(blob || '').split('.');
  if (!iv || !ct || extra !== undefined) throw new Error('not a sealed blob');
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv), additionalData: utf8.encode(aad) }, key, unb64u(ct));
  return JSON.parse(text.decode(pt));
}

/** Where a sealed blob travels: the aad for each kind. */
export const aad = {
  summary: (team, from) => `yc${VERSION} summary|${team}|${from}`,
  send: (team, from, to) => `yc${VERSION} send|${team}|${from}|${to}`,
  detail: (team, ver) => `yc${VERSION} detail|${team}|${ver}`,
  join: (team, invite, from) => `yc${VERSION} join|${team}|${invite}|${from}`,
  // The invite's secret, sealed with the team key and kept on the relay with the invite, so the lead can read the asks
  // that come in on an invite a deputy made.
  invite: (team, invite) => `yc${VERSION} invite|${team}|${invite}`,
  welcome: (team, from, to) => `yc${VERSION} welcome|${team}|${from}|${to}`,
  // A member on the roster without the team key asks the lead for another welcome (its first expired unread).
  rekey: (team, from, to) => `yc${VERSION} rekey|${team}|${from}|${to}`,
};

/** Seal a body the sender also signs, so a member who holds the team key still cannot speak as another member. */
export async function sealSigned(key, member, body, where) {
  const b = JSON.stringify(body);
  return seal(key, { b, s: await sign(member, `${where}|${b}`) }, where);
}
/** Open a signed seal from `fromSignPub`. Throws unless both the seal and the signature hold. */
export async function openSigned(key, blob, where, fromSignPub) {
  const { b, s } = await open(key, blob, where);
  if (typeof b !== 'string' || !(await verify(fromSignPub, s, `${where}|${b}`))) throw new Error('bad signature');
  return JSON.parse(b);
}

// One member to another, without the team key: ECDH between the two members' keys, then HKDF. The lead seals the team
// key to a new member this way.
async function pairKey(me, theirDhPub, info) {
  const pub = await subtle.importKey('raw', unb64u(theirDhPub), DH, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, me.dhKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8.encode(info) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function sealTo(me, theirDhPub, value, where) {
  return seal(await pairKey(me, theirDhPub, where), value, where);
}
export async function openFrom(me, theirDhPub, blob, where) {
  return open(await pairKey(me, theirDhPub, where), blob, where);
}

// The invite. Its secret derives two keys: `proof`, which the dev shows the relay to ask to join (the relay keeps only
// its hash, the verifier), and `seal`, which seals the ask so only the team can read it. The relay sees the proof at
// join time, and HKDF does not run backwards, so it still cannot open the ask.
export const INVITE_DAYS = 7;
async function inviteParts(secret) {
  const hk = await subtle.importKey('raw', unb64u(secret), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const opts = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8.encode(`yc${VERSION} invite ${info}`) });
  const proof = b64u(await subtle.deriveBits(opts('proof'), hk, 256));
  const key = await subtle.deriveKey(opts('seal'), hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { proof, key, verifier: b64u(await sha256(unb64u(proof))) };
}
/** The relay's check of a join: does this proof match the verifier it was given? */
export async function proofMatches(proof, verifier) {
  try { return b64u(await sha256(unb64u(proof))) === verifier; } catch { return false; }
}
/** A new invite. `link` goes to the dev; `record` goes to the relay. The link names the lead's key, so the dev's
 *  Yes Chef accepts only rosters that lead signed. */
export async function newInvite({ site = 'https://yeschef.codes', relay, team, lead, leadName = '', teamName = '', now = Date.now(), days = INVITE_DAYS }) {
  const invite = newId();
  const secret = b64u(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const until = now + days * 86400000;
  const { verifier } = await inviteParts(secret);
  const payload = { v: VERSION, r: relay, t: team, i: invite, k: secret, l: lead.signPub, u: until, n: leadName, tn: teamName };
  return { link: `${site.replace(/\/$/, '')}/join#${b64u(utf8.encode(JSON.stringify(payload)))}`, record: { invite, verifier, until }, secret };
}
/** The parts of an invite link (or of its fragment alone), or null. */
export function readInvite(link) {
  try {
    const frag = String(link).includes('#') ? String(link).split('#')[1] : String(link);
    const p = JSON.parse(text.decode(unb64u(frag.trim())));
    if (p.v !== VERSION || !isId(p.t) || !isId(p.i) || typeof p.k !== 'string' || typeof p.l !== 'string' || !Number.isSafeInteger(p.u)) return null;
    const relay = new URL(p.r);
    if (relay.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(relay.hostname)) return null;
    return { relay: relay.origin, team: p.t, invite: p.i, secret: p.k, leadSignPub: p.l, until: p.u,
      leadName: String(p.n || '').slice(0, 80), teamName: String(p.tn || '').slice(0, 80) };
  } catch { return null; }
}
/** What a dev signs to ask to join: it binds the dev's two keys and the sealed ask together, so nobody can pair
 *  someone else's signing key with their own key agreement key. */
export const joinText = (team, invite, dh, blob) => `yc${VERSION} join|${team}|${invite}|${dh}|${blob}`;
/** The dev's ask to join: what the relay needs in plain, and the rest sealed with the invite's key. */
export async function joinRequest(inv, member, ask) {
  const { proof, key } = await inviteParts(inv.secret);
  const blob = await seal(key, ask, aad.join(inv.team, inv.invite, member.id));
  return { invite: inv.invite, proof, sign: member.signPub, dh: member.dhPub, blob, sig: await sign(member, joinText(inv.team, inv.invite, member.dhPub, blob)) };
}
/** The team's read of an ask, with the invite's secret. It checks the dev's signature too: the lead's Yes Chef does not
 *  take the relay's word for it. */
export async function openJoin(secret, { team, invite, m, sign: signPub, dh, blob, sig }) {
  if (m !== await memberId(signPub) || !(await verify(signPub, sig, joinText(team, invite, dh, blob)))) throw new Error('bad signature');
  const { key } = await inviteParts(secret);
  return open(key, blob, aad.join(team, invite, m));
}
