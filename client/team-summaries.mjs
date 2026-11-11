// The team client's summaries: this dev's sealed summary of the projects they share, the team's summaries, and who is
// online.
//
// Summaries are events, as in T3 Code's AgentAwarenessRelay: one goes out when its content changes, and only then. A
// read time (a key named `at`) is not a change: it rides along with a real one. Whether a teammate reads as live comes
// from events too: the relay's presence and the health their summary carries. Nothing compares two Macs' clocks.
import { sealSigned, openSigned, aad } from './seal.mjs';
import { shares } from './roles.mjs';
import { clean } from './team-common.mjs';
import { RETRY } from './team-connection.mjs';

const SUMMARY_TICKETS = 100;

/** What a summary says, without its read times: two summaries with one identity are the same news. */
export function identity(body) {
  return JSON.stringify(body, (k, v) => (k === 'at' ? undefined : v));
}

/** When a teammate was last known to be checked, for one who is not live: the earlier of the times that apply. Their
 *  board failing applies from its health's `since`; offline applies from when the relay last saw them. Null when no
 *  time is known. */
export function notCheckedSince({ online, health, lastSeen }) {
  const times = [];
  if (health && health.ok === false && Number.isFinite(health.since)) times.push(health.since);
  if (!online && Number.isFinite(lastSeen)) times.push(lastSeen);
  return times.length ? Math.min(...times) : null;
}

export const summaries = {
  // ---- the team's summaries and presence ----
  async takeSummary(m, blob) {
    const p = this.people.get(m);
    const key = await this.teamKey();
    if (!p || m === this.meId) return;
    // The welcome can land after the hello that carried the summaries: keep the latest one per teammate until the key
    // comes.
    if (!key) { this.later = this.later.filter((x) => !(x.t === 'summary' && x.m === m)); this.later.push({ t: 'summary', m, blob }); return; }
    try {
      const body = await openSigned(key, blob, aad.summary(this.state.team, m), p.sign);
      const rev = Number(body?.rev);
      if (!Number.isFinite(rev)) { this.summaries.delete(m); this.emit('team'); return; }
      // The floor outlives the shown summary: a reconnect clears what is shown, never the newest revision taken, so a
      // relay cannot hand back an older summary after it. The revision, not the time: a teammate whose clock went back
      // still gets through.
      if (rev < (this.summaryFloor.get(m) || 0)) return;
      this.summaryFloor.set(m, rev);
      this.summaries.set(m, { body });
    } catch { this.summaries.delete(m); }
    this.emit('team');
  },

  /** A teammate withdrew their summary. Their summary still waiting for the key goes too. Revisions are whole
   *  milliseconds: half past the withdrawn one turns that summary away and lets a newer one in. Added once, so repeated
   *  withdrawals do not shut out the next revision. */
  takeGone(m) {
    this.summaries.delete(m);
    if (Number.isInteger(this.summaryFloor.get(m))) this.summaryFloor.set(m, this.summaryFloor.get(m) + 0.5);
    this.later = this.later.filter((x) => !(x.t === 'summary' && x.m === m));
    this.emit('team');
  },

  /** The relay says a teammate came online or went. Going carries the relay's time (`at`), read on the relay's clock. */
  takePresence(msg) {
    if (msg.on) { this.online.add(msg.m); this.lastSeen.delete(msg.m); }
    else { this.online.delete(msg.m); if (Number.isFinite(msg.at)) this.lastSeen.set(msg.m, msg.at); }
    this.emit('team');
  },

  /** The summary the relay kept from this Mac before a restart, opened with this Mac's own key, so the first summary
   *  after the restart can carry its tickets with the health still unknown. */
  async takeHeld(blob) {
    if (this.lastBoard || !blob) return;
    try {
      const me = await this.member();
      this.heldBody = await openSigned(await this.teamKey(), blob, aad.summary(this.state.team, me.id), me.signPub);
    } catch { this.heldBody = null; }
  },

  /** Who the hello says is online, and when the relay last saw each of the rest (`seen`: member id -> time). */
  takeHelloPresence(msg) {
    this.online = new Set(msg.online || []);
    this.lastSeen = new Map(Object.entries(msg.seen && typeof msg.seen === 'object' ? msg.seen : {})
      .filter(([m, at]) => !this.online.has(m) && Number.isFinite(at)));
  },

  /** A teammate as the screens show them. Live: they are online, this Mac is online, and their summary says their
   *  board reads. Otherwise "Not checked since" the earlier of the times that apply. While this Mac is offline, a
   *  teammate it last saw online counts as offline from when this Mac lost the relay. */
  personView(p) {
    const linked = this.link === 'online';
    const online = linked && this.online.has(p.id);
    const s = this.summaries.get(p.id);
    const health = s?.body?.health || null;
    const lastSeen = linked ? this.lastSeen.get(p.id) : (this.online.has(p.id) ? this.lostAt : this.lastSeen.get(p.id));
    const live = online && health?.ok === true;
    return { online, summary: s?.body || null, at: Number.isFinite(s?.body?.at) ? s.body.at : null, live,
      notCheckedSince: live ? null : notCheckedSince({ online, health, lastSeen }) };
  },

  // ---- this dev's summary ----
  /** The Pass read this dev's board. Its summary follows, only when it changed. */
  board(board) {
    this.lastBoard = board;
    this.lastBoardAt = this.now();
    this.health(true);
  },

  /** The Pass's last board read worked (true) or failed (false). A flip is news and goes out like any change. */
  health(ok) {
    if (this.healthOk !== ok) { this.healthOk = ok; this.healthSince = this.now(); }
    this.publish();
  },

  /** Queue this dev's summary as it is now, if it differs from the one the relay took. */
  publish() {
    if (this.state.status !== 'member' || !(this.me && shares(this.me.role)) || !this.state.shared?.length) return;
    // No board read yet and nothing kept on the relay: there is nothing to say, or to correct.
    if (this.healthOk == null && !this.heldBody) return;
    const body = this.summaryBody();
    const id = identity(body);
    if (!this.flushing && id === this.sentId && !this.state.dropped) { this.next = null; return; }
    // The same summary already waits: it stays, so a sealed blob is not thrown away by each read.
    if (this.next && !this.next.forget && this.next.id === id && this.next.drop === this.state.dropped) return;
    this.next = { id, body, drop: this.state.dropped };
    this.flush();
  },

  /** The summary of the last board read, with this Mac's board health: ok true or false, or null before the first read
   *  since this Mac started. Before that read, the tickets are the ones the relay kept from before the restart, so a
   *  teammate keeps them but reads them as not checked. */
  summaryBody() {
    const health = { ok: this.healthOk ?? null, since: this.healthSince };
    if (!this.lastBoard) {
      const held = this.heldBody;
      return { v: 1, tickets: Array.isArray(held?.tickets) ? held.tickets : [], more: Number(held?.more) || 0, health };
    }
    return { ...summarize(this.lastBoard, this.state.shared, this.limits.summaryMax), at: this.lastBoardAt, health };
  },

  async flush() {
    if (!this.next || this.link !== 'online' || this.summaryTimer || this.flushing || !this.state.key) return;
    // Checked again at send time: a dev made a Viewer, or sharing nothing, sends no summary, whatever was queued before.
    if (!this.next.forget && (!(this.me && shares(this.me.role)) || !this.state.shared?.length)) { this.next = null; return; }
    // A summary and a forget share the relay's one limit per member. This Mac's clock went back since the send time was
    // set: the wait moves back by the jump, so it keeps its length and never waits the whole jump.
    const jump = (this.setAt ?? -Infinity) - this.now();
    if (jump > 0) { this.sentAt -= jump; this.setAt = this.now(); }
    const wait = this.sentAt + this.limits.summaryMs - this.now();
    if (wait > 0) { this.summaryTimer = this.timers.setTimeout(() => { this.summaryTimer = null; this.flush(); }, wait); return; }
    const next = this.next;
    if (!next.forget && next.id === this.sentId && !this.state.dropped) { this.next = null; return; }
    this.flushing = true;
    const backoff = () => {
      this.flushFails = (this.flushFails || 0) + 1;
      this.sentAt = this.now() - this.limits.summaryMs + Math.min(RETRY.cap, this.limits.summaryMs * 2 ** Math.min(this.flushFails, 10)); this.setAt = this.now();
    };
    try {
      let blob = null;
      if (!next.forget) {
        try { blob = next.blob || (next.blob = await this.sealSummary(next.body)); } catch (ex) {
          // A key or member that does not load fails the same way every time: wait as for a failed send.
          backoff();
          this.emit('error', { text: `Yes Chef could not seal this Mac's summary: ${clean(String(ex?.message || ex), 200)}` });
          return;
        }
        // Sealing waits on WebCrypto. A project dropped, or a Viewer made, while it ran replaced this summary or ended
        // sharing: it goes nowhere, and the newer one or the check above decides what does.
        if (this.next !== next || !(this.me && shares(this.me.role)) || !this.state.shared?.length) return;
      }
      const r = next.forget ? await this.say({ t: 'forget' }) : await this.say({ t: 'summary', blob });
      if (r.t === 'ok') {
        this.sentId = next.forget ? null : next.id; this.sentAt = this.now(); this.setAt = this.now(); this.flushFails = 0;
        if (this.state.dropped && next.drop === this.state.dropped) { delete this.state.dropped; this.save(); }
        if (this.next === next) this.next = null;
      } else if (r.code === 'slow') {
        this.sentAt = this.now() - this.limits.summaryMs + (Number(r.retryAfter) || this.limits.summaryMs); this.setAt = this.now();
      } else if (r.code === 'bad') {
        // The relay will never take this one: drop it and say so, rather than send it again.
        if (this.next === next) this.next = null;
        this.emit('error', { text: `The relay refused this Mac's summary: ${clean(r.text, 200)}` });
      } else {
        // Offline, a timeout, the cap: try again later, waiting longer each time, up to five minutes. The relay may have
        // taken it, so what it holds is not known: the next summary goes even if it matches the last one taken.
        this.sentId = null;
        backoff();
      }
    } finally {
      this.flushing = false;
      if (this.next) this.flush();
    }
  },

  /** Seal a summary, and halve its tickets until the sealed blob fits the relay's limit: names in any script are
   *  measured as the bytes they seal to. */
  async sealSummary(body) {
    const me = await this.member();
    const key = await this.teamKey();
    // The order is a revision, kept on disk and only going up, even when the clock goes back, so a replacement built
    // from the same board (a dropped project) is always newer and the relay cannot hand back the one it replaced. On
    // disk before any summary carries it: a restart never reuses a revision teammates already took.
    const rev = Math.max(this.now(), (Number(this.state.summaryRev) || 0) + 1);
    this.state.summaryRev = rev;
    if (!(await this.saveNow())) throw new Error('This Mac could not save the summary\'s revision, so it did not send it.');
    for (let b = body; ; ) {
      const blob = await sealSigned(key, me, { ...b, rev }, aad.summary(this.state.team, me.id));
      if (blob.length <= this.limits.summaryMax || !b.tickets.length) return blob;
      const n = Math.floor(b.tickets.length / 2);
      b = { ...b, tickets: b.tickets.slice(0, n), more: (b.more || 0) + b.tickets.length - n };
    }
  },

  /** Nothing more goes out, and the relay's copy goes. */
  unshare() { this.next = { forget: true, drop: this.state.dropped }; this.flush(); },

  /** The dev changed which projects they share. Sharing nothing drops the relay's copy. Dropping a project rebuilds the
   *  waiting summary from the last board at once, so a summary queued before the change never carries that project's
   *  tickets. Resolves false when the new list did not reach the disk. It is in use here all the same. */
  async share(projectIds) {
    const before = new Set(this.state.shared || []);
    this.state.shared = [...new Set(projectIds.map(String))];
    // A project dropped is kept on disk as owed until the relay takes a summary or forget built after it: a restart
    // before then still replaces the relay's copy.
    if ([...before].some((id) => !this.state.shared.includes(id))) this.state.dropped = (Number(this.state.dropped) || 0) + 1;
    this.shareNow(before);
    return this.saveNow();
  },
  shareNow(before) {
    if (!this.state.shared.length) { this.unshare(); return; }
    const dropped = [...before].some((id) => !this.state.shared.includes(id));
    // Only added: the summary changes, so it goes as any change does.
    if (!dropped) { this.publish(); return; }
    if (this.lastBoard && this.me && shares(this.me.role)) {
      const body = this.summaryBody();
      this.next = { id: identity(body), body, drop: this.state.dropped };
      this.flush();
    } else this.unshare();
  },
};

/** This dev's summary for the team: the tickets in the projects they share, newest first, the ones waiting on a person
 *  first. Only what a teammate's board needs: no messages, no code. It fits the relay's limit with room for the seal. */
export function summarize(board, shared, max = 65536) {
  const keep = new Set(shared || []);
  const tickets = (board?.tickets || [])
    .filter((k) => keep.has(k.thread.projectId) && k.place !== 'Coordinators')
    .sort((a, b) => (b.atPass - a.atPass) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .map((k) => ({
      thread: k.thread.threadId, title: clean(k.thread.title, 160), project: clean(k.project, 80), place: k.place,
      atPass: !!k.atPass, working: k.working || 0, asks: k.asks.length, call: !!k.call,
      prs: k.prs.slice(0, 5).map((p) => ({ repo: clean(p.repository, 100), n: p.number, state: p.state, url: typeof p.url === 'string' && /^https:\/\//.test(p.url) ? p.url.slice(0, 300) : null })),
      updatedAt: k.updatedAt || null,
    }));
  let n = Math.min(tickets.length, SUMMARY_TICKETS);
  // A sealed summary is about 4/3 of its JSON's UTF-8 bytes plus the signature. Halve the list until it fits. Sealing
  // checks the real size again (sealSummary).
  const bytes = (x) => new TextEncoder().encode(JSON.stringify(x)).length;
  while (n > 0 && (bytes(tickets.slice(0, n)) * 4) / 3 + 600 > max) n = Math.floor(n / 2);
  return { v: 1, tickets: tickets.slice(0, n), more: tickets.length - n };
}
