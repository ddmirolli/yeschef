// The Yes Chef relay: a Cloudflare Worker with one Durable Object per team (docs/team-relay-v0_1.md).
// Dan's ruling (2026-11-10, "A"): one Yes Chef relay on Cloudflare, free with a cap, and teams can host their own.
// Each team's object keeps its state in SQLite, so the relay runs on Cloudflare's free plan, and it holds its
// sockets with the hibernation API, so a quiet team costs no duration. The team's logic is relay/room.ts.
//
//   POST   /v1/teams/:team        make a team: its first roster, signed by its lead
//   POST   /v1/teams/:team/join   ask to join, with the invite's proof
//   GET    /v1/teams/:team/ws     the team's socket (members, and devs waiting to be let in)
//   GET    /v1/teams/:team/me     what the relay knows of a member, when its socket keeps failing
//   DELETE /v1/teams/:team        the lead deletes the team and everything the relay keeps for it
//   GET    /v1/usage              each team's usage, for the relay's owner (needs USAGE_TOKEN)
import { DurableObject } from 'cloudflare:workers';
import { Room, usagePage, type RegistryRow, type RelayVars } from './room.ts';
import { readSocketInfo } from './messages.ts';
import { isId } from '../client/seal.ts';

/** The Worker's bindings and vars (wrangler.jsonc). USAGE_TOKEN is a secret, set with `wrangler secret put`. */
export interface Env extends RelayVars {
  TEAMS: DurableObjectNamespace<Team>;
  REGISTRY: DurableObjectNamespace<Registry>;
  USAGE_TOKEN?: string;
}

const text = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName('teams'));

export class Team extends DurableObject<Env> {
  room: Room<WebSocket>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A ping gets its pong without waking the object, so a quiet team's sockets stay free.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.room = new Room({
      sql: ctx.storage.sql, env,
      sockets: {
        list: (m) => ctx.getWebSockets(m ? `m:${m}` : undefined),
        // Kept across hibernation and deploys: read, not trusted. One the relay cannot read is a socket it does not know.
        info: (ws) => readSocketInfo(ws.deserializeAttachment()),
        send: (ws, value) => ws.send(JSON.stringify(value)),
        close: (ws, code, reason) => { try { ws.close(code, reason); } catch { /* already closed */ } },
      },
      onCreate: (team, at) => registry(env).add(team, at),
      onDelete: async (team, created) => { await ctx.storage.deleteAlarm(); await ctx.storage.deleteAll(); await registry(env).remove([{ id: team, created }]); },
      // One alarm per team, at the next expiry: an idle team keeps nothing past its time.
      wakeAt: (at) => ctx.storage.getAlarm().then((cur) => (cur === null || at < cur ? ctx.storage.setAlarm(at) : null)).catch(() => {}),
    });
  }
  override async alarm(): Promise<void> { await this.room.alarm(); }
  override async fetch(request: Request): Promise<Response> {
    const out = await this.room.fetch(request);
    if (!('upgrade' in out)) return out;
    // Checked again here, with nothing awaited before the accept: route() said yes a few steps ago.
    const up = this.room.admit(out.upgrade);
    if (!up) return new Response(JSON.stringify({ error: 'The relay does not know this member, or the sign-in token is old.' }), { status: 401, headers: { 'content-type': 'application/json; charset=utf-8' } });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server, [`m:${up.m}`]);
    server.serializeAttachment(up);
    this.room.opened(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> { return this.room.message(ws, message); }
  override webSocketClose(ws: WebSocket): void { this.room.closed(ws); }
  override webSocketError(ws: WebSocket): void { this.room.closed(ws); }
  usage(days: number) { return this.room.usage(days); }
}

/** The list of teams, so the relay's owner can read usage across them. It holds team ids and when they were made. */
export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, created INTEGER NOT NULL) WITHOUT ROWID');
  }
  /** A team made again under an id takes the new time, so a row listed before it was made again is told apart. */
  add(id: string, created: number): void { this.ctx.storage.sql.exec('INSERT INTO teams (id, created) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET created = excluded.created', id, created); }
  /** One id, or a list. An { id, created } leaves only if it is still that row. */
  remove(ids: string | RegistryRow | (string | RegistryRow)[]): void {
    for (const r of ([] as (string | RegistryRow)[]).concat(ids)) {
      if (typeof r === 'string') this.ctx.storage.sql.exec('DELETE FROM teams WHERE id = ?', r);
      else this.ctx.storage.sql.exec('DELETE FROM teams WHERE id = ? AND created = ?', String(r.id), Number(r.created));
    }
  }
  list(after: string, limit: number): RegistryRow[] {
    return this.ctx.storage.sql.exec<RegistryRow>('SELECT id, created FROM teams WHERE id > ? ORDER BY id LIMIT ?', after || '', limit).toArray().map((r) => ({ id: r.id, created: r.created }));
  }
  count(): number { return this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM teams').one().n; }
}

/** The owner's token check: compare digests, so the time taken says nothing about the token. */
async function ownerAsks(request: Request, env: Env): Promise<boolean> {
  const want = String(env.USAGE_TOKEN || '');
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (want.length < 32 || !got) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(want), digest(got)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
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
} satisfies ExportedHandler<Env>;
