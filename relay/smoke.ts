// A smoke test of a running relay, over real HTTP and WebSockets: make a team, invite, ask, approve, welcome, a summary,
// a sealed action, then delete the team. Every key is made here and thrown away; nothing touches a Yes Chef data folder.
//
//   node relay/smoke.ts http://127.0.0.1:8790        against `wrangler dev` (relay/README.md)
//   node relay/smoke.ts https://relay.example.com    against a deployed relay
import {
  newId, newMember, authToken, signRoster, newTeamKey, teamKey, seal, open, sealSigned, openSigned, sealTo, openFrom, aad,
  newInvite, readInvite, joinRequest, openJoin, type Member,
} from '../client/seal.ts';
import type { Answer, RelayMessage, RelayMessages } from './room.ts';

/** What a socket hears: the relay's messages, and the pong Cloudflare answers a ping with. */
type Heard = RelayMessage | { t: 'pong' };

const base = (process.argv[2] || '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) { console.error('Usage: node relay/smoke.ts <relay origin>'); process.exit(2); }
const team = newId();
const steps: [name: string, ok: boolean][] = [];
const step = (name: string, ok: boolean, detail = '') => { steps.push([name, ok]); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) throw new Error(name); };

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? null : JSON.stringify(body) });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, body: json ?? text };
}
/** A socket that queues what it hears, and say(), which waits for the reply with the same id. */
async function socket(member: Member) {
  const path = `/v1/teams/${team}/ws`;
  const auth = await authToken(member, { team, method: 'GET', path });
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}${path}?auth=${encodeURIComponent(auth)}`);
  type Waiter = { match: (m: Heard) => boolean; resolve: (m: Heard) => void };
  const heard: Heard[] = [], waiters: Waiter[] = [];
  ws.addEventListener('message', (e) => {
    // The relay sends text frames only.
    const m: Heard = e.data === 'pong' ? { t: 'pong' } : JSON.parse(e.data as string);
    heard.push(m);
    for (const w of [...waiters]) if (w.match(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.addEventListener('close', (e) => r({ code: e.code, reason: e.reason })));
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', () => reject(new Error('socket failed to open'))); });
  /** The first message that matches, kept or still to come. A type guard types what it gives back. */
  function wait<T extends Heard>(match: (m: Heard) => m is T, ms?: number): Promise<T>;
  function wait(match: (m: Heard) => boolean, ms?: number): Promise<Heard>;
  function wait(match: (m: Heard) => boolean, ms = 5000): Promise<Heard> {
    const seen = heard.find(match);
    if (seen) { heard.splice(heard.indexOf(seen), 1); return Promise.resolve(seen); }
    return new Promise((resolve, reject) => { const w: Waiter = { match, resolve }; waiters.push(w); setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error('no answer in time')); } }, ms); });
  }
  let n = 0;
  // Only the room's answers carry the id a message was sent with.
  const say = (v: Record<string, unknown>) => { const id = `s${++n}`; ws.send(JSON.stringify({ ...v, id })); return wait((m): m is Answer => 'id' in m && m.id === id); };
  return { ws, closed, wait, say };
}

const lead = await newMember();
const raw = newTeamKey(), key = await teamKey(raw);
const people = [{ m: lead, name: 'Smoke Lead', role: 'lead' }];
let ver = 0;
async function roster() {
  ver++;
  const detail = await seal(key, Object.fromEntries(people.map((p) => [p.m.id, { name: p.name, role: p.role }])), aad.detail(team, ver));
  return signRoster(lead, { team, ver, lead: lead.id, at: Date.now(), members: people.map((p) => ({ id: p.m.id, sign: p.m.signPub, dh: p.m.dhPub })), detail });
}

try {
  const health = await http('GET', '/healthz');
  step('the relay answers', health.status === 200);
  const made = await http('POST', `/v1/teams/${team}`, { roster: await roster() });
  step('the lead makes a team', made.status === 201, `HTTP ${made.status}`);
  const L = await socket(lead);
  const hello = await L.wait((m) => m.t === 'hello');
  step('the lead\'s socket opens with a hello', hello.role === 'member' && hello.ver === 1);
  const inv = await newInvite({ relay: base, team, lead, leadName: 'Smoke Lead' });
  const box = await seal(key, { secret: inv.secret }, aad.invite(team, inv.record.invite));
  step('the lead opens an invite', (await L.say({ t: 'invite', invite: inv.record.invite, verifier: inv.record.verifier, until: inv.record.until, box })).t === 'ok');

  const dev = await newMember();
  const asked = await http('POST', `/v1/teams/${team}/join`, await joinRequest(readInvite(inv.link)!, dev, { name: 'Smoke Dev' }));
  step('the dev asks to join with the link', asked.status === 202, `HTTP ${asked.status}`);
  const pending = (await L.wait((m) => m.t === 'pending')).pending;
  const ask = (await openJoin(inv.secret, { team, ...pending })) as { name: string };
  step('the lead reads the ask', ask.name === 'Smoke Dev');
  const P = await socket(dev);
  step('the dev waits on a pending socket', (await P.wait((m) => m.t === 'hello')).role === 'pending');

  people.push({ m: dev, name: 'Smoke Dev', role: 'engineer' });
  step('the lead approves with a new roster', (await L.say({ t: 'roster', roster: await roster() })).t === 'ok');
  const welcome = await sealTo(lead, dev.dhPub, { teamKey: raw }, aad.welcome(team, lead.id, dev.id));
  step('the lead seals the team key to the dev', (await L.say({ t: 'send', to: dev.id, blob: welcome, ttl: 86400000 })).t === 'ok');
  const closedAs = await P.closed;
  step('the pending socket closes to reconnect', closedAs.code === 4001, `code ${closedAs.code}`);

  const D = await socket(dev);
  const dh = await D.wait((m) => m.t === 'hello' && m.role === 'member');
  const got = (await openFrom(dev, lead.dhPub, dh.inbox[0]!.blob, aad.welcome(team, lead.id, dev.id))) as { teamKey: string };
  step('the dev opens the welcome and has the team key', got.teamKey === raw);
  const dkey = await teamKey(got.teamKey);
  const names = (await open(dkey, (JSON.parse(dh.roster.body) as { detail: string }).detail, aad.detail(team, 2))) as Record<string, { role: string }>;
  step('the dev reads its own role', names[dev.id]?.role === 'engineer');
  await D.say({ t: 'done', item: dh.inbox[0]!.item });

  const sum = await sealSigned(dkey, dev, { threads: [{ title: 'Smoke thread', stage: 'In progress' }] }, aad.summary(team, dev.id));
  step('the dev sends a sealed summary', (await D.say({ t: 'summary', blob: sum })).t === 'ok');
  const heard = await L.wait((m) => m.t === 'summary');
  const opened = (await openSigned(key, heard.blob, aad.summary(team, dev.id), dev.signPub)) as { threads: { title: string }[] };
  step('the lead hears it and opens it', opened.threads[0]?.title === 'Smoke thread');
  const slow = await D.say({ t: 'summary', blob: sum });
  step('a second summary right after is held back', slow.code === 'slow', `retry after ${slow.retryAfter} ms`);

  const action = await sealSigned(key, lead, { kind: 'reply', thread: 'x', note: 'smoke', nonce: newId(), at: Date.now() }, aad.send(team, lead.id, dev.id));
  await L.say({ t: 'send', to: dev.id, blob: action });
  const item = await D.wait((m) => m.t === 'inbox');
  const act = (await openSigned(dkey, item.blob, aad.send(team, item.from, dev.id), lead.signPub)) as { kind: string };
  step('a sealed action reaches the dev, signed by the lead', act.kind === 'reply' && item.from === lead.id);

  L.ws.send('ping');
  step('a ping gets its pong without the room', (await L.wait((m) => m.t === 'pong')).t === 'pong');

  D.ws.close(1000, 'Smoke: the dev goes.');
  const off = await L.wait((m): m is RelayMessages['presence'] => m.t === 'presence' && m.m === dev.id && m.on === false);
  step('the lead hears the dev go, with the relay\'s time', Number.isFinite(off.at));
  const L2 = await socket(lead);
  const again = await L2.wait((m) => m.t === 'hello');
  step('a new hello lists when the relay last saw the dev', again.role === 'member' && again.seen[dev.id] === off.at);
  L2.ws.close(1000, 'Smoke done.');
} finally {
  const path = `/v1/teams/${team}`;
  const tok = await authToken(lead, { team, method: 'DELETE', path });
  const del = await http('DELETE', path, undefined, { authorization: `YesChef ${tok}` });
  console.log(`${del.status === 200 ? 'pass' : 'FAIL'}  the lead deletes the team  (HTTP ${del.status})`);
  setTimeout(() => process.exit(steps.every(([, ok]) => ok) && del.status === 200 ? 0 : 1), 100);
}
