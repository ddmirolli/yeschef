// The team client's roster: the signed versions and their floor, invites and asks to join, the lead's edits, and the
// welcomes that carry the team key.
import { open, seal, aad, readRoster, signRoster, newInvite, openJoin, sealTo, openFrom, isId, newId, matchCode, inviteLink } from './seal.ts';
import { grant, shares } from './roles.ts';
import { clean, WELCOME_TTL } from './team-common.ts';
import type { Grant, Role } from './roles.ts';
import type { SignedRoster } from './seal.ts';
import type { Area, Person, Reply, Team } from './team.ts';
import { cleanAreaRules, cleanTeamRules, changeArea, changeTeamRule, type TeamRules } from './team-rules.ts';
import type { InviteRow, PendingRow } from '../relay/room.ts';

/** A member as the lead edits them: pushRoster's list. */
export interface Edit { sign: string; dh: string; name: string; role: unknown; perms?: unknown; area: string | null }
/** The people as this Mac has them, marked with the roster version they came from. */
export type Edits = Map<string, Edit> & { ver?: number | undefined };
/** What the roster's sealed detail says of one member, before it is checked. */
type Detail = { name?: unknown; role?: unknown; perms?: unknown; area?: unknown; under?: unknown };
/** A member's ask for the key, opened. */
type KeyAsk = { k?: unknown };

// A member without the team key asks the lead for another welcome at most this often.
export const KEY_ASK_MS = 86400000;

/** A roster's fingerprint: SHA-256 of its signed body. Two rosters with one version must have one fingerprint. */
async function rosterDigest(body: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(body))));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The member ids of a signed roster this lead holds unconfirmed, or none. */
function unsentIds(unsent: SignedRoster | undefined): Set<string> {
  try { return new Set(JSON.parse(unsent!.body).members.map((x: { id: string }) => x.id)); } catch { return new Set(); }
}

export const roster = {
  /** Check a roster against the lead this Mac pinned, then read its names and roles with the team key. The highest
   *  version taken is saved, so after a restart a relay cannot hand back an older roster that still lists a removed
   *  member or a role the lead took away. A roster the lead signed without this Mac on it is a removal, whether or not
   *  the relay closes the socket: returns 'removed'. */
  async takeRoster(signed: SignedRoster): Promise<boolean | 'removed'> {
    const body = await readRoster(signed, { team: this.state.team, leadSignPub: this.state.leadSign });
    const floor = Math.max(this.roster?.ver || 0, Number(this.state.rosterVer) || 0);
    if (!body || body.ver < floor) return false;
    // One roster per version: a different roster signed at a version this Mac already took is refused, so a relay that
    // kept two cannot swap one for the other.
    const digest = await rosterDigest(signed.body);
    if (body.ver === (Number(this.state.rosterVer) || 0) && this.state.rosterHash && this.state.rosterHash !== digest) return false;
    if (body.ver > (Number(this.state.rosterVer) || 0) || !this.state.rosterHash) {
      this.state.rosterVer = body.ver;
      this.state.rosterHash = digest;
      // The floor is waited for. When it does not reach the disk this Mac still takes the newer roster (the older one
      // grants more), and the screens say the team is not saved until a later save gets through.
      await this.saveNow();
      if (body.ver < (this.roster?.ver || 0)) return false;
    }
    const myId = this.meId || (await this.member()).id;
    if (!body.members.some((x) => x.id === myId)) { this.end('removed'); return 'removed'; }
    const sharedBefore = this.me ? shares(this.me.role) : null;
    const key = await this.teamKey();
    let detail: { people?: unknown; areas?: unknown; rules?: unknown } = {};
    if (key) { try { detail = await open(key, body.detail, aad.detail(this.state.team, body.ver)) as typeof detail; } catch { detail = {}; } }
    // The roster, its people and their grants change together, after the waits above, and never back to an older
    // version: an edit never reads a new version with the old grants.
    if (body.ver < (this.roster?.ver || 0)) return false;
    this.roster = body;
    this.rosterSigned = signed;
    // A roster this lead signed and kept for its answer leaves once one at or past its version is in place.
    if (this.state.unsent) { let u = null; try { u = JSON.parse(this.state.unsent.body).ver; } catch { u = null; } if (!((u as number) > body.ver)) { delete this.state.unsent; this.save(); } }
    // The areas and each member's area travel sealed in the roster the lead signs, as roles do: the relay never sees them.
    this.areas = readAreas(detail?.areas);
    this.rules = cleanTeamRules(detail?.rules);
    const people = (detail?.people && typeof detail.people === 'object' ? detail.people : {}) as Record<string, Detail | undefined>;
    this.people = new Map(body.members.map((m): [string, Person] => {
      const d = people[m.id] || {};
      const g = m.id === body.lead ? grant('lead') : grant(d.role, d.perms);
      return [m.id, { id: m.id, sign: m.sign, dh: m.dh, invite: !!m.invite || m.id === body.lead, name: clean(d.name, 60) || 'Not checked', ...g, area: areaFor(g.role, d.area, this.areas), under: d.under as string | null }];
    }));
    readUnder(this.people, body.lead);
    for (const id of [...this.summaries.keys()]) if (!this.people.has(id)) this.summaries.delete(id);
    for (const id of [...this.summaryFloor.keys()]) if (!this.people.has(id)) this.summaryFloor.delete(id);
    // Made a Viewer: nothing more goes out, and the relay's copy goes.
    if (sharedBefore === true && !(this.me && shares(this.me.role))) this.unshare();
    this.emit('team');
    return true;
  },

  async takeInvite(inv: InviteRow): Promise<void> {
    const key = await this.teamKey();
    if (!isId(inv?.id)) return;
    if (!key) { this.later.push({ t: 'invite', invite: inv }); return; }
    try {
      const { secret } = await open(key, inv.box, aad.invite(this.state.team, inv.id)) as { secret: string };
      this.invites.set(inv.id, { id: inv.id, until: inv.until, by: inv.by, secret });
    } catch { /* not sealed with our key: not shown */ }
    this.emit('team');
  },

  async takePending(p: PendingRow): Promise<void> {
    const inv = this.invites.get(p?.invite as string);
    if (!inv) { if (!this.state.key) this.later.push({ t: 'pending', pending: p }); return; }
    try {
      const ask = await openJoin(inv.secret, { team: this.state.team, ...p }) as { name?: unknown; projects?: unknown[] };
      // The same six digits as on the dev's waiting screen, from the keys this ask came with (Dan's 2a).
      const code = await matchCode({ team: this.state.team, invite: p.invite, secret: inv.secret, sign: p.sign, dh: p.dh });
      this.pending.set(p.m, { m: p.m, invite: p.invite, at: p.at, sign: p.sign, dh: p.dh, code, name: clean(ask.name, 60) || 'No name', projects: (ask.projects || []).map((x) => clean(x, 80)).slice(0, 50) });
    } catch { /* an ask that does not open or is not signed by its key: not shown */ }
    this.emit('team');
  },

  // What waits for the key goes too, so the welcome does not bring back an answered ask or a revoked invite.
  dropPending(m: string): void {
    this.pending.delete(m);
    this.later = this.later.filter((x) => !(x.t === 'pending' && x.pending?.m === m));
    this.emit('team');
  },
  dropInvite(id: string): void {
    this.invites.delete(id);
    this.later = this.later.filter((x) => !(x.t === 'invite' && x.invite?.id === id) && !(x.t === 'pending' && x.pending?.invite === id));
    this.emit('team');
  },

  // ---- the lead's and inviters' part ----
  async invite({ site, now }: { site?: string; now?: number } = {}): Promise<{ error: string | undefined } | { link: string; until: number; id: string }> {
    if (now === undefined) now = this.now();
    if (!this.people.get(this.meId as string)?.invite) return { error: 'Your role cannot invite people.' };
    const inv = await newInvite({ site, relay: this.state.relay, team: this.state.team, lead: { signPub: this.state.leadSign }, leadName: this.people.get(this.roster!.lead)?.name || '', teamName: this.state.teamName, now });
    const box = await seal((await this.teamKey())!, { secret: inv.secret }, aad.invite(this.state.team, inv.record.invite));
    const r = await this.say({ t: 'invite', invite: inv.record.invite, verifier: inv.record.verifier, until: inv.record.until, box });
    if (r.t !== 'ok') return { error: r.text };
    this.invites.set(inv.record.invite, { id: inv.record.invite, until: inv.record.until, by: this.meId!, secret: inv.secret });
    this.emit('team');
    return { link: inv.link, until: inv.record.until, id: inv.record.invite };
  },

  async revoke(id: string): Promise<Reply> { const r = await this.say({ t: 'revoke', invite: id }); if (r.t === 'ok') { this.invites.delete(id); this.emit('team'); } return r; },
  async decline(m: string): Promise<Reply> { const r = await this.say({ t: 'decline', m }); if (r.t === 'ok') { this.pending.delete(m); this.emit('team'); } return r; },

  /** A new roster from the lead: people is the full list as Map id -> { sign, dh, name, role, perms, area }; areas is
   *  the team's list of { id, name, projects, mode, budget }; rules, the team's Rules. Left out, each stays as it is. */
  async pushRoster(people: Edits, areas?: Area[], rules?: TeamRules): Promise<Reply> {
    if (areas === undefined) areas = this.areas;
    if (rules === undefined) rules = this.rules;
    // One edit at a time, so two edits never sign two rosters with one version.
    const next = this.rosterLock.then(() => this.pushRosterNow(people, areas, rules));
    this.rosterLock = next.catch(() => {});
    return next;
  },
  async pushRosterNow(people: Edits, areas: Area[], rules: TeamRules): Promise<Reply> {
    if (!this.isLead) return { t: 'err', code: 'role', text: 'Only the lead can change the team.' };
    const stale: Reply = { t: 'err', code: 'stale', text: 'The team changed while you edited it. Look again and try once more.' };
    // A roster this Mac signed and the relay never confirmed goes again first: the lead never signs a second, different
    // roster with that version.
    const held = this.state.unsent;
    if (held) {
      const hb = await readRoster(held, { team: this.state.team, leadSignPub: this.state.leadSign });
      // It leaves only once a roster at or past its version is in place here. Until then no new roster is signed, so the
      // relay never holds two at one version.
      if (!hb || hb.ver <= (this.roster?.ver || 0)) { delete this.state.unsent; await this.saveNow(); }
      else {
        const r0 = await this.say({ t: 'roster', roster: held });
        if (r0.t === 'ok') { await this.takeRoster(held); return stale; }
        // The relay is past this Mac's roster: read the team again (the next hello brings it). Nothing is signed till then.
        if (r0.code === 'stale') { this.refresh(); return stale; }
        return r0;
      }
    }
    const me = await this.member();
    const ver = this.roster!.ver + 1;
    const list = readAreas(areas);
    const detail = { people: {} as Record<string, Detail>, areas: list, rules: cleanTeamRules(rules) };
    const members: { id: string; sign: string; dh: string; invite?: true }[] = [];
    const placed = new Map([...people].map(([id, p]): [string, Grant & { area: string | null }] => {
      const g = id === me.id ? grant('lead') : grant(p.role, p.perms);
      return [id, { ...g, area: areaFor(g.role, p.area, list) }];
    }));
    const under = chartUnder(placed, me.id, list);
    for (const [id, p] of people) {
      const g = placed.get(id)!;
      detail.people[id] = { name: clean(p.name, 60), role: g.role, perms: g.perms, area: g.area, ...(under.has(id) ? { under: under.get(id) } : {}) };
      members.push({ id, sign: p.sign, dh: p.dh, ...(g.perms.includes('invite') ? { invite: true } : {}) });
    }
    if ((people.ver !== undefined && people.ver !== this.roster!.ver) || ver !== this.roster!.ver + 1) return stale;
    const signed = await signRoster(me, { team: this.state.team, ver, lead: me.id, at: this.now(), members, detail: await seal((await this.teamKey())!, detail, aad.detail(this.state.team, ver)) });
    // Kept until the relay answers, so a lost answer sends this same roster again, never a new one.
    this.state.unsent = signed;
    if (!(await this.saveNow())) { delete this.state.unsent; return { t: 'err', code: 'save', text: 'Not changed: Yes Chef could not save. Try again shortly.' }; }
    const r = await this.say({ t: 'roster', roster: signed });
    if (r.t === 'ok') await this.takeRoster(signed);
    // Refused or unanswered, it is kept: it leaves once a roster at or past its version is in place here.
    else if (r.code === 'stale') this.refresh();
    return r;
  },

  /** The people as this Mac has them now, marked with the roster version they came from: pushRoster refuses a list read
   *  from an older version, so two edits that cross never undo each other. */
  current(): Edits { const out: Edits = this._current(); out.ver = this.roster?.ver; return out; },
  _current(): Map<string, Edit> { return new Map([...this.people].map(([id, p]): [string, Edit] => [id, { sign: p.sign, dh: p.dh, name: p.name, role: p.role, perms: p.perms, area: p.area }])); },

  /** Approve an ask: the dev joins the roster with a role, then gets the team key sealed to their own key. */
  async approve(m: string, role: unknown = 'engineer', perms?: unknown, area: string | null = null): Promise<Reply> {
    const ask = this.pending.get(m);
    if (!ask) return { t: 'err', code: 'gone', text: 'That ask is no longer waiting.' };
    const people = this.current();
    people.set(m, { sign: ask.sign, dh: ask.dh, name: ask.name, ...grant(role, perms), area });
    // The welcome is owed from before the roster goes: if the relay takes the roster but its answer is lost, the next
    // connect finds the dev on the roster and sends it then. sendWelcomes() drops one whose dev never made the roster,
    // so a refused roster owes nothing.
    this.state.welcomes = [...new Set([...(this.state.welcomes || []), m])];
    this.save();
    (this.approving ||= new Map()).set(m, (this.approving.get(m) || 0) + 1);
    let r: Reply;
    try { r = await this.pushRoster(people); } finally { const n = this.approving.get(m)! - 1; if (n > 0) this.approving.set(m, n); else this.approving.delete(m); }
    if (r.t !== 'ok') return r;
    this.pending.delete(m);
    const left = await this.sendWelcomes();
    this.emit('team');
    return left.includes(m) ? { t: 'ok', ver: r.ver, welcome: 'later' } : { t: 'ok', ver: r.ver };
  },

  /** Send each welcome still owed. Returns the members still waiting for one. A member not on the roster is owed
   *  nothing, unless the roster that adds them is still on its way: an approval waiting on its answer, or a roster this
   *  lead signed and the relay has not confirmed. */
  async sendWelcomes(): Promise<string[]> {
    const me = await this.member();
    const done = new Set<string>();
    for (const m of this.state.welcomes || []) {
      const p = this.people.get(m);
      if (!p) { if (!this.approving?.has(m) && !unsentIds(this.state.unsent).has(m)) done.add(m); continue; }
      const blob = await sealTo(me, p.dh, { teamKey: this.state.key, teamName: this.state.teamName }, aad.welcome(this.state.team, me.id, m));
      if ((await this.say({ t: 'send', to: m, blob, ttl: WELCOME_TTL })).t === 'ok') done.add(m);
    }
    // Read again after the sends: an approval while they waited added a welcome this pass did not send, and it stays owed.
    const now = this.state.welcomes || [];
    const left = now.filter((m) => !done.has(m));
    if (left.length !== now.length) { this.state.welcomes = left; this.save(); }
    return left;
  },

  /** On the roster without the team key: the welcome waited its 7 days on the relay unread. Ask the lead for another,
   *  sealed to the lead's key, at most once a day. */
  async askKey(): Promise<void> {
    const lead = this.people.get(this.roster?.lead as string);
    const at = this.now();
    const last = Number(this.state.keyAskAt) || 0;
    // An ask saved in the future means this Mac's clock went back: ask now, not after that time plus a day.
    if (!lead || lead.id === this.meId || (last <= at && at - last < KEY_ASK_MS)) return;
    const me = await this.member();
    const blob = await sealTo(me, lead.dh, { k: 'key', at }, aad.rekey(this.state.team, me.id, lead.id));
    if ((await this.say({ t: 'send', to: lead.id, blob, ttl: WELCOME_TTL })).t === 'ok') { this.state.keyAskAt = at; this.save(); }
  },

  /** The lead reads a member's ask for the key. Only that member can open the welcome it gets, so a forged ask gains
   *  nothing; it still must come from a key on the lead's roster. True when a welcome is now owed. */
  async readKeyAsk(sender: Person, blob: string): Promise<boolean> {
    const me = await this.member();
    let ask: KeyAsk | null = null;
    try { ask = await openFrom(me, sender.dh, blob, aad.rekey(this.state.team, sender.id, me.id)) as KeyAsk | null; } catch { return false; }
    if (ask?.k !== 'key') return false;
    this.state.welcomes = [...new Set([...(this.state.welcomes || []), sender.id])];
    return true;
  },

  async setRole(m: string, role: unknown, perms?: unknown, area: string | null = null): Promise<Reply> {
    const people = this.current();
    if (!people.has(m) || m === this.meId) return { t: 'err', code: 'bad', text: 'That person is not on the team.' };
    people.set(m, { ...people.get(m)!, ...grant(role, perms), area });
    return this.pushRoster(people);
  },

  /** The lead adds an area by name. It holds a name only until Rules gives it projects and a mode. */
  async addArea(name: unknown): Promise<Reply> {
    const n = clean(name, AREA_NAME);
    if (!n) return { t: 'err', code: 'bad', text: 'Type a name for the area.' };
    if (this.areas.length >= AREA_MAX) return { t: 'err', code: 'full', text: `A team holds up to ${AREA_MAX} areas.` };
    if (this.areas.some((a) => a.name.toLowerCase() === n.toLowerCase())) return { t: 'err', code: 'bad', text: 'There is an area with that name.' };
    return this.pushRoster(this.current(), [...this.areas, { id: newId(), name: n, ...cleanAreaRules(null) }]);
  },

  /** The lead renames an area or takes it away. Its people stay on the team, with no area. */
  async renameArea(id: string, name: unknown): Promise<Reply> {
    const n = clean(name, AREA_NAME);
    if (!n || !this.areas.some((a) => a.id === id)) return { t: 'err', code: 'bad', text: 'That area is not on the team.' };
    return this.pushRoster(this.current(), this.areas.map((a) => (a.id === id ? { ...a, name: n } : a)));
  },
  async removeArea(id: string): Promise<Reply> {
    if (!this.areas.some((a) => a.id === id)) return { t: 'err', code: 'bad', text: 'That area is not on the team.' };
    return this.pushRoster(this.current(), this.areas.filter((a) => a.id !== id));
  },

  /** The lead changes one team Rule (Settings -> Rules): { key, value } as the page sends them. */
  async setTeamRule(key: string, value: string): Promise<Reply> {
    const out = changeTeamRule(this.rules, key, value);
    if (!out.rules) return { t: 'err', code: 'bad', text: out.error || 'Not changed.' };
    return this.pushRoster(this.current(), this.areas, out.rules);
  },
  /** The lead changes an area's mode or budget, or puts a project in it or takes one out. */
  async setArea(id: string, field: string, value: string, on?: boolean): Promise<Reply> {
    const a = this.areas.find((x) => x.id === id);
    if (!a) return { t: 'err', code: 'bad', text: 'That area is not on the team.' };
    const out = changeArea(a, field, value, on);
    const next = out.area;
    if (!next) return { t: 'err', code: 'bad', text: out.error || 'Not changed.' };
    return this.pushRoster(this.current(), this.areas.map((x) => (x.id === id ? next : x)));
  },

  /** The links of the open invites this Mac can read, to show and copy again. */
  links({ site }: { site?: string } = {}): { id: string; until: number; by: string; link: string }[] {
    const leadName = this.people.get(this.roster?.lead as string)?.name || '';
    return [...this.invites.values()].filter((i) => i.secret && i.until > this.now()).sort((a, b) => b.until - a.until)
      .map((i) => ({ id: i.id, until: i.until, by: i.by, link: inviteLink({ site, relay: this.state.relay, team: this.state.team, invite: i.id, secret: i.secret, leadSignPub: this.state.leadSign, until: i.until, leadName, teamName: this.state.teamName }) }));
  },

  async remove(m: string): Promise<Reply> {
    const people = this.current();
    if (!people.has(m) || m === this.meId) return { t: 'err', code: 'bad', text: 'That person is not on the team.' };
    people.delete(m);
    return this.pushRoster(people);
  },
} satisfies ThisType<Team>;

const AREA_MAX = 20, AREA_NAME = 40;
/** The areas from a roster, cleaned: ids, names, no repeats, at most AREA_MAX, each with its projects, mode and budget
 *  (client/team-rules.ts). An area from a roster made before Rules is in Open kitchen with no projects. */
function readAreas(list: unknown): Area[] {
  const out: Area[] = [], ids = new Set<string>();
  for (const a of (Array.isArray(list) ? list : []) as ({ id?: unknown; name?: unknown; projects?: unknown; mode?: unknown; budget?: unknown } | null)[]) {
    const name = clean(a?.name, AREA_NAME);
    if (!isId(a?.id) || !name || ids.has(a!.id)) continue;
    ids.add(a!.id); out.push({ id: a!.id, name, ...cleanAreaRules(a) });
    if (out.length >= AREA_MAX) break;
  }
  return out;
}
/** Who each member reports to, from where the lead put them on the chart (Dan's 1b): an Engineer in an area reports to
 *  that area's first Area owner; everyone else, and an Engineer in an area with no owner, to the lead. The lead reports
 *  to nobody. people: Map id -> { role, area }. Returns Map id -> the id they report to. */
export function chartUnder(people: Map<string, { role: string; area?: string | null | undefined }>, lead: string, areas: readonly Pick<Area, 'id'>[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const [id, p] of people) if (p.role === 'owner' && p.area && !owner.has(p.area)) owner.set(p.area, id);
  const out = new Map<string, string>();
  for (const [id, p] of people) {
    if (id === lead) continue;
    out.set(id, p.role === 'engineer' && p.area && areas.some((a) => a.id === p.area) && owner.has(p.area) ? owner.get(p.area)! : lead);
  }
  return out;
}
/** The `under` the lead signed, checked in place: a member on this roster, never the lead or a loop. Anything else is
 *  null, which the screens read as "not checked". The lead's is always null. */
export function readUnderForTest(people: Map<string, Under>, lead: string): void { readUnder(people, lead); }
/** A member as readUnder checks them. */
type Under = { id: string; under: string | null };
function readUnder(people: Map<string, Under>, lead: string): void {
  for (const p of people.values()) {
    if (p.id === lead || typeof p.under !== 'string' || p.under === p.id || !people.has(p.under)) { p.under = null; continue; }
  }
  for (const p of people.values()) {
    // Follow the chain up: it must reach the lead within the team's size, or it is a loop.
    let at: Under | undefined = p, steps = 0;
    while (at && at.id !== lead && at.under && steps <= people.size) { at = people.get(at.under); steps++; }
    if (p.under && (!at || at.id !== lead)) p.under = null;
  }
}
/** A member's area: only an Area owner or an Engineer sits in one, and only one that is on the list. */
function areaFor(role: Role, area: unknown, areas: readonly Area[]): string | null {
  return (role === 'owner' || role === 'engineer') && areas.some((a) => a.id === area) ? area as string : null;
}
