// The team client's connection: one socket to the relay, its hello, the heartbeat, and reconnects.
//
// Reconnects follow T3 Code's rules: one owner for retries, jittered backoff capped at five minutes, a probe on wake,
// and the socket's health kept apart from how fresh the data is.
import { newId, authToken, AUTH_SKEW_MS } from './seal.mjs';
import { shares } from './roles.mjs';
import { ASK_MS } from './team-common.mjs';

export const RETRY = { base: 1000, cap: 5 * 60000 };
export const PING_MS = 30000, PONG_MS = 10000;

export const connection = {
  start() {
    if (['declined', 'removed', 'ended'].includes(this.state.status)) { this.setLink('stopped'); return; }
    this.stopped = false;
    // A retry left waiting from before would fire over the connection this opens.
    this.timers.clearTimeout(this.retry); this.retry = null;
    this.connect();
  },

  stop() {
    this.stopped = true;
    this.attempt = (this.attempt || 0) + 1;
    this.timers.clearTimeout(this.retry); this.retry = null;
    this.timers.clearTimeout(this.summaryTimer); this.summaryTimer = null;
    this.stopBeat();
    const ws = this.ws; this.ws = null;
    try { ws?.close(1000, 'Yes Chef closed.'); } catch { /* already closed */ }
    this.dropAsks('Not sent: the team connection closed.');
    this.setLink('stopped');
  },

  /** The Mac woke or the network came back: probe now instead of waiting out the backoff. */
  wake() {
    if (this.stopped || this.link === 'stopped') return;
    if (this.link === 'waiting') { this.timers.clearTimeout(this.retry); this.retry = null; this.connect(); return; }
    if (this.link === 'online') this.ping();
  },

  async connect() {
    if (this.stopped || this.ws || this.link === 'connecting') return;
    this.setLink('connecting');
    // A stop() while this attempt waits on the keys makes it stale: it opens nothing, and a start() after the stop owns
    // the one socket.
    const attempt = this.attempt = (this.attempt || 0) + 1;
    let ws;
    try {
      const me = await this.member();
      this.meId = me.id;
      const path = `/v1/teams/${this.state.team}/ws`;
      const auth = await authToken(me, { team: this.state.team, method: 'GET', path, now: this.now() });
      if (this.stopped || attempt !== this.attempt) return;
      ws = this.net.socket(`${this.state.relay.replace(/^http/, 'ws')}${path}?auth=${encodeURIComponent(auth)}`);
    } catch { if (attempt === this.attempt) this.lost(1006); return; }
    this.ws = ws;
    let opened = false;
    // The relay's hello has a deadline, counted from when the socket is made: a socket that never opens, or opens and
    // never says hello, is retried, not kept connecting for ever.
    this.timers.setTimeout(() => {
      if (this.ws !== ws || this.link !== 'connecting') return;
      this.ws = null;
      this.stopBeat();
      try { ws.close(4000, 'No hello from the relay.'); } catch { /* already closed */ }
      this.lost(1006, opened);
    }, ASK_MS);
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      opened = true;
      this.startBeat();
    });
    ws.addEventListener('message', (ev) => { if (this.ws === ws) this.heard(ev.data, ws); });
    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopBeat();
      this.lost(ev.code, opened);
    });
  },

  dropAsks(text) {
    for (const [, a] of this.asks) { this.timers.clearTimeout(a.timer); a.resolve({ t: 'err', code: 'closed', text }); }
    this.asks.clear();
  },

  /** The socket closed. The relay's own codes say what to do; anything else is the network: back off and try again. */
  async lost(code, opened = false) {
    this.dropAsks('Not sent: the team connection dropped.');
    if (this.stopped) { this.setLink('stopped'); return; }
    if (code === 4001) { this.attempts = 0; this.setLink('off'); this.connect(); return; }
    if (code === 4002) return this.end('declined');
    if (code === 4003) return this.end('removed');
    if (code === 4004) return this.end('ended');
    // A socket that never opened shows no reason. After a few, ask the relay what it knows of this Mac.
    if (!opened && this.attempts >= 2) {
      // A stop() while the probe waits makes this loss stale: a start() after it owns the connection.
      const attempt = this.attempt;
      // The probe has a deadline: a relay that takes the request and never answers must not leave this Mac without a
      // retry.
      let timer;
      const why = await Promise.race([this.probe(), new Promise((r) => { timer = this.timers.setTimeout(() => r(null), ASK_MS); })]);
      this.timers.clearTimeout(timer);
      if (attempt !== this.attempt) return;
      if (this.stopped) { this.setLink('stopped'); return; }
      if (why) return this.end(why);
    }
    this.schedule();
  },

  /** What the relay knows of this member, when the socket cannot say: a status to end on, or null to keep trying. */
  async probe() {
    try {
      const me = await this.member();
      const path = `/v1/teams/${this.state.team}/me`;
      const signedAt = this.now();
      const auth = await authToken(me, { team: this.state.team, method: 'GET', path, now: signedAt });
      const res = await this.net.http('GET', `${this.state.relay}${path}`, undefined, { authorization: `YesChef ${auth}` });
      if (res.status === 404) return 'ended';
      if (res.status === 401) {
        // A Mac clock far off fails every token: say so, and keep trying, rather than call the dev removed. Measured
        // against the time the token was signed with, so a clock set right while the request was out is no removal.
        if (Number.isFinite(res.body?.now) && Math.abs(res.body.now - signedAt) > AUTH_SKEW_MS) { this.emit('clock', { off: res.body.now - signedAt }); return null; }
        if (Math.abs(this.now() - signedAt) > AUTH_SKEW_MS) return null;
        return this.state.status === 'pending' ? 'declined' : 'removed';
      }
    } catch { /* the network: keep trying */ }
    return null;
  },

  schedule() {
    if (this.stopped) return;
    // Full jitter on a doubling backoff, capped: many Macs that lost one relay do not come back at once.
    const ceil = Math.min(RETRY.cap, RETRY.base * 2 ** Math.min(this.attempts, 20));
    const ms = Math.max(RETRY.base / 2, Math.round(ceil * this.random()));
    this.attempts++;
    this.timers.clearTimeout(this.retry);
    this.setLink('waiting');
    this.retry = this.timers.setTimeout(() => { this.retry = null; this.setLink('off'); this.connect(); }, ms);
    this.retryMs = ms;
  },

  end(status) {
    this.state.status = status;
    if (status !== 'declined') this.state.key = null; // removed or ended: the team key goes with the team
    this.key = null;
    this.summaries.clear(); this.people.clear(); this.online.clear(); this.lastSeen.clear(); this.pending.clear(); this.invites.clear();
    this.save();
    this.stop();
    this.emit('status', { status });
  },

  /** Drop the socket and open a new one: the relay's hello brings the current team. */
  refresh() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null; this.stopBeat();
    try { ws.close(4000, 'Reading the team again.'); } catch { /* gone */ }
    this.lost(1006, true);
  },

  startBeat() {
    this.stopBeat();
    this.beat = this.timers.setInterval(() => this.ping(), PING_MS);
  },
  stopBeat() { this.timers.clearInterval(this.beat); this.beat = null; this.timers.clearTimeout(this.pongTimer); this.pongTimer = null; },
  ping() {
    // On the roster with no key: ask the lead again, at most once a day, so an ask that expired while the lead was away
    // is sent again without a reconnect.
    if (this.link === 'online' && this.state.status === 'member' && !this.state.key && !this.isLead) this.askKey().catch(() => {});
    if (!this.ws || this.pongTimer) return;
    try { this.ws.send('ping'); } catch { return; }
    // No pong in time: the socket is dead even if it never said so. Close it and let the retry owner take over.
    this.pongTimer = this.timers.setTimeout(() => { this.pongTimer = null; const ws = this.ws; if (ws) { this.ws = null; this.stopBeat(); try { ws.close(4000, 'No pong.'); } catch { /* gone */ } this.lost(1006, true); } }, PONG_MS);
  },

  /** A request over the socket; resolves with the relay's reply ({ t: 'ok' } or { t: 'err', code, text }). */
  say(msg) {
    return new Promise((resolve) => {
      if (!this.ws || this.link !== 'online') { resolve({ t: 'err', code: 'offline', text: 'Not sent: Yes Chef is not connected to the team.' }); return; }
      const id = newId();
      const timer = this.timers.setTimeout(() => { this.asks.delete(id); resolve({ t: 'err', code: 'timeout', text: 'The relay did not answer.' }); }, ASK_MS);
      this.asks.set(id, { resolve, timer });
      try { this.ws.send(JSON.stringify({ ...msg, id })); } catch { this.timers.clearTimeout(timer); this.asks.delete(id); resolve({ t: 'err', code: 'offline', text: 'Not sent: the team connection dropped.' }); }
    });
  },

  async heard(data, from = this.ws) {
    if (data === 'pong') { this.timers.clearTimeout(this.pongTimer); this.pongTimer = null; return; }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.id && this.asks.has(msg.id)) {
      const a = this.asks.get(msg.id); this.asks.delete(msg.id); this.timers.clearTimeout(a.timer); a.resolve(msg); return;
    }
    // One message at a time, in order: a roster must land before the summaries and actions that follow it. A message
    // whose socket was replaced while it waited is dropped: the new socket's hello brings it again, and an old hello
    // never marks a new socket online.
    this.chain = (this.chain || Promise.resolve()).then(() => (this.ws === from ? this.handle(msg) : undefined)).catch((ex) => this.emit('error', { text: String(ex?.message || ex) }));
    return this.chain;
  },

  async handle(msg) {
    switch (msg.t) {
      case 'hello': return this.hello(msg);
      case 'roster': return this.takeRoster(msg.roster);
      case 'summary': return this.takeSummary(msg.m, msg.blob);
      case 'gone': return this.takeGone(msg.m);
      case 'presence': return this.takePresence(msg);
      case 'inbox': return this.take(msg);
      case 'pending': return this.takePending(msg.pending);
      case 'pending-gone': return this.dropPending(msg.m);
      case 'invite': return this.takeInvite(msg.invite);
      case 'invite-gone': return this.dropInvite(msg.invite);
      case 'declined': return; // the close (4002) that follows ends it
      default: return;
    }
  },

  async hello(msg) {
    // Each await below can outlive its socket (stopped, or closed and replaced): then this hello goes no further, so a
    // stopped team never reads as online or takes its inbox.
    const ws = this.ws;
    const gone = () => this.stopped || this.ws !== ws;
    const me = await this.member();
    if (gone()) return;
    this.meId = me.id;
    // Pending is taken only by a Mac that is still pending. To a member, it is a relay skipping the signed roster.
    if (msg.role === 'pending' && this.state.status !== 'pending') {
      this.emit('error', { text: 'The relay called this Mac a pending member without a team list. Yes Chef stopped talking to it.' });
      this.stop();
      return;
    }
    if (msg.role === 'pending') { this.attempts = 0; this.setLink('online'); this.emit('team'); return; }
    const took = await this.takeRoster(msg.roster);
    if (took === 'removed' || gone()) return;
    if (!took) {
      // A roster the pinned lead did not sign, or an older one: this relay is not to be trusted with this team.
      this.emit('error', { text: 'The relay sent a team list the lead did not sign, or an older one. Yes Chef stopped talking to it.' });
      this.stop();
      return;
    }
    this.attempts = 0;
    this.takeHelloPresence(msg);
    this.limits = { ...this.limits, ...(msg.limits || {}) };
    this.summaries.clear(); this.invites.clear(); this.pending.clear(); this.later = [];
    // Online before the waiting messages: taking one is a request to the relay.
    this.setLink('online');
    if (this.state.status === 'pending') { this.state.status = 'member'; this.save(); this.emit('status', { status: 'member' }); }
    // Waiting messages first: the welcome among them carries the team key the rest need.
    for (const item of msg.inbox || []) { if (gone()) return; await this.take(item); }
    for (const s of msg.summaries || []) { if (gone()) return; await this.takeSummary(s.m, s.blob); }
    for (const inv of msg.invites || []) { if (gone()) return; await this.takeInvite(inv); }
    for (const p of msg.pending || []) { if (gone()) return; await this.takePending(p); }
    if (gone()) return;
    this.emit('team');
    if (this.isLead) await this.sendWelcomes();
    // On the roster, but no welcome came: it waited its 7 days on the relay unread. Ask the lead for another.
    else if (!this.state.key) await this.askKey();
    if (gone()) return;
    this.flushFails = 0;
    // The relay kept our last summary. A Viewer, or a dev who shares nothing now, has it dropped. A project dropped
    // before a restart, its replacement never taken: rebuild it from the board, or drop it until the board is read.
    const held = (msg.summaries || []).some((s) => s.m === this.meId);
    if (held && (!(this.me && shares(this.me.role)) || !this.state.shared?.length)) this.unshare();
    else if (held && this.state.dropped && !this.next) this.shareNow(new Set([null]));
    // A board read or failure reported before the roster loaded goes now: it was held until this Mac knew its role.
    else { this.publish(); this.flush(); }
  },
};
