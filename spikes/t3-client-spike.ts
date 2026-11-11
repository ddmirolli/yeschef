// S0 of docs/pass-product-brief-v1_0.md: can the Pass work as an outside T3 client?
// Node 24 standard library only. Run: node spikes/t3-client-spike.ts [environment-origin]
// It registers an OAuth client with T3, prints the sign-in link for Dan to approve, then reads,
// polls, waits, and answers one question in a scratch thread it starts. The token stays in memory.
// The report goes to stdout and to report.json in a private folder made for this run (mode 700), without the token.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What a tools/call or another request returns, as far as the spike reads it. */
interface McpResult {
  structuredContent?: unknown;
  content?: { text?: string }[];
  isError?: boolean;
  serverInfo?: unknown;
  capabilities?: Record<string, unknown>;
  tools?: { name: string }[];
}
/** One JSON-RPC message from the server. */
interface RpcMessage { id?: number; result?: McpResult; error?: unknown }
/** A request's outcome: a notification has only its time. */
interface Rpc { ms: number; status?: number; result?: McpResult | undefined; error?: unknown }
/** A thread row of t3_thread_list. */
interface ThreadRow { threadId: string; pullRequests?: unknown[] }
/** A question of t3_pending_request read. */
interface Question { id: string; question?: string; options?: { label: string; value?: string }[] }

const ORIGIN = (process.argv[2] || 'http://127.0.0.1:3773').replace(/\/$/, '');
const PORT = 8765, REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const report: { origin: string; steps: Record<string, unknown>[]; at: string; tools?: string[] } = { origin: ORIGIN, steps: [], at: new Date().toISOString() };
const step = (name: string, ok: boolean, detail?: Record<string, unknown>) => { report.steps.push({ name, ok, ...detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`, detail ? JSON.stringify(detail).slice(0, 400) : ''); };
const b64u = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// A fresh private folder per run: no predictable path another user could plant a symlink at.
const OUT = mkdtempSync(join(tmpdir(), 't3-client-spike-'));
console.log('Output folder: ' + OUT);
const save = () => writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });

// 1. Discover and register.
const meta = await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json() as { registration_endpoint: string; authorization_endpoint: string; token_endpoint: string; scopes_supported: string[] };
const resource = (await (await fetch(`${ORIGIN}/.well-known/oauth-protected-resource`)).json() as { resource: string }).resource;
const reg = await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'The Pass (S0 spike)', redirect_uris: [REDIRECT], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
const client = await reg.json() as { client_id?: string };
step('register a client', reg.ok && !!client.client_id, { status: reg.status });
if (!client.client_id) { save(); process.exit(1); }

// 2. Sign-in link, then wait for Dan's approval on the callback.
const verifier = b64u(randomBytes(32)), state = b64u(randomBytes(16));
const challenge = b64u(createHash('sha256').update(verifier).digest());
const auth = new URL(meta.authorization_endpoint);
for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
  code_challenge_method: 'S256', state, resource, scope: meta.scopes_supported.join(' ') })) auth.searchParams.set(k, v);
writeFileSync(join(OUT, 'link.txt'), auth.toString() + '\n', { mode: 0o600 });
console.log('\nOPEN THIS LINK AND APPROVE (pick the access level on the T3 page):\n' + auth.toString() + '\n');
const code = await new Promise<string | null>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no approval within 30 minutes')), 30 * 60 * 1000);
  const srv = createServer((req, res) => {
    const u = new URL(req.url!, REDIRECT);
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('The Pass spike: approved. You can close this tab.');
    clearTimeout(timer); srv.close();
    if (u.searchParams.get('state') !== state) reject(new Error('state mismatch'));
    else if (u.searchParams.get('error')) reject(new Error('denied: ' + u.searchParams.get('error')));
    else resolve(u.searchParams.get('code'));
  }).listen(PORT, '127.0.0.1');
}).catch((ex) => { step('Dan approves the sign-in', false, { error: String(ex.message) }); save(); process.exit(1); });

const tok = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: code as string, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource }) });
const token = await tok.json() as { access_token?: string; scope?: string; expires_in?: number };
step('Dan approves the sign-in', tok.ok && !!token.access_token, { status: tok.status, scope: token.scope, expiresIn: token.expires_in });
if (!token.access_token) { save(); process.exit(1); }

// 3. MCP over streamable HTTP.
let session: string | null = null, id = 0;
async function rpc(method: string, params: unknown, notify = false): Promise<Rpc> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token.access_token}`, 'mcp-protocol-version': '2025-06-18' };
  if (session) headers['mcp-session-id'] = session;
  const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++id, method, params };
  const t0 = Date.now();
  const r = await fetch(resource, { method: 'POST', headers, body: JSON.stringify(body) });
  session = r.headers.get('mcp-session-id') || session;
  if (notify) return { ms: Date.now() - t0 };
  const text = await r.text();
  const ct = r.headers.get('content-type') || '';
  const msgs: RpcMessage[] = ct.includes('event-stream') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))) : [JSON.parse(text)];
  const msg = msgs.find((m) => m.id === id) || msgs[msgs.length - 1];
  return { status: r.status, ms: Date.now() - t0, result: msg?.result, error: msg?.error };
}
/** A tool call; D is the shape of what the tool returns. */
const call = async <D>(name: string, args: Record<string, unknown>) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const c = r.result?.structuredContent ?? (() => { try { return JSON.parse(r.result?.content?.[0]?.text as string); } catch { return r.result?.content?.[0]?.text; } })();
  return { ...r, data: c as D | undefined, isError: r.result?.isError || !!r.error };
};

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'the-pass-spike', version: '0.0.1' } });
step('MCP initialize', !!init.result, { status: init.status, ms: init.ms, server: init.result?.serverInfo, caps: Object.keys(init.result?.capabilities || {}) });
await rpc('notifications/initialized', {}, true);
const tools = await rpc('tools/list', {});
const names = (tools.result?.tools || []).map((t) => t.name);
report.tools = names;
step('list tools', names.length > 0, { count: names.length, names });

const projects = await call<{ projects?: { title: string }[] }>('t3_project_list', { limit: 100 });
const plist = projects.data?.projects || [];
step('read every project', !projects.isError && plist.length > 0, { ms: projects.ms, count: plist.length, titles: plist.map((p) => p.title) });

const threads = await call<{ threads?: ThreadRow[]; items?: ThreadRow[] }>('t3_thread_list', { limit: 20, allProjects: true });
const tlist = threads.data?.threads || threads.data?.items || [];
step('read a thread list', !threads.isError, { ms: threads.ms, count: tlist.length, keys: Object.keys(threads.data || {}) });
const withPr = tlist.find((t) => (t.pullRequests || []).length) || tlist[0];
if (withPr) {
  const one = await call<{ thread?: { status?: string; pullRequests?: { repository: string; number: number; state: string }[] } }>('t3_thread_read', { threadId: withPr.threadId, limit: 1, maxCharsPerItem: 200 });
  step('read one thread with its PRs', !one.isError, { ms: one.ms, status: one.data?.thread?.status, pullRequests: (one.data?.thread?.pullRequests || []).map((p) => `${p.repository}#${p.number} ${p.state}`) });
}

const polls: { ms: number; ok: boolean }[] = [];
for (let i = 0; i < 5; i++) { const p = await call<{ threads?: unknown }>('t3_thread_list', { limit: 20, allProjects: true }); polls.push({ ms: p.ms, ok: !p.isError && Array.isArray(p.data?.threads) }); }
step('poll the thread list 5 times', polls.every((p) => p.ok), { ms: polls.map((p) => p.ms), failed: polls.filter((p) => !p.ok).length });

// 4. One scratch thread that asks one question, answered through t3_pending_request.
const launch = await call<{ threadId?: string }>('t3_thread_launch', { title: 'The Pass spike: one question', scratch: true,
  modelSelection: { instanceId: 'claude_reviewwheel', model: 'claude-haiku-5-5' },
  message: 'This is a test from The Pass spike. Use your question tool (AskUserQuestion) to ask exactly one question: "Spike check from The Pass: which letter?" with two options, "a" and "b". After you get the answer, reply with only the letter you got, then stop. Do nothing else.' });
const sid = launch.data?.threadId;
step('start a scratch thread', !!sid, { ms: launch.ms, error: launch.isError ? JSON.stringify(launch.result || launch.error).slice(0, 300) : undefined });
if (sid) {
  const w0 = Date.now();
  const waited = await call<{ timedOut?: boolean; status?: string }>('t3_thread_wait', { threadId: sid, timeoutMs: 30000 });
  // Passes only if the wait ended before its timeout and a question really waits (a run that ended
  // without asking does not count).
  const askedNow = (await call<{ requestIds?: string[] }>('t3_pending_request', { action: 'list', threadId: sid })).data?.requestIds?.length! > 0;
  step('t3_thread_wait returns when the thread asks', !waited.isError && !waited.data?.timedOut && askedNow,
    { ms: Date.now() - w0, status: waited.data?.status, timedOut: waited.data?.timedOut, questionWaiting: askedNow });
  let reqId: string | null | undefined = null;
  for (let i = 0; i < 20 && !reqId; i++) {
    const l = await call<{ requestIds?: string[] }>('t3_pending_request', { action: 'list', threadId: sid });
    reqId = l.data?.requestIds?.[0];
    if (!reqId) await new Promise((r) => setTimeout(r, 3000));
  }
  step('see the waiting question', !!reqId, {});
  if (reqId) {
    const q = await call<{ questions?: Question[] }>('t3_pending_request', { action: 'read', threadId: sid, requestId: reqId });
    const question = q.data?.questions?.[0];
    const pick = question?.options?.find((o) => /^a$/i.test(o.label)) || question?.options?.[0];
    const answers = question ? { [question.id]: pick?.value ?? pick?.label } : {};
    const resp = await call<unknown>('t3_pending_request', { action: 'respond', threadId: sid, requestId: reqId, answers });
    step('answer it', !resp.isError, { question: question?.question, answered: answers, error: resp.isError ? JSON.stringify(resp.result || resp.error).slice(0, 300) : undefined });
    const done = await call<{ status?: string }>('t3_thread_wait', { threadId: sid, timeoutMs: 120000 });
    const last = await call<{ items?: { type: string; text?: string }[]; thread?: { status?: string } }>('t3_thread_read', { threadId: sid, limit: 5, maxCharsPerItem: 200 });
    const reply = (last.data?.items || []).filter((x) => x.type === 'assistant_message').map((x) => (x.text || '').trim()).slice(-1)[0] ?? '';
    const sent = String(Object.values(answers)[0] ?? '').trim();
    // Passes only if the run completed and the final reply is exactly the answer that was sent.
    step('the thread got the answer', last.data?.thread?.status === 'completed' && reply.toLowerCase() === sent.toLowerCase(),
      { reply, sent, status: last.data?.thread?.status, wait: done.data?.status });
  }
}

// 5. The live socket is not tested here. A real check needs a WebSocket handshake with T3's orchestration
// protocol; T3's source (apps/server/src/auth/EnvironmentAuth.ts) rejects MCP client tokens outside /mcp.
report.steps.push({ name: 'token refused outside /mcp', ok: null, note: 'not tested; see T3 EnvironmentAuth.ts' });

save();
console.log('\nReport: ' + join(OUT, 'report.json'));
process.exit(0);
