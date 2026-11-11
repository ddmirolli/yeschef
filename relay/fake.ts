// A relay room in Node, for tests: Cloudflare's SQL API over node:sqlite, and sockets that keep what they hear.
// The real thing runs under `wrangler dev` (relay/README.md); this lets the tests run without the Workers runtime.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Room, type Answer, type Hello, type RelayMessage, type RelayMessages, type RelayVars, type SocketInfo, type Sql } from './room.ts';

type Row = Record<string, unknown>;
/** What exec() gives back: Cloudflare's cursor, plus one() as the tests use it. */
export interface FakeCursor { toArray(): Row[]; one(): Row; rowsWritten: number }
export interface FakeSql extends Sql { db: DatabaseSync; exec(query: string, ...bindings: unknown[]): FakeCursor }

const WRITES = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
/** Cloudflare's ctx.storage.sql: exec(query, ...bindings) -> { toArray(), one(), rowsWritten }. */
export function fakeSql(): FakeSql {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    exec(query, ...bindings) {
      // The room binds only what SQLite takes: strings, numbers and nulls.
      const rows: Row[] = db.prepare(query).all(...(bindings as SQLInputValue[])).map((r) => ({ ...r }));
      const rowsWritten = WRITES.test(query) ? Number(db.prepare('SELECT changes() AS n').get()!.n) : 0;
      return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('expected one row'); return rows[0]!; }, rowsWritten };
    },
  };
}

/** A socket the fake room opened. It keeps what it hears, as JSON gives it back. */
export interface FakeSocket {
  info: SocketInfo;
  heard: RelayMessage[];
  closed: { code: number; reason: string } | null;
  onheard: ((value: RelayMessage) => void) | undefined;
  onclosed: ((code: number, reason: string) => void) | undefined;
  /** Send a message and give back the last thing the socket heard: the room's answer, unless it closed the socket. */
  say(value: Record<string, unknown>): Promise<Answer>;
  /** The last message of this type the socket heard, or null. */
  last<T extends keyof RelayMessages>(t: T): RelayMessages[T] | null;
  drain(): RelayMessage[];
}
/** What the relay's HTTP answers carry (relay/room.ts and docs/team-relay-v0_1.md). */
export interface RelayBody { error?: string; now?: number; m?: string; role?: 'member' | 'pending'; deleted?: string; team?: string; ver?: number; until?: number }
/** A refused socket: the status and body of the HTTP answer the upgrade got. */
export interface Refusal { status: number; body: RelayBody }
export type Connected = FakeSocket | Refusal;
export type MemberHello = Extract<Hello, { role: 'member' }>;

/** The socket, or a test failure that says why the relay refused it. */
export function opened(c: Connected): FakeSocket {
  if ('status' in c) throw new Error(`The relay refused the socket: ${c.status} ${c.body.error ?? ''}`);
  return c;
}
/** The refusal, or a test failure if the socket opened. */
export function refused(c: Connected): Refusal {
  if (!('status' in c)) throw new Error('The socket opened.');
  return c;
}
/** The member hello a socket heard last, or a test failure if it heard none or a waiting dev's hello. */
export function memberHello(ws: FakeSocket): MemberHello {
  const h = ws.last('hello');
  if (h?.role !== 'member') throw new Error('The socket heard no member hello.');
  return h;
}

export interface FakeRelayOptions {
  env?: RelayVars;
  start?: number;
  register?: ((team: string, at: number) => unknown) | null;
  wipe?: ((team: string) => unknown) | null;
  unregister?: ((team: string, created: number) => unknown) | null;
}
export interface FakeRelay {
  room: Room<FakeSocket>;
  sql: FakeSql;
  created: [team: string, at: number][];
  deleted: string[];
  alarms: number[];
  base: string;
  now(): number;
  tick(ms: number): void;
  /** HTTP to the room, as the Worker would pass it. */
  http(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: RelayBody }>;
  /** Open a socket. Gives back { status, body } on a refusal, else the socket. hooks: { heard(value), closed(code, reason) }
   *  hear what the relay sends as it sends it, for a client that runs on its own (the app's team client). */
  connect(path: string, hooks?: { heard?: (value: RelayMessage) => void; closed?: (code: number, reason: string) => void }): Promise<Connected>;
  close(ws: FakeSocket, code?: number, reason?: string): void;
  sockets(): FakeSocket[];
}

/** A room with a clock you move by hand, and a connect() that opens a socket the way the Worker does. */
export function fakeRelay({ env = {}, start = Date.UTC(2026, 10, 10, 12), register = null, wipe = null, unregister = null }: FakeRelayOptions = {}): FakeRelay {
  let clock = start;
  const open = new Set<FakeSocket>();
  const sql = fakeSql();
  const created: [string, number][] = [], deleted: string[] = [], alarms: number[] = [];
  const room = new Room<FakeSocket>({
    sql, env, now: () => clock, wakeAt: (at) => { alarms.push(at); },
    sockets: {
      list: (m) => [...open].filter((ws) => !m || ws.info.m === m),
      info: (ws) => ws.info,
      send: (ws, value) => { if (ws.closed) throw new Error('closed'); const v = JSON.parse(JSON.stringify(value)) as RelayMessage; ws.heard.push(v); ws.onheard?.(v); },
      close: (ws, code, reason) => { if (!ws.closed) { ws.closed = { code, reason }; open.delete(ws); room.closed(ws); ws.onclosed?.(code, reason); } },
    },
    // register(team, at): the Worker's registry call, so a test can make it fail.
    onCreate: async (team, at) => { if (register) await register(team, at); created.push([team, at]); },
    // In the Worker's order: storage goes, then the registry row. wipe(team) runs first, so a test can make the delete
    // fail before anything goes; unregister(team, created) is the registry call.
    onDelete: async (team, created) => {
      if (wipe) await wipe(team);
      // Every table, as the Worker's storage.deleteAll() does: a table added later is never left behind.
      for (const { name } of sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()) sql.exec(`DROP TABLE IF EXISTS ${name as string}`);
      deleted.push(team);
      if (unregister) await unregister(team, created);
    },
  });
  const base = 'https://relay.test';
  const relay: FakeRelay = {
    room, sql, created, deleted, alarms, base,
    now: () => clock,
    tick(ms) { clock += ms; },
    async http(method, path, body, headers = {}) {
      const res = await room.fetch(new Request(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body) }));
      if (!(res instanceof Response)) throw new Error('That request opened a socket. Use connect().');
      return { status: res.status, body: (await res.json()) as RelayBody };
    },
    async connect(path, hooks = {}) {
      const out = await room.fetch(new Request(base + path, { headers: { upgrade: 'websocket' } }));
      if (out instanceof Response) return { status: out.status, body: (await out.json()) as RelayBody };
      // As the Worker does: the role read again, with no wait before the socket opens.
      const up = room.admit(out.upgrade);
      if (!up) return { status: 401, body: { error: 'The relay does not know this member, or the sign-in token is old.' } };
      const ws: FakeSocket = { info: up, heard: [], closed: null, onheard: hooks.heard, onclosed: hooks.closed,
        // The room answers each message with its last send, so the last thing heard is the answer.
        say: async (value) => { await room.message(ws, JSON.stringify(value)); return ws.heard[ws.heard.length - 1] as Answer; },
        last: <T extends keyof RelayMessages>(t: T) => ([...ws.heard].reverse().find((x) => x.t === t) as RelayMessages[T] | undefined) || null,
        drain: () => ws.heard.splice(0) };
      open.add(ws);
      room.opened(ws);
      return ws;
    },
    close(ws, code = 1000, reason = '') { if (!ws.closed) { ws.closed = { code, reason }; open.delete(ws); room.closed(ws); ws.onclosed?.(code, reason); } },
    sockets: () => [...open],
  };
  return relay;
}

/** The events a fake network socket fires, as a browser WebSocket fires them. */
export interface NetEvents { open: Record<string, never>; message: { data: string }; close: { code: number; reason: string } }
type Listener<K extends keyof NetEvents> = (ev: NetEvents[K]) => void;
/** A WebSocket as the team client uses one. cut() drops it the way a lost network does. */
export interface FakeNetSocket {
  readonly readyState: number;
  addEventListener<K extends keyof NetEvents>(type: K, fn: Listener<K>): void;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  cut(): void;
}
export interface FakeNet {
  down: boolean;
  http(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: RelayBody }>;
  socket(url: string): FakeNetSocket;
  open: Set<FakeNetSocket>;
  drop(): void;
}

/** The relay as a team client sees it over the network: fetch and a WebSocket, both async, as in the app.
 *  drop() cuts every socket the way a lost network does (close 1006). down = true refuses new ones. */
export function fakeNet(relay: FakeRelay): FakeNet {
  const net: FakeNet = {
    down: false,
    async http(method, url, body, headers = {}) {
      if (net.down) throw new Error('network down');
      const u = new URL(url);
      return relay.http(method, u.pathname + u.search, body, headers);
    },
    socket(url) {
      const u = new URL(url);
      const listeners: { [K in keyof NetEvents]: Listener<K>[] } = { open: [], message: [], close: [] };
      const fire = <K extends keyof NetEvents>(type: K, ev: NetEvents[K]) => { for (const fn of listeners[type] as Listener<K>[]) fn(ev); };
      let ws: FakeSocket | null = null, state = 0;
      const sock: FakeNetSocket = {
        get readyState() { return state; },
        // An event type the client does not know is dropped, as before.
        addEventListener: (type, fn) => { (listeners[type] as Listener<typeof type>[] | undefined)?.push(fn); },
        send(text) {
          if (state !== 1) throw new Error('not open');
          // Cloudflare answers a ping itself, without the room (setWebSocketAutoResponse).
          if (text === 'ping') { setImmediate(() => state === 1 && fire('message', { data: 'pong' })); return; }
          setImmediate(() => { if (state === 1 && ws && !ws.closed) void relay.room.message(ws, text); });
        },
        close(code = 1000, reason = '') { if (state < 2) { state = 2; setImmediate(() => { if (ws) relay.close(ws, code, reason); else end(code, reason); }); } },
        cut: () => { if (ws) { const w = ws; ws = null; relay.close(w, 1006, ''); } end(1006, ''); },
      };
      const end = (code: number, reason: string) => { if (state === 3) return; state = 3; setImmediate(() => fire('close', { code, reason })); };
      net.open.add(sock);
      setImmediate(async () => {
        if (net.down || state !== 0) { end(1006, ''); return; }
        const out = await relay.connect(u.pathname + u.search, {
          heard: (v) => { const text = JSON.stringify(v); setImmediate(() => state === 1 && fire('message', { data: text })); },
          closed: (code, reason) => { net.open.delete(sock); end(code, reason); },
        });
        // A refused upgrade shows the client no status, as in a browser: an abnormal close.
        if ('status' in out) { end(1006, ''); return; }
        ws = out;
        if (state !== 0) { relay.close(ws, 1000, ''); return; }
        state = 1;
        fire('open', {});
        // The relay may have spoken already (the hello): the hooks queued it behind this open.
      });
      return sock;
    },
    open: new Set(),
    drop() { for (const s of [...net.open]) s.cut(); net.open.clear(); },
  };
  return net;
}
