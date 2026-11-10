// The Pass's only link to T3: an outside MCP client that signs in with OAuth (docs/pass-product-brief-v1_0.md).
// Node 18+ standard library. The token lives in this process only.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const b64u = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Register with the T3 environment at `origin`, show the sign-in link, and wait for the approval on a local callback.
 *  Port 0 (the default) takes any free port on 127.0.0.1. Each sign-in registers a new client, so the client is
 *  registered with the port this sign-in holds, and nothing clashes with whatever else uses a fixed one. */
export async function signIn(origin, { port = 0, name = 'The Pass', onLink = console.log, timeoutMs = 30 * 60 * 1000 } = {}) {
  // The callback listens before T3 hears of it. Until the link is out, any request to it is a 404.
  let answer = null;
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback' || !answer) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('The Pass is signed in to T3. You can close this tab.');
    const done = answer; answer = null; done(u);
  });
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', resolve); });
  try {
    const redirect = `http://127.0.0.1:${srv.address().port}/callback`;
    const meta = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
    const resource = (await (await fetch(`${origin}/.well-known/oauth-protected-resource`)).json()).resource;
    const reg = await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: name, redirect_uris: [redirect], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
    if (!reg.ok) throw new Error(`T3 refused the client registration (${reg.status})`);
    const client = await reg.json();
    const verifier = b64u(randomBytes(32)), state = b64u(randomBytes(16));
    const link = new URL(meta.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect,
      code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, resource,
      scope: meta.scopes_supported.join(' ') })) link.searchParams.set(k, v);
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { answer = null; reject(new Error('no approval in time')); }, timeoutMs);
      answer = (u) => {
        clearTimeout(timer);
        if (u.searchParams.get('state') !== state) reject(new Error('state mismatch'));
        else if (u.searchParams.get('error')) reject(new Error('sign-in denied: ' + u.searchParams.get('error')));
        else resolve(u.searchParams.get('code'));
      };
      onLink(link.toString());
    });
    const tok = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource }) });
    const token = await tok.json();
    if (!token.access_token) throw new Error(`no token (${tok.status})`);
    return { resource, token: token.access_token, scope: token.scope, expiresIn: token.expires_in };
  } finally { srv.close(); srv.closeIdleConnections(); }
}

/** A small MCP client over streamable HTTP. call() returns the tool's structured result, or throws. */
export function connect({ resource, token }, { timeoutMs = 20000 } = {}) {
  let session = null, id = 0, ready = null;
  async function rpc(method, params, notify = false) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
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
    let msg;
    if ((r.headers.get('content-type') || '').includes('event-stream')) {
      // Read the stream only until our reply arrives; the server may keep it open.
      const reader = r.body.getReader(), dec = new TextDecoder();
      // An event may split its data over several lines; parse it at the blank line that ends it.
      let buf = '', data = [];
      while (!msg) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while (!msg && (nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1);
          if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
          else if (line === '' && data.length) { const m = JSON.parse(data.join('\n')); data = []; if (m.id === myId) msg = m; }
        }
      }
      reader.cancel().catch(() => {});
    } else msg = JSON.parse(await r.text());
    if (!msg) throw new Error(`${method}: T3 closed the reply without an answer`);
    if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
    return msg.result;
  }
  // A failed initialize is not kept: the next call starts over on a clean session.
  const init = () => (ready ??= rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'the-pass', version: '0.1.0' } })
    .then(() => rpc('notifications/initialized', {}, true))
    .catch((ex) => { ready = null; session = null; throw ex; }));
  return {
    async call(name, args = {}) {
      await init();
      let res;
      try { res = await rpc('tools/call', { name, arguments: args }); }
      catch (ex) {
        if (session !== null || !/reconnecting/.test(ex.message)) throw ex;
        await init();  // one retry on a fresh session
        res = await rpc('tools/call', { name, arguments: args });
      }
      const data = res?.structuredContent ?? (() => { try { return JSON.parse(res?.content?.[0]?.text); } catch { return res?.content?.[0]?.text; } })();
      if (res?.isError) throw new Error(`${name}: ${typeof data === 'string' ? data : JSON.stringify(data)}`.slice(0, 300));
      return data;
    },
  };
}
