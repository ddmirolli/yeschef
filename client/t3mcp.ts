// The Pass's only link to T3: an outside MCP client that signs in with OAuth (docs/pass-product-brief-v1_0.md).
// Node 18+ standard library. The token lives in this process only.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { T3Caller } from './contracts.ts';

// What T3's OAuth endpoints send, as far as the sign-in reads it.
interface AuthServer { registration_endpoint: string; authorization_endpoint: string; token_endpoint: string; scopes_supported: string[] }
interface TokenReply { access_token?: string; scope?: string; expires_in?: number }
/** A finished sign-in: the MCP resource and its bearer token. */
export interface SignedIn { resource: string; token: string; scope: string | undefined; expiresIn: number | undefined }
// A JSON-RPC reply, and the result of an MCP tools/call.
interface RpcMessage { id?: number | null; result?: unknown; error?: { message?: string } }
interface ToolResult { structuredContent?: unknown; content?: { text?: string }[]; isError?: boolean }

const b64u = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Register with the T3 environment at `origin`, show the sign-in link, and wait for the approval on a local callback.
 *  Port 0 (the default) takes any free port on 127.0.0.1. Each sign-in registers a new client, so the client is
 *  registered with the port this sign-in holds, and nothing clashes with whatever else uses a fixed one. */
export async function signIn(origin: string, { port = 0, name = 'The Pass', onLink = console.log, timeoutMs = 30 * 60 * 1000 }: { port?: number; name?: string; onLink?: (link: string) => void; timeoutMs?: number } = {}): Promise<SignedIn> {
  // The callback listens before T3 hears of it. Until the link is out, any request to it is a 404.
  let answer: ((u: URL) => void) | null = null;
  const srv = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/callback' || !answer) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('The Pass is signed in to T3. You can close this tab.');
    const done = answer; answer = null; done(u);
  });
  await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', () => resolve()); });
  try {
    const redirect = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/callback`;
    const meta = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as AuthServer;
    const resource = ((await (await fetch(`${origin}/.well-known/oauth-protected-resource`)).json()) as { resource: string }).resource;
    const reg = await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: name, redirect_uris: [redirect], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
    if (!reg.ok) throw new Error(`T3 refused the client registration (${reg.status})`);
    const client = (await reg.json()) as { client_id: string };
    const verifier = b64u(randomBytes(32)), state = b64u(randomBytes(16));
    const link = new URL(meta.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect,
      code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, resource,
      scope: meta.scopes_supported.join(' ') })) link.searchParams.set(k, v);
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { answer = null; reject(new Error('no approval in time')); }, timeoutMs);
      answer = (u) => {
        clearTimeout(timer);
        if (u.searchParams.get('state') !== state) reject(new Error('state mismatch'));
        else if (u.searchParams.get('error')) reject(new Error('sign-in denied: ' + u.searchParams.get('error')));
        else resolve(String(u.searchParams.get('code')));
      };
      onLink(link.toString());
    });
    const tok = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource }) });
    const token = (await tok.json()) as TokenReply;
    if (!token.access_token) throw new Error(`no token (${tok.status})`);
    return { resource, token: token.access_token, scope: token.scope, expiresIn: token.expires_in };
  } finally { srv.close(); srv.closeIdleConnections(); }
}

/** A small MCP client over streamable HTTP. call() returns the tool's structured result, or throws. */
export function connect({ resource, token }: { resource: string; token: string }, { timeoutMs = 20000 }: { timeoutMs?: number } = {}): T3Caller {
  let session: string | null = null, id = 0, ready: Promise<unknown> | null = null;
  async function rpc(method: string, params: unknown, notify = false): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-06-18' };
    if (session) headers['mcp-session-id'] = session;
    const myId = notify ? null : ++id;
    // A deadline on every request: a reply that never ends must not stall the poll loop.
    const signal = AbortSignal.timeout(timeoutMs);
    const r = await fetch(resource, { method: 'POST', headers, signal, body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: myId, method, params }) });
    session = r.headers.get('mcp-session-id') || session;
    if (notify) { await r.body?.cancel(); if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`); return null; }
    if (r.status === 401) throw Object.assign(new Error('T3 sign-in expired or revoked'), { auth: true });
    // A 404 on an established session means T3 dropped it: start a new session on the next call.
    if (r.status === 404 && headers['mcp-session-id']) { session = null; ready = null; throw new Error('T3 ended the session; reconnecting'); }
    let msg: RpcMessage | undefined;
    if ((r.headers.get('content-type') || '').includes('event-stream')) {
      // Read the stream only until our reply arrives; the server may keep it open.
      if (!r.body) throw new Error(`${method}: T3 sent an empty stream`);
      const reader = r.body.getReader(), dec = new TextDecoder();
      // An event may split its data over several lines; parse it at the blank line that ends it.
      let buf = '', data: string[] = [];
      while (!msg) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while (!msg && (nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1);
          if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
          else if (line === '' && data.length) { const m = JSON.parse(data.join('\n')) as RpcMessage; data = []; if (m.id === myId) msg = m; }
        }
      }
      reader.cancel().catch(() => {});
    } else msg = JSON.parse(await r.text()) as RpcMessage;
    if (!msg) throw new Error(`${method}: T3 closed the reply without an answer`);
    if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
    return msg.result;
  }
  // A failed initialize is not kept: the next call starts over on a clean session.
  const init = () => (ready ??= rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'the-pass', version: '0.1.0' } })
    .then(() => rpc('notifications/initialized', {}, true))
    .catch((ex) => { ready = null; session = null; throw ex; }));
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      await init();
      let res: ToolResult | null | undefined;
      try { res = (await rpc('tools/call', { name, arguments: args })) as ToolResult | null; }
      catch (ex) {
        if (session !== null || !/reconnecting/.test((ex as Error | null)?.message ?? '')) throw ex;
        await init();  // one retry on a fresh session
        res = (await rpc('tools/call', { name, arguments: args })) as ToolResult | null;
      }
      const text = res?.content?.[0]?.text;
      const data: unknown = res?.structuredContent ?? (() => { try { return JSON.parse(text ?? '') as unknown; } catch { return text; } })();
      if (res?.isError) throw new Error(`${name}: ${typeof data === 'string' ? data : JSON.stringify(data)}`.slice(0, 300));
      return data;
    },
  };
}
