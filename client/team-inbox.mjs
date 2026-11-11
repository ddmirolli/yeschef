// The team client's inbox: messages between members (the lead's welcome, a teammate's action, its answer, a member's
// ask for the key) and the actions this dev sends.
//
// Every inbox item takes one path: judge it, commit what it changed, send what it owes, then ack. The answer and the
// ack go only after the commit. A failed commit sends neither, so the relay keeps the item and it is judged again. An
// action's signed nonce is its delivery id: a redelivery gets its first answer again and never runs twice.
import { isId, newId, sealSigned, openSigned, openFrom, aad, AUTH_SKEW_MS } from './seal.mjs';
import { allows, refusal, signature, shares } from './roles.mjs';
import { clean, ASK_MS, ACT_TTL, SEEN_KEEP_MS } from './team-common.mjs';

/** A dev's own board older than this is not checked: an action waits for a fresh one. */
export const BOARD_FRESH_MS = 60000;
const LATER_INBOX = 100, SEEN_MAX = 500;

/** Outcomes of judging an inbox item. Ack: nothing to keep, let the relay's copy go. Keep: leave it on the relay. */
const ACK = Object.freeze({});
const KEEP = Object.freeze({ keep: true });

export const inbox = {
  async done(item) { return (await this.say({ t: 'done', item })).t === 'ok'; },

  /** One inbox item, on the one path: judge, commit, answer, ack. */
  async take(msg) {
    const out = await this.judge(msg);
    if (out.keep) return;
    if (out.commit && !(await this.saveNow())) { out.undo?.(); return; }
    out.after?.();
    // An answer the relay did not take leaves the item on the relay: it comes again and gets the same answer.
    for (const send of out.replies || []) if (!(await send())) return;
    if (typeof msg.item === 'string') await this.done(msg.item);
  },

  /** What an inbox item means for this Mac, from the roster as it is now. Changes state only in memory: take() commits. */
  async judge(msg) {
    const { from, blob } = msg;
    if (!this.people.get(from)) return ACK;
    const me = await this.member();
    let body = null;
    if (this.state.key) { try { body = await openSigned(await this.teamKey(), blob, aad.send(this.state.team, from, me.id), this.people.get(from).sign); } catch { body = null; } }
    if (!body) {
      // The lead's welcome opens with this Mac's own key, whether or not the team key is here yet.
      if (from === this.roster?.lead && from !== me.id) {
        let w = null;
        try { w = await openFrom(me, this.people.get(from).dh, blob, aad.welcome(this.state.team, from, me.id)); } catch { w = null; }
        if (typeof w?.teamKey === 'string') return this.welcome(w);
      }
      // Before the team key, anything else (a teammate's action that came first) waits here, not taken, and runs once
      // the welcome brings the key.
      if (!this.state.key) { this.defer(msg); return KEEP; }
      if (this.isLead && (await this.readKeyAsk(this.people.get(from), blob))) return { commit: true, after: () => { this.sendWelcomes().catch(() => {}); } };
      return ACK;
    }
    // The team may have changed while the blob was opened: this Mac removed or stopped, or the sender removed or given
    // another role. Only the roster as it is now counts.
    if (this.stopped || this.state.status !== 'member') return KEEP;
    const sender = this.people.get(from);
    if (!sender) return ACK;
    if (body.k === 'act') return this.intake(sender, body);
    if (body.k === 'result') {
      const result = { status: Number(body.status) || 500, text: clean(body.text, 300) };
      const o = this.out.get(body.re);
      if (o && o.to === from) { this.out.delete(body.re); this.timers.clearTimeout(o.timer); o.resolve(result); }
      // A late answer still reaches the screen: the action ran when their Mac came online.
      this.emit('result', { from, name: sender.name, re: body.re, ...result });
    }
    return ACK;
  },

  /** The lead's welcome: the team key. It is in use at once; the relay lets the welcome go only once it is on disk. */
  async welcome(w) {
    // Removed, declined or stopped while the welcome was opened: the key is not kept.
    if (this.stopped || (this.state.status !== 'member' && this.state.status !== 'pending')) return KEEP;
    if (this.state.key === w.teamKey) return { commit: true }; // again, while its key was not yet on disk
    this.state.key = w.teamKey; this.key = null;
    if (w.teamName) this.state.teamName = clean(w.teamName, 80);
    if (this.rosterSigned) await this.takeRoster(this.rosterSigned);
    const later = this.later; this.later = [];
    for (const msg of later) await this.handle(msg);
    this.emit('welcome');
    this.flush();
    return { commit: true };
  },

  /** Keep an inbox item for when the key comes. It is not taken, so the relay keeps its copy and sends it again with the
   *  next hello: one copy per item, none past an action's age, and at most LATER_INBOX of them. */
  defer(msg) {
    const t = this.now();
    const kept = this.later.filter((x) => x.t === 'inbox' && x.item !== msg.item && t - (Number(x.at) || 0) <= ACT_TTL);
    this.later = [...this.later.filter((x) => x.t !== 'inbox'), ...kept.slice(-(LATER_INBOX - 1)), { t: 'inbox', item: msg.item, from: msg.from, blob: msg.blob, at: msg.at }];
  },

  async reply(to, re, status, text) {
    if (!this.people.get(to)) return true; // nobody left to tell
    const me = await this.member();
    const blob = await sealSigned(await this.teamKey(), me, { k: 'result', re, status, text, at: this.now() }, aad.send(this.state.team, me.id, to));
    return (await this.say({ t: 'send', to, blob, ttl: ACT_TTL })).t === 'ok';
  },

  /** A teammate's action on this dev's threads. Every check here holds before anything reaches T3. */
  async intake(sender, body) {
    const nonce = String(body.nonce || '');
    if (!isId(nonce)) return ACK;
    const seenKey = `${sender.id}:${nonce}`;
    const now = this.now();
    const answer = (status, text, ran) => ({
      commit: true,
      replies: [() => this.reply(sender.id, nonce, status, text)],
      // Not on disk: a refusal is forgotten, so the action is judged again; a result stays, so it never runs twice.
      undo: ran ? null : () => this.seen.delete(seenKey),
      after: () => this.emit('acted', { from: sender.id, name: sender.name, kind: body.action?.kind, thread: body.action?.thread, status, text }),
    });
    // A seen one gets its first answer again; nothing runs twice.
    const had = this.seen.get(seenKey);
    if (had) return { commit: true, replies: [() => this.reply(sender.id, nonce, had.status, had.text)] };
    // An id leaves only once its action is too old to run anyway, measured against the latest time this Mac has seen,
    // so a clock set forward and back again cannot drop an id and then take its action again. The time of the newest id
    // let go is kept: an action from then or before may be one of them, so it does not run.
    const high = Math.max(now, Number(this.state.clockHigh) || 0);
    this.state.clockHigh = high;
    for (const [k, v] of this.seen) {
      if (high - v.at < SEEN_KEEP_MS) continue;
      this.seen.delete(k);
      this.state.seenFloor = Math.max(Number(this.state.seenFloor) || 0, v.at);
    }
    // A full list refuses nothing and forgets nothing: the relay keeps the action, judged again once ids leave.
    if (this.seen.size >= SEEN_MAX) {
      this.emit('error', { text: 'Too many teammate actions in the last few minutes. The next one waits on the relay.' });
      return KEEP;
    }
    const action = body.action || {};
    const kind = String(action.kind || '');
    const thread = String(action.thread || '');
    // Every check, from what this Mac holds at time t. It runs again after the reservation is saved: a project dropped,
    // a role taken away or a board gone stale while it saved stops the action.
    const gate = (t) => {
      const at = Number(body.at);
      if (!Number.isFinite(at) || t - at > ACT_TTL || at - t > AUTH_SKEW_MS) return [409, 'Not run: that action is too old. Look again and send it fresh.'];
      if (at <= (Number(this.state.seenFloor) || 0) + AUTH_SKEW_MS) return [409, 'Not run: this teammate\'s Mac clock went back. Send it again once their clock is right.'];
      if (this.stopped || this.state.status !== 'member') return [409, 'Not run: this Mac is no longer on the team.'];
      const from = this.people.get(sender.id);
      if (!from) return [403, 'Not run: the sender is no longer on the team.'];
      if (!allows(from, kind)) return [403, refusal(from, kind)];
      if (!this.me || !shares(this.me.role)) return [409, 'Not run: this teammate shares no tickets.'];
      if (!this.run || !this.boardOf) return [409, 'Not checked: this teammate\'s Yes Chef cannot act yet.'];
      const b = this.boardOf();
      // A board read "later" than now means this Mac's clock went back: its age is unknown, so it is not fresh.
      if (!b?.ok || !b.board || !(b.at <= t) || t - b.at > BOARD_FRESH_MS) return [409, 'Not checked: this teammate\'s board is not fresh. Try again in a minute.'];
      // The thread must sit in a project this dev shares. A thread id from anywhere else is refused, whoever sends it.
      const ticket = b.board.tickets.find((k) => k.thread.threadId === thread || k.asks.some((a) => a.thread.threadId === thread));
      if (!ticket || !new Set(this.state.shared || []).has(ticket.thread.projectId)) return [409, 'Not run: that ticket is not on this teammate\'s shared board.'];
      return null;
    };
    const no = gate(now);
    if (no) { this.seen.set(seenKey, { at: now, status: no[0], text: no[1] }); return answer(...no, false); }
    // The reservation is on disk before T3 hears the action: if this Mac stops mid-run, the relay's copy that comes back
    // gets "not confirmed", never a second run. Not saved, nothing runs and nothing is answered.
    this.seen.set(seenKey, { at: now, status: 502, text: 'Not confirmed: this teammate\'s Yes Chef stopped while it ran the action. Check the thread before you send again.' });
    if (!(await this.saveNow())) {
      this.seen.delete(seenKey);
      this.emit('error', { text: 'Yes Chef could not save, so a teammate\'s action did not run. It runs on the next try once saving works.' });
      return KEEP;
    }
    const late = gate(this.now());
    if (late) { this.seen.set(seenKey, { at: now, status: late[0], text: late[1] }); return answer(...late, false); }
    let status, text;
    try {
      // The nonce T3 sees names the sender too, so one teammate's ids never collide with another's or with the dev's.
      const out = await this.run({ ...action, kind, thread, nonce: `t-${sender.id}-${nonce}` }, signature(this.people.get(sender.id)), { holds: this.holds, answered: this.answered });
      status = out?.status || 500; text = clean(out?.text || 'No answer.', 300);
    } catch (ex) { status = 502; text = `Not checked: T3 did not take it (${clean(ex?.message || ex, 120)}). Check the thread.`; }
    this.seen.set(seenKey, { at: now, status, text });
    return answer(status, text, true);
  },

  /** Send an action to a teammate's Yes Chef. Resolves with their answer: { status, text }. */
  async act(to, action) {
    const p = this.people.get(to);
    if (!p || to === this.meId) return { status: 400, text: 'That person is not on the team.' };
    if (!allows(this.me, action?.kind)) return { status: 403, text: refusal(this.me, action?.kind) };
    const me = await this.member();
    const nonce = newId();
    const body = { k: 'act', nonce, at: this.now(), action: { ...action } };
    const blob = await sealSigned(await this.teamKey(), me, body, aad.send(this.state.team, me.id, to));
    if (blob.length > this.limits.sendMax) return { status: 400, text: 'That note is too long to send.' };
    let got = null;
    const result = new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => {
        const unsure = this.out.get(nonce)?.unsure;
        this.out.delete(nonce);
        resolve(unsure
          ? { status: 504, text: 'Not confirmed: the relay may have taken it. Do not send it again: if it was taken, their Yes Chef runs it when it comes online, within 15 minutes.' }
          : { status: 504, text: 'Not checked: no answer from their Yes Chef yet. It runs the action when it comes online, within 15 minutes.' });
      }, ASK_MS * 2);
      this.out.set(nonce, { to, resolve: (r) => { got = r; resolve(r); }, timer });
    });
    const sent = await this.say({ t: 'send', to, blob, ttl: ACT_TTL });
    // Their answer can beat the relay's own: a known result wins over a missing ack.
    if (sent.t !== 'ok' && got) return got;
    // Sent, then the connection dropped or the relay's answer did not come: the relay may hold it, and it can still run.
    // Wait for their answer as for a taken send, and never say "Not sent".
    if (sent.code === 'timeout' || sent.code === 'closed') { const o = this.out.get(nonce); if (o) o.unsure = true; return result; }
    if (sent.t !== 'ok') { const o = this.out.get(nonce); this.timers.clearTimeout(o?.timer); this.out.delete(nonce); return { status: 503, text: sent.text }; }
    return result;
  },
};
