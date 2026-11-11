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
import type { webcrypto } from 'node:crypto';

const subtle = globalThis.crypto.subtle;
// The key types come from WebCrypto as this runtime has it (Node in the app, workerd in the relay), so one file fits both.
type CryptoKey = Awaited<ReturnType<typeof subtle.importKey>>;
const utf8 = new TextEncoder();
const text = new TextDecoder();
export const VERSION = 1;
const P256 = { name: 'ECDSA', namedCurve: 'P-256' };
const DH = { name: 'ECDH', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };

/** A member as its own Mac holds it: the public keys, and the private keys that never leave the Mac. */
export interface Member { id: string; signPub: string; dhPub: string; signKey: CryptoKey; dhKey: CryptoKey }
/** A member as the roster lists it: the id and the two public keys. `invite` lets a deputy invite people. */
export interface RosterMember { id: string; sign: string; dh: string; invite?: boolean }
/** The roster's plain part. Names, roles and permissions sit in `detail`, sealed with the team key. */
export interface RosterBody { v: number; team: string; ver: number; lead: string; at?: number; members: RosterMember[]; detail?: string }
/** A roster as it travels: its body as JSON, and the lead's signature over it. */
export interface SignedRoster { body: string; sig: string }
/** The parts of an invite link. */
export interface Invite { relay: string; team: string; invite: string; secret: string; leadSignPub: string; until: number; leadName: string; teamName: string }
/** A dev's ask to join, as the relay keeps it and passes it to the inviters. */
export interface JoinAsk { team: string; invite: string; m: string; sign: string; dh: string; blob: string; sig: string }
/** Fields of parsed JSON, not checked yet. */
type Unchecked<T> = { [K in keyof T]?: unknown };
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);

/** base64url without padding, for bytes. Workers have no Buffer, so this uses btoa and atob. */
export function b64u(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Bytes from base64url. Anything that is not base64url throws. */
export function unb64u(str: unknown): Uint8Array<ArrayBuffer> {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) throw new Error('not base64url');
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
/** An id: 16 random bytes, 22 characters. Teams, invites and inbox items use it. */
export const newId = (): string => b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
export const isId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{22}$/.test(s);
export const sha256 = async (data: string | Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await subtle.digest('SHA-256', typeof data === 'string' ? utf8.encode(data) : data));

/** A member's id from its signing key (base64url, raw P-256 point). */
export async function memberId(signPub: string): Promise<string> {
  return b64u((await sha256(unb64u(signPub))).subarray(0, 16));
}

/** A new member: the two key pairs and the id. Private keys stay extractable only so the app can save them (sealed by
 *  the macOS Keychain); the relay never makes members. */
export async function newMember(): Promise<Member> {
  const sign = await subtle.generateKey(P256, true, ['sign', 'verify']);
  const dh = await subtle.generateKey(DH, true, ['deriveBits']);
  const signPub = b64u(await subtle.exportKey('raw', sign.publicKey));
  const dhPub = b64u(await subtle.exportKey('raw', dh.publicKey));
  return { id: await memberId(signPub), signPub, dhPub, signKey: sign.privateKey, dhKey: dh.privateKey };
}
/** A member as JSON, to save. Holds private keys: the app seals it before it touches a disk. */
export async function saveMember(m: Member): Promise<string> {
  return JSON.stringify({ v: VERSION, id: m.id, signPub: m.signPub, dhPub: m.dhPub,
    sign: await subtle.exportKey('jwk', m.signKey), dh: await subtle.exportKey('jwk', m.dhKey) });
}
export async function loadMember(json: string | SavedMember): Promise<Member> {
  const d: SavedMember = typeof json === 'string' ? JSON.parse(json) : json;
  const m: Member = { id: d.id, signPub: d.signPub, dhPub: d.dhPub,
    signKey: await subtle.importKey('jwk', d.sign, P256, true, ['sign']),
    dhKey: await subtle.importKey('jwk', d.dh, DH, true, ['deriveBits']) };
  if (m.id !== await memberId(m.signPub)) throw new Error('saved member does not match its key');
  return m;
}

/** A member as saveMember() writes it. */
export interface SavedMember { v: number; id: string; signPub: string; dhPub: string; sign: webcrypto.JsonWebKey; dh: webcrypto.JsonWebKey }

const pubCache = new Map<string, CryptoKey>();
async function signPubKey(signPub: string): Promise<CryptoKey> {
  let k = pubCache.get(signPub);
  if (!k) {
    k = await subtle.importKey('raw', unb64u(signPub), P256, false, ['verify']);
    if (pubCache.size > 500) pubCache.delete(pubCache.keys().next().value!);
    pubCache.set(signPub, k);
  }
  return k;
}
/** Sign a string with a member's signing key. */
export async function sign(member: Pick<Member, 'signKey'>, data: string): Promise<string> {
  return b64u(await subtle.sign(SIG, member.signKey, utf8.encode(data)));
}
/** True when sig is signPub's signature over data. A bad key or signature is false, never a throw. */
export async function verify(signPub: string, sig: unknown, data: string): Promise<boolean> {
  try { return await subtle.verify(SIG, await signPubKey(signPub), unb64u(sig), utf8.encode(data)); }
  catch { return false; }
}

// The relay checks who opens a socket, or deletes a team, by a signed token: id.time.signature over the team,
// the method, the path and the time. It holds for five minutes either side of the relay's clock.
export const AUTH_SKEW_MS = 5 * 60 * 1000;
const authText = (team: string, method: string, path: string, ts: number | string) => `yc${VERSION} auth|${team}|${method}|${path}|${ts}`;
export async function authToken(member: Pick<Member, 'id' | 'signKey'>, { team, method, path, now = Date.now() }: { team: string; method: string; path: string; now?: number }): Promise<string> {
  return `${member.id}.${now}.${await sign(member, authText(team, method, path, now))}`;
}
/** The member id a token proves, or null. signPubOf(id) gives that member's signing key, or null if unknown. */
export async function checkAuth(token: unknown, { team, method, path, now = Date.now(), signPubOf }: {
  team: string; method: string; path: string; now?: number; signPubOf: (id: string) => string | null | Promise<string | null>;
}): Promise<string | null> {
  const [id, ts, sig, extra] = String(token || '').split('.');
  if (extra !== undefined || !isId(id) || ts === undefined || !/^\d{13}$/.test(ts) || !sig) return null;
  if (Math.abs(now - Number(ts)) > AUTH_SKEW_MS) return null;
  const pub = await signPubOf(id);
  if (!pub || await memberId(pub) !== id) return null;
  return (await verify(pub, sig, authText(team, method, path, ts))) ? id : null;
}

// The roster: the team's members, signed by the lead. The relay reads its plain part (ids and public keys, to check
// who connects) and checks the lead's signature. Names, roles and permissions sit in `detail`, sealed with the team key.
/** A signed roster from its body. */
export async function signRoster(lead: Pick<Member, 'signKey'>, body: Omit<RosterBody, 'v'>): Promise<SignedRoster> {
  const json = JSON.stringify({ v: VERSION, ...body });
  return { body: json, sig: await sign(lead, `yc${VERSION} roster|${json}`) };
}
/** The roster's body when its lead signed it, else null. leadSignPub pins the lead: the relay pins the key the team was
 *  made with, and a member pins the key its invite named. Without it, the roster's own lead entry is trusted (team setup). */
export async function readRoster(roster: unknown, { team, leadSignPub = null }: { team?: string; leadSignPub?: string | null } = {}): Promise<RosterBody | null> {
  try {
    const r = record(roster);
    if (!r || typeof r.body !== 'string' || typeof r.sig !== 'string') return null;
    const body = JSON.parse(r.body) as Unchecked<RosterBody>;
    if (body.v !== VERSION || (team && body.team !== team) || !isId(body.lead) || !isCount(body.ver) || body.ver < 1) return null;
    if (!Array.isArray(body.members) || !body.members.length) return null;
    const members: unknown[] = body.members;
    const ids = new Set<string>();
    for (const x of members) {
      const m = record(x);
      if (!m || !isId(m.id) || typeof m.sign !== 'string' || typeof m.dh !== 'string' || ids.has(m.id)) return null;
      if (m.id !== await memberId(m.sign)) return null;
      ids.add(m.id);
    }
    const checked = body as RosterBody;
    const lead = checked.members.find((m) => m.id === checked.lead);
    if (!lead || (leadSignPub && lead.sign !== leadSignPub)) return null;
    return (await verify(lead.sign, r.sig, `yc${VERSION} roster|${r.body}`)) ? checked : null;
  } catch { return null; }
}
const isCount = (n: unknown): n is number => Number.isSafeInteger(n);

// The team key, and seals made with it.
export const newTeamKey = (): string => b64u(globalThis.crypto.getRandomValues(new Uint8Array(32)));
export const teamKey = (raw: string): Promise<CryptoKey> => subtle.importKey('raw', unb64u(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
/** Seal JSON with an AES-GCM key. aad binds the seal to where it travels (team, kind, sender, receiver), so the relay
 *  cannot move a sealed blob to another member or another kind without the open failing. */
export async function seal(key: CryptoKey, value: unknown, aad: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(aad) }, key, utf8.encode(JSON.stringify(value)));
  return `${b64u(iv)}.${b64u(ct)}`;
}
/** Open a seal. Throws on a wrong key, a changed blob or a different aad. */
export async function open(key: CryptoKey, blob: unknown, aad: string): Promise<unknown> {
  const [iv, ct, extra] = String(blob || '').split('.');
  if (!iv || !ct || extra !== undefined) throw new Error('not a sealed blob');
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv), additionalData: utf8.encode(aad) }, key, unb64u(ct));
  return JSON.parse(text.decode(pt));
}

/** Where a sealed blob travels: the aad for each kind. */
export const aad = {
  summary: (team: string, from: string) => `yc${VERSION} summary|${team}|${from}`,
  send: (team: string, from: string, to: string) => `yc${VERSION} send|${team}|${from}|${to}`,
  detail: (team: string, ver: number) => `yc${VERSION} detail|${team}|${ver}`,
  join: (team: string, invite: string, from: string) => `yc${VERSION} join|${team}|${invite}|${from}`,
  // The invite's secret, sealed with the team key and kept on the relay with the invite, so the lead can read the asks
  // that come in on an invite a deputy made.
  invite: (team: string, invite: string) => `yc${VERSION} invite|${team}|${invite}`,
  welcome: (team: string, from: string, to: string) => `yc${VERSION} welcome|${team}|${from}|${to}`,
  // A member on the roster without the team key asks the lead for another welcome (its first expired unread).
  rekey: (team: string, from: string, to: string) => `yc${VERSION} rekey|${team}|${from}|${to}`,
};

/** Seal a body the sender also signs, so a member who holds the team key still cannot speak as another member. */
export async function sealSigned(key: CryptoKey, member: Pick<Member, 'signKey'>, body: unknown, where: string): Promise<string> {
  const b = JSON.stringify(body);
  return seal(key, { b, s: await sign(member, `${where}|${b}`) }, where);
}
/** Open a signed seal from `fromSignPub`. Throws unless both the seal and the signature hold. */
export async function openSigned(key: CryptoKey, blob: unknown, where: string, fromSignPub: string): Promise<unknown> {
  const { b, s } = (await open(key, blob, where)) as { b?: unknown; s?: unknown };
  if (typeof b !== 'string' || !(await verify(fromSignPub, s, `${where}|${b}`))) throw new Error('bad signature');
  return JSON.parse(b);
}

// One member to another, without the team key: ECDH between the two members' keys, then HKDF. The lead seals the team
// key to a new member this way.
async function pairKey(me: Pick<Member, 'dhKey'>, theirDhPub: string, info: string): Promise<CryptoKey> {
  const pub = await subtle.importKey('raw', unb64u(theirDhPub), DH, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, me.dhKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8.encode(info) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function sealTo(me: Pick<Member, 'dhKey'>, theirDhPub: string, value: unknown, where: string): Promise<string> {
  return seal(await pairKey(me, theirDhPub, where), value, where);
}
export async function openFrom(me: Pick<Member, 'dhKey'>, theirDhPub: string, blob: unknown, where: string): Promise<unknown> {
  return open(await pairKey(me, theirDhPub, where), blob, where);
}

// The invite. Its secret derives two keys: `proof`, which the dev shows the relay to ask to join (the relay keeps only
// its hash, the verifier), and `seal`, which seals the ask so only the team can read it. The relay sees the proof at
// join time, and HKDF does not run backwards, so it still cannot open the ask.
export const INVITE_DAYS = 7;
async function inviteParts(secret: string): Promise<{ proof: string; key: CryptoKey; verifier: string }> {
  const hk = await subtle.importKey('raw', unb64u(secret), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const opts = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8.encode(`yc${VERSION} invite ${info}`) });
  const proof = b64u(await subtle.deriveBits(opts('proof'), hk, 256));
  const key = await subtle.deriveKey(opts('seal'), hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { proof, key, verifier: b64u(await sha256(unb64u(proof))) };
}
/** The relay's check of a join: does this proof match the verifier it was given? */
export async function proofMatches(proof: unknown, verifier: unknown): Promise<boolean> {
  try { return b64u(await sha256(unb64u(proof))) === verifier; } catch { return false; }
}
/** A new invite. `link` goes to the dev; `record` goes to the relay. The link names the lead's key, so the dev's
 *  Yes Chef accepts only rosters that lead signed. */
export async function newInvite({ site = 'https://yeschef.codes', relay, team, lead, leadName = '', teamName = '', now = Date.now(), days = INVITE_DAYS }: {
  site?: string; relay: string; team: string; lead: Pick<Member, 'signPub'>; leadName?: string; teamName?: string; now?: number; days?: number;
}): Promise<{ link: string; record: { invite: string; verifier: string; until: number }; secret: string }> {
  const invite = newId();
  const secret = b64u(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const until = now + days * 86400000;
  const { verifier } = await inviteParts(secret);
  return { link: inviteLink({ site, relay, team, invite, secret, leadSignPub: lead.signPub, until, leadName, teamName }), record: { invite, verifier, until }, secret };
}
/** An invite's link, from its parts: the lead's Yes Chef shows it again for any open invite it holds the secret of. */
export function inviteLink({ site = 'https://yeschef.codes', relay, team, invite, secret, leadSignPub, until, leadName = '', teamName = '' }:
  Omit<Invite, 'leadName' | 'teamName'> & { site?: string; leadName?: string; teamName?: string }): string {
  const payload = { v: VERSION, r: relay, t: team, i: invite, k: secret, l: leadSignPub, u: until, n: leadName, tn: teamName };
  return `${site.replace(/\/$/, '')}/join#${b64u(utf8.encode(JSON.stringify(payload)))}`;
}
/** The parts of an invite link (or of its fragment alone), or null. */
export function readInvite(link: unknown): Invite | null {
  try {
    const frag = String(link).includes('#') ? String(link).split('#')[1]! : String(link);
    const p = JSON.parse(text.decode(unb64u(frag.trim()))) as Record<string, unknown>;
    if (p.v !== VERSION || !isId(p.t) || !isId(p.i) || typeof p.k !== 'string' || typeof p.l !== 'string' || !isCount(p.u)) return null;
    const relay = new URL(p.r as string);
    if (relay.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(relay.hostname)) return null;
    return { relay: relay.origin, team: p.t, invite: p.i, secret: p.k, leadSignPub: p.l, until: p.u,
      leadName: String(p.n || '').slice(0, 80), teamName: String(p.tn || '').slice(0, 80) };
  } catch { return null; }
}
/** What a dev signs to ask to join: it binds the dev's two keys and the sealed ask together, so nobody can pair
 *  someone else's signing key with their own key agreement key. */
export const joinText = (team: string, invite: string, dh: string, blob: string): string => `yc${VERSION} join|${team}|${invite}|${dh}|${blob}`;
/** The dev's ask to join: what the relay needs in plain, and the rest sealed with the invite's key. */
export async function joinRequest(inv: Pick<Invite, 'secret' | 'team' | 'invite'>, member: Member, ask: unknown): Promise<{ invite: string; proof: string; sign: string; dh: string; blob: string; sig: string }> {
  const { proof, key } = await inviteParts(inv.secret);
  const blob = await seal(key, ask, aad.join(inv.team, inv.invite, member.id));
  return { invite: inv.invite, proof, sign: member.signPub, dh: member.dhPub, blob, sig: await sign(member, joinText(inv.team, inv.invite, member.dhPub, blob)) };
}
/** The six digits both Macs show for an ask to join (Dan's 2a, 2026-11-10): on the dev's waiting screen and beside the
 *  ask at the lead. Made from the dev's two keys, so a key swapped on the way gives other digits. The invite's secret
 *  goes in too: the relay sees the keys but not the secret, so it cannot try keys until one gives the dev's digits.
 *  "427 190" style: two groups of three. */
export async function matchCode({ team, invite, secret, sign: signPub, dh }: { team: string; invite: string; secret: string; sign: string; dh: string }): Promise<string> {
  const h = await sha256(`yc${VERSION} match|${team}|${invite}|${secret}|${signPub}|${dh}`);
  // 48 bits mod 10^6: the skew is under one part in 10^8.
  const n = h.slice(0, 6).reduce((a, b) => a * 256 + b, 0) % 1000000;
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/** The team's read of an ask, with the invite's secret. It checks the dev's signature too: the lead's Yes Chef does not
 *  take the relay's word for it. */
export async function openJoin(secret: string, { team, invite, m, sign: signPub, dh, blob, sig }: JoinAsk): Promise<unknown> {
  if (m !== await memberId(signPub) || !(await verify(signPub, sig, joinText(team, invite, dh, blob)))) throw new Error('bad signature');
  const { key } = await inviteParts(secret);
  return open(key, blob, aad.join(team, invite, m));
}
