#!/usr/bin/env node
// Spike 1A (Dan, 2026-11-08): can a READ-ONLY T3 Code pairing get T3 Code's own live shell stream?
//
// Steps: mint a 5-minute pairing code limited to `orchestration:read` with T3 Code's CLI, swap it for
// a session token, read the shell over HTTP, open T3 Code's WebSocket, subscribe to the shell, listen,
// try one write that cannot do harm (force-stop a thread that does not exist), then revoke the session.
// The token and the pairing code stay in memory and are never printed.
//
// Protocol read from T3 Code v0.1.7 (latest stable, 2026-11-04), MIT, T3 Tools Inc.:
//   packages/client-runtime/src/authorization/remote.ts, packages/contracts/src/{auth,environment,
//   environmentHttp,orchestrationV2,rpc}.ts, apps/server/src/auth/RpcAuthorization.ts.
//   Socket messages are Effect RPC JSON: Request / Chunk + Ack / Exit / Ping / Pong.
//
// Usage: node spikes/t3-live-stream-spike.ts [t3-origin] [listen-seconds]
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** One socket message (Effect RPC JSON), as far as the spike reads it. */
interface Frame { _tag: string; requestId?: string; values?: ShellValue[]; exit?: unknown }
/** One value of a shell Chunk. */
interface ShellValue { kind: string; sequence?: unknown; thread?: { updatedAt?: string } }
/** One row of `t3 auth session list --json`. */
interface SessionRow { sessionId?: string; id?: string }

const origin = process.argv[2] || 'http://127.0.0.1:3773';
const listenMs = (Number(process.argv[3]) || 60) * 1000;
const LABEL = `Yes Chef live stream spike ${randomUUID().slice(0, 8)}`;
const T3 = `${process.env.HOME}/.t3/bin/t3`;
const now = () => performance.now();
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const line = (tag: string, name: string, detail = '') => console.log(`${tag.padEnd(5)} ${name}${detail ? `  ${detail}` : ''}`);
const pass = (name: string, detail?: string) => line('PASS', name, detail);
// A failed check sets a failing exit code but lets the run go on to the cleanup at the end.
const fail = (name: string, detail?: string) => { process.exitCode = 1; line('FAIL', name, detail); };
const info = (name: string, detail?: string) => line('INFO', name, detail);

// Ctrl-C or SIGTERM stops the run but still goes through the revoke below. A second Ctrl-C quits at once.
let interrupted: string | null = null;
let stopRun: (sig: string) => void;
const stopped = new Promise<string>((resolve) => { stopRun = resolve; });
const onSignal = (sig: NodeJS.Signals) => { interrupted = sig; info('Stopping', `${sig}: revoking the session first`); stopRun(sig); };
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);
const guard = () => { if (interrupted) throw new Error(`stopped by ${interrupted}`); };

let token: string | null = null;
let ws: WebSocket | null = null;
try {
  // 1. A pairing code that can only read.
  const issued = JSON.parse(execFileSync(T3, ['auth', 'pairing', 'create', '--json', '--ttl', '5m', '--label', LABEL,
    '--scope', 'orchestration:read'], { encoding: 'utf8' })) as { credential?: unknown };
  if (typeof issued.credential !== 'string') throw new Error('t3 auth pairing create returned no credential');
  pass('Pairing code minted', `fields: ${Object.keys(issued).filter((k) => k !== 'credential').join(', ')}`);

  guard();
  // 2. Swap it for a session token (OAuth token exchange, form-encoded).
  let t0 = now();
  const tr = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: issued.credential,
      subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'orchestration:read',
      client_label: LABEL,
    }),
  });
  const tok = await tr.json().catch(() => ({})) as { access_token?: unknown; scope?: string; token_type?: string; expires_in: number };
  if (!tr.ok || typeof tok.access_token !== 'string') throw new Error(`token exchange: ${tr.status} ${JSON.stringify(tok).slice(0, 200)}`);
  token = tok.access_token;
  (tok.scope === 'orchestration:read' ? pass : fail)('Token exchange', `${tr.status}, ${(now() - t0).toFixed(0)} ms, ${tok.token_type}, scope "${tok.scope}", lasts ${Math.round(tok.expires_in / 60)} min`);
  const auth = { authorization: `Bearer ${token}` };

  const sr = await fetch(`${origin}/api/auth/session`, { headers: auth });
  const ss = await sr.json().catch(() => ({})) as { authenticated?: boolean; scopes?: string[]; sessionMethod?: string };
  info('Session', `authenticated ${ss.authenticated}, scopes ${JSON.stringify(ss.scopes)}, method ${ss.sessionMethod}`);

  guard();
  // 3. The whole shell over plain HTTP, five times.
  const times: number[] = []; let bytes = 0; let snap: { threads?: unknown[]; projects?: unknown[] } | null = null;
  for (let i = 0; i < 5; i++) {
    t0 = now();
    const r = await fetch(`${origin}/api/orchestration/shell?omitIdleSubagents=true&omitOlderSettled=true`, { headers: { ...auth, 'x-t3-orchestration-protocol': '2' } });
    const text = await r.text(); times.push(now() - t0); bytes = text.length;
    if (!r.ok) { fail('HTTP shell snapshot', `${r.status} ${text.slice(0, 200)}`); break; }
    snap = JSON.parse(text);
  }
  if (snap) pass('HTTP shell snapshot', `median ${median(times).toFixed(0)} ms of 5 (${times.map((t) => t.toFixed(0)).join(', ')}), ${kb(bytes)}, ${snap.threads?.length ?? '?'} threads, ${snap.projects?.length ?? '?'} projects`);

  guard();
  // 4. A one-time socket ticket, then T3 Code's own WebSocket.
  const kr = await fetch(`${origin}/api/auth/websocket-ticket/rpc`, { method: 'POST', headers: auth });
  const kt = await kr.json().catch(() => ({})) as { ticket?: unknown; expiresAt?: string };
  // Throw, never exit: the session already exists, and only the finally block below revokes it.
  if (!kr.ok || typeof kt.ticket !== 'string') throw new Error(`socket ticket: ${kr.status}`);
  pass('Socket ticket', `${kr.status}, expires ${kt.expiresAt}`);

  const url = new URL('/ws', origin.replace(/^http/, 'ws'));
  url.searchParams.set('wsTicket', kt.ticket);
  url.searchParams.set('orchestrationProtocol', '2');
  t0 = now();
  ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws!.onopen = resolve; ws!.onerror = () => reject(new Error('socket error')); });
  pass('Socket open', `${(now() - t0).toFixed(0)} ms`);

  const send = (m: unknown) => ws!.send(JSON.stringify(m));
  const pending = new Map<string, (m: Frame) => void>();
  const counts: Record<string, number> = {};
  const lags: number[] = [];
  let snapshotAt = null as number | null; let synchronizedAt = null as number | null; let firstFrameBytes = 0; let lastDelta = null as { sequence: unknown; ageMs: number | null } | null;
  const tSub = now();
  ws.onmessage = (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
    const parsed = JSON.parse(raw) as Frame | Frame[];
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      if (m._tag === 'Ping') { send({ _tag: 'Pong' }); continue; }
      if (m._tag === 'Chunk') {
        send({ _tag: 'Ack', requestId: m.requestId });
        for (const v of m.values ?? []) {
          counts[v.kind] = (counts[v.kind] ?? 0) + 1;
          if (v.kind === 'snapshot' && snapshotAt === null) { snapshotAt = now(); firstFrameBytes = raw.length; }
          if (v.kind === 'synchronized' && synchronizedAt === null) synchronizedAt = now();
          if (v.kind === 'thread.updated' && snapshotAt !== null) {
            const at = Date.parse(v.thread?.updatedAt ?? '');
            if (Number.isFinite(at)) lags.push(Date.now() - at);
            lastDelta = { sequence: v.sequence, ageMs: Number.isFinite(at) ? Date.now() - at : null };
          }
        }
        continue;
      }
      if (m._tag === 'Exit') { pending.get(m.requestId!)?.(m); pending.delete(m.requestId!); continue; }
      counts[`frame:${m._tag}`] = (counts[`frame:${m._tag}`] ?? 0) + 1;
    }
  };
  ws.onclose = (ev) => info('Socket closed', `code ${ev.code}${ev.reason ? `, ${ev.reason}` : ''}`);
  const socketClosed = new Promise<string>((resolve) => ws!.addEventListener('close', (ev) => resolve(`socket closed, code ${ev.code}`)));
  const request = (id: string, tag: string, payload: unknown) => new Promise<Frame>((resolve) => { pending.set(id, resolve); send({ _tag: 'Request', id, tag, payload, headers: [] }); });

  guard();
  // 5. Subscribe to the shell: one snapshot, then only changes.
  const sub = request('1', 'orchestration.subscribeShell', { omitIdleSubagents: true, omitOlderSettled: true });
  const early = await Promise.race([sub, new Promise<null>((r) => setTimeout(() => r(null), 10000))]);
  if (early) fail('Shell subscription', `ended at once: ${JSON.stringify(early.exit).slice(0, 300)}`);
  else if (snapshotAt !== null) pass('Shell subscription', `snapshot after ${(snapshotAt - tSub).toFixed(0)} ms (${kb(firstFrameBytes)} frame)${synchronizedAt ? `, synchronized after ${(synchronizedAt - tSub).toFixed(0)} ms` : ''}`);
  else fail('Shell subscription', 'no snapshot within 10 s');

  guard();
  // 6. One write that cannot do harm: force-stop a thread that does not exist. Read-only should refuse it.
  const probe = await Promise.race([
    request('2', 'orchestration.forceStopThread', { threadId: `yeschef-spike-no-such-thread-${randomUUID()}` }),
    new Promise<null>((r) => setTimeout(() => r(null), 10000)),
  ]);
  const probeText = probe ? JSON.stringify(probe.exit) : 'no answer in 10 s';
  const refused = /scope|permission|authoriz|forbidden/i.test(probeText);
  (refused ? pass : fail)('Write refused for read-only', probeText.slice(0, 260));

  guard();
  // 7. Listen for live changes. The stream must stay up the whole time: an early end is a failure.
  info('Listening', `${listenMs / 1000} s for live changes`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const endedEarly = await Promise.race([
    new Promise<null>((r) => { timer = setTimeout(() => r(null), listenMs); }),
    sub.then((m) => `subscription ended: ${JSON.stringify(m.exit).slice(0, 200)}`),
    socketClosed,
    stopped.then((sig) => `stopped by ${sig}`),
  ]);
  clearTimeout(timer);
  if (endedEarly) fail('Live stream', `ended early: ${endedEarly}`);
  const deltas = Object.entries(counts).filter(([k]) => k !== 'snapshot' && k !== 'synchronized');
  (deltas.length && !endedEarly ? pass : info)('Live changes', `${JSON.stringify(Object.fromEntries(deltas))}${lags.length ? `; thread updatedAt to arrival: median ${median(lags)} ms, max ${Math.max(...lags)} ms over ${lags.length}` : ''}${lastDelta ? `; last sequence ${lastDelta.sequence}` : ''}`);
} catch (error) {
  fail('Spike stopped', (error as Error | null)?.message ?? String(error));
} finally {
  try { ws?.close(); } catch {}
  // 8. Revoke the spike's session, then prove the token is dead.
  try {
    const listed = JSON.parse(execFileSync(T3, ['auth', 'session', 'list', '--json'], { encoding: 'utf8' })) as SessionRow[] | { sessions?: SessionRow[]; items?: SessionRow[] };
    const rows = (Array.isArray(listed) ? listed : listed.sessions ?? listed.items ?? []).filter((s) => JSON.stringify(s).includes(LABEL));
    for (const s of rows) {
      const id = s.sessionId ?? s.id;
      if (id) execFileSync(T3, ['auth', 'session', 'revoke', String(id)], { encoding: 'utf8' });
    }
    info('Session revoked', `${rows.length} session(s) labelled for this run`);
    if (token) {
      const r = await fetch(`${origin}/api/auth/session`, { headers: { authorization: `Bearer ${token}` } });
      const s = await r.json().catch(() => ({})) as { authenticated?: boolean };
      (r.status === 401 || s.authenticated === false ? pass : fail)('Token dead after revoke', `${r.status}, authenticated ${s.authenticated}`);
    }
  } catch (error) {
    fail('Revoke', (error as Error | null)?.message ?? String(error));
  }
  token = null;
  if (interrupted) process.exitCode = 1;
}
