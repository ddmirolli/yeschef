// The Yes Chef relay: a Cloudflare Worker with one Durable Object per team (docs/team-relay-v0_1.md).
// Dan's ruling (2026-11-10, "A"): one Yes Chef relay on Cloudflare, free with a cap, and teams can host their own.
// Each team's object keeps its state in SQLite, so the relay runs on Cloudflare's free plan, and it holds its
// sockets with the hibernation API, so a quiet team costs no duration. The team's logic is relay/room.mjs.
//
//   POST   /v1/teams/:team        make a team: its first roster, signed by its lead
//   POST   /v1/teams/:team/join   ask to join, with the invite's proof
//   GET    /v1/teams/:team/ws     the team's socket (members, and devs waiting to be let in)
//   GET    /v1/teams/:team/me     what the relay knows of a member, when its socket keeps failing
//   DELETE /v1/teams/:team        the lead deletes the team and everything the relay keeps for it
//   GET    /v1/usage              each team's usage, for the relay's owner (needs USAGE_TOKEN)
import { DurableObject } from 'cloudflare:workers';
import { Room, usagePage } from './room.mjs';
import { isId } from '../client/seal.mjs';

const text = (status, body) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
const registry = (env) => env.REGISTRY.get(env.REGISTRY.idFromName('teams'));

export class Team extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // A ping gets its pong without waking the object, so a quiet team's sockets stay free.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.room = new Room({
      sql: ctx.storage.sql, env,
      sockets: {
        list: (m) => ctx.getWebSockets(m ? `m:${m}` : undefined),
        info: (ws) => ws.deserializeAttachment(),
        send: (ws, value) => ws.send(JSON.stringify(value)),
        close: (ws, code, reason) => { try { ws.close(code, reason); } catch { /* already closed */ } },
      },
      onCreate: (team, at) => registry(env).add(team, at),
      onDelete: async (team) => { await ctx.storage.deleteAlarm(); await ctx.storage.deleteAll(); await registry(env).remove(team); },
      // One alarm per team, at the next expiry: an idle team keeps nothing past its time.
      wakeAt: (at) => ctx.storage.getAlarm().then((cur) => (cur === null || at < cur ? ctx.storage.setAlarm(at) : null)).catch(() => {}),
    });
  }
  async alarm() { await this.room.alarm(); }
  async fetch(request) {
    const out = await this.room.fetch(request);
    if (!out.upgrade) return out;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [`m:${out.upgrade.m}`]);
    server.serializeAttachment(out.upgrade);
    this.room.opened(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, message) { return this.room.message(ws, message); }
  webSocketClose(ws) { this.room.closed(ws); }
  webSocketError(ws) { this.room.closed(ws); }
  usage(days) { return this.room.usage(days); }
}

/** The list of teams, so the relay's owner can read usage across them. It holds team ids and when they were made. */
export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, created INTEGER NOT NULL) WITHOUT ROWID');
  }
  add(id, created) { this.ctx.storage.sql.exec('INSERT INTO teams (id, created) VALUES (?, ?) ON CONFLICT(id) DO NOTHING', id, created); }
  /** One id, or a list of them in one call. */
  remove(ids) { for (const id of [].concat(ids)) this.ctx.storage.sql.exec('DELETE FROM teams WHERE id = ?', id); }
  list(after, limit) {
    return this.ctx.storage.sql.exec('SELECT id FROM teams WHERE id > ? ORDER BY id LIMIT ?', after || '', limit).toArray().map((r) => r.id);
  }
  count() { return this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM teams').one().n; }
}

/** The owner's token check: compare digests, so the time taken says nothing about the token. */
async function ownerAsks(request, env) {
  const want = String(env.USAGE_TOKEN || '');
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (want.length < 32 || !got) return false;
  const [a, b] = await Promise.all([want, got].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/' || url.pathname === '/healthz') return text(200, 'Yes Chef relay. It passes sealed team summaries and cannot read them.\n');
    if (parts[0] === 'v1' && parts[1] === 'teams' && isId(parts[2])) {
      // A body over the room's limit stops here, before it reaches the team's object (the room reads at most 64 KiB too).
      if (Number(request.headers.get('content-length')) > 65536) return text(413, 'That request is too large.\n');
      return env.TEAMS.get(env.TEAMS.idFromName(parts[2])).fetch(request);
    }
    if (url.pathname === '/v1/usage' && request.method === 'GET') {
      if (!(await ownerAsks(request, env))) return text(404, 'Not a relay address.\n');
      const page = await usagePage(registry(env), (id, days) => env.TEAMS.get(env.TEAMS.idFromName(id)).usage(days),
        { after: url.searchParams.get('after') || '', days: Number(url.searchParams.get('days')) || 7 });
      return new Response(JSON.stringify(page, null, 2),
        { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return text(404, 'Not a relay address.\n');
  },
};
