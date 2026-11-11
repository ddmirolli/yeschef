// The MCP client reads streamed replies correctly, and sign-in takes a free port. Run: vp test run t3mcp.test.ts, in client/
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { get, createServer } from 'node:http';
import type { Server } from 'node:http';
import { connect, signIn } from './t3mcp.ts';

// A streamed reply. open: the server keeps the stream open after this text; the request's deadline ends it.
const sse = (text: string, { open = false, signal }: { open?: boolean; signal?: AbortSignal | null | undefined } = {}) => new Response(new ReadableStream({ start(c) {
  c.enqueue(new TextEncoder().encode(text));
  if (!open) c.close(); else signal?.addEventListener('abort', () => c.error(signal?.reason));
} }), { headers: { 'content-type': 'text/event-stream' } });
/** The next made-up reply, in order. */
const next = (replies: (() => Response)[]): Response => { const f = replies.shift(); assert.ok(f, 'no reply left'); return f(); };
/** The port a listening server took. */
const portOf = (s: Server): number => { const a = s.address(); assert.ok(a && typeof a === 'object'); return a.port; };

test('a streamed reply whose JSON spans several data lines is parsed whole', async () => {
  const replies = [
    () => sse('event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":1,"result":{}}\n\n'),        // initialize, split over two lines
    () => new Response(null, { status: 202 }),                                                  // notifications/initialized
    () => sse('data: {"jsonrpc":"2.0","id":2,\r\ndata: "result":{"structuredContent":{"projects":[1,2]}}}\r\n\r\n'),
  ];
  const real = globalThis.fetch;
  globalThis.fetch = async () => next(replies);
  try {
    const data = await connect({ resource: 'http://t3.test/mcp', token: 't' }).call('t3_project_list');
    assert.deepEqual(data, { projects: [1, 2] });
  } finally { globalThis.fetch = real; }
});

test('a stream that ends without our reply is an error, not a hang', async () => {
  const replies = [() => sse('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'), () => new Response(null, { status: 202 }), () => sse(': keep-alive\n\n')];
  const real = globalThis.fetch;
  globalThis.fetch = async () => next(replies);
  try {
    await assert.rejects(connect({ resource: 'http://t3.test/mcp', token: 't' }).call('t3_thread_list'), /without an answer/);
  } finally { globalThis.fetch = real; }
});

test('a stream that stays open without our reply hits the deadline instead of hanging', async () => {
  let n = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (_, opts) => [
    () => sse('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'), () => new Response(null, { status: 202 }),
    () => sse(': keep-alive\n\n', { open: true, signal: opts?.signal })][n++]!();
  // AbortSignal.timeout's timer is unreferenced; this referenced timer keeps the test alive until it settles.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    const t0 = Date.now();
    await assert.rejects(connect({ resource: 'http://t3.test/mcp', token: 't' }, { timeoutMs: 300 }).call('t3_thread_list'));
    assert.ok(Date.now() - t0 < 3000);
  } finally { clearTimeout(keepAlive); globalThis.fetch = real; }
});

test('a dropped session is started again, once, and the call succeeds', async () => {
  const seen: string[] = [];
  const replies = [
    () => new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' } }),
    () => new Response(null, { status: 202 }),
    () => new Response('{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"n":1}}}', { headers: { 'content-type': 'application/json' } }),
    () => new Response('not found', { status: 404 }),
    () => new Response('{"jsonrpc":"2.0","id":4,"result":{}}', { headers: { 'content-type': 'application/json', 'mcp-session-id': 's2' } }),
    () => new Response(null, { status: 202 }),
    () => new Response('{"jsonrpc":"2.0","id":5,"result":{"structuredContent":{"n":2}}}', { headers: { 'content-type': 'application/json' } }),
  ];
  const real = globalThis.fetch;
  globalThis.fetch = async (_, opts) => { seen.push(new Headers(opts?.headers).get('mcp-session-id') || '-'); return next(replies); };
  try {
    const c = connect({ resource: 'http://t3.test/mcp', token: 't' });
    assert.deepEqual(await c.call('a'), { n: 1 });
    assert.deepEqual(await c.call('b'), { n: 2 });
    assert.deepEqual(seen, ['-', 's1', 's1', 's1', '-', 's2', 's2']);
  } finally { globalThis.fetch = real; }
});

test('a failed initialize is retried on the next call', async () => {
  const replies = [
    () => new Response('bad gateway', { status: 502 }),
    () => new Response('{"jsonrpc":"2.0","id":2,"result":{}}', { headers: { 'content-type': 'application/json' } }),
    () => new Response(null, { status: 202 }),
    () => new Response('{"jsonrpc":"2.0","id":3,"result":{"structuredContent":{"ok":true}}}', { headers: { 'content-type': 'application/json' } }),
  ];
  const real = globalThis.fetch;
  globalThis.fetch = async () => next(replies);
  try {
    const c = connect({ resource: 'http://t3.test/mcp', token: 't' });
    await assert.rejects(c.call('a'));
    assert.deepEqual(await c.call('a'), { ok: true });
  } finally { globalThis.fetch = real; }
});

test('an HTTP error on the initialized notice fails initialize, and the next call starts over', async () => {
  const replies = [
    () => new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { headers: { 'content-type': 'application/json' } }),
    () => new Response('busy', { status: 503 }),
    () => new Response('{"jsonrpc":"2.0","id":2,"result":{}}', { headers: { 'content-type': 'application/json' } }),
    () => new Response(null, { status: 202 }),
    () => new Response('{"jsonrpc":"2.0","id":3,"result":{"structuredContent":{"ok":1}}}', { headers: { 'content-type': 'application/json' } }),
  ];
  const real = globalThis.fetch;
  globalThis.fetch = async () => next(replies);
  try {
    const c = connect({ resource: 'http://t3.test/mcp', token: 't' });
    await assert.rejects(c.call('a'), /HTTP 503/);
    assert.deepEqual(await c.call('a'), { ok: 1 });
  } finally { globalThis.fetch = real; }
});

// A made-up T3 for sign-in: its metadata, registration and token answers, recorded. The callback is real HTTP.
function fakeT3() {
  const seen: { registered: { redirect_uris?: unknown; client_name?: unknown } | null; token: Record<string, string> | null } = { registered: null, token: null };
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const fetch = async (url: string | URL | Request, opts: RequestInit = {}) => {
    const u = String(url);
    if (u.endsWith('/.well-known/oauth-authorization-server')) return json({ registration_endpoint: 'http://t3.test/register',
      authorization_endpoint: 'http://t3.test/authorize', token_endpoint: 'http://t3.test/token', scopes_supported: ['orchestration:read'] });
    if (u.endsWith('/.well-known/oauth-protected-resource')) return json({ resource: 'http://t3.test/mcp' });
    if (u === 'http://t3.test/register') { seen.registered = JSON.parse(String(opts.body)); return json({ client_id: 'c1' }); }
    if (u === 'http://t3.test/token') { seen.token = Object.fromEntries(new URLSearchParams(String(opts.body))); return json({ access_token: 'tok', scope: 'orchestration:read', expires_in: 60 }); }
    throw new Error('unexpected ' + u);
  };
  return { fetch, seen };
}
const hit = (url: string) => new Promise<number | undefined>((resolve, reject) => get(url, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));

test('sign-in listens on a free port and registers exactly that callback', async () => {
  const t3 = fakeT3();
  const real = globalThis.fetch;
  globalThis.fetch = t3.fetch;
  // Something already holds the old fixed port's role: sign-in must not need any particular port.
  const squatter = createServer(() => {});
  await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', r));
  try {
    let link = null as URL | null;
    const done = signIn('http://t3.test', { name: 'Yes Chef 9.9.9', onLink: (l) => { link = new URL(l); } });
    while (!link) await new Promise((r) => setTimeout(r, 5));
    const redirect = String(link.searchParams.get('redirect_uri'));
    assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.notEqual(new URL(redirect).port, String(portOf(squatter)));
    assert.deepEqual(t3.seen.registered?.redirect_uris, [redirect]);
    assert.equal(t3.seen.registered?.client_name, 'Yes Chef 9.9.9');
    // A stray request is not the approval; the real one carries the state.
    assert.equal(await hit(new URL('/elsewhere', redirect).href), 404);
    assert.equal(await hit(`${redirect}?code=abc&state=${link.searchParams.get('state')}`), 200);
    const auth = await done;
    assert.deepEqual(auth, { resource: 'http://t3.test/mcp', token: 'tok', scope: 'orchestration:read', expiresIn: 60 });
    assert.equal(t3.seen.token?.redirect_uri, redirect);
    assert.equal(t3.seen.token?.code, 'abc');
    // The callback port is closed once the sign-in is done.
    await assert.rejects(hit(redirect));
  } finally { globalThis.fetch = real; squatter.close(); }
});

test('a callback with the wrong state fails the sign-in and frees the port', async () => {
  const t3 = fakeT3();
  const real = globalThis.fetch;
  globalThis.fetch = t3.fetch;
  try {
    let link = null as URL | null;
    // The failure is caught as it happens; it is checked below.
    const done = signIn('http://t3.test', { onLink: (l) => { link = new URL(l); } }).then(() => null, (e) => e);
    while (!link) await new Promise((r) => setTimeout(r, 5));
    const redirect = String(link.searchParams.get('redirect_uri'));
    await hit(`${redirect}?code=abc&state=not-the-one`);
    assert.match(String((await done)?.message), /state mismatch/);
    assert.equal(t3.seen.token, null);
    await assert.rejects(hit(redirect));
  } finally { globalThis.fetch = real; }
});

test('a fixed port still works when one is asked for', async () => {
  const t3 = fakeT3();
  const real = globalThis.fetch;
  globalThis.fetch = t3.fetch;
  const probe = createServer(() => {});
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = portOf(probe);
  await new Promise((r) => probe.close(r));
  try {
    let link = null as URL | null;
    const done = signIn('http://t3.test', { port, onLink: (l) => { link = new URL(l); } });
    while (!link) await new Promise((r) => setTimeout(r, 5));
    assert.equal(link.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/callback`);
    await hit(`http://127.0.0.1:${port}/callback?code=x&state=${link.searchParams.get('state')}`);
    await done;
  } finally { globalThis.fetch = real; }
});

// Every reply is read through a Schema (Effect PR, step 3). A reply that is not what T3 promised fails with what was
// wrong, so the board shows "not checked", instead of a value nobody checked.
test('a token reply whose token is not a string is refused, not kept as a sign-in', async () => {
  const t3 = fakeT3();
  const fetch = async (url: string | URL | Request, opts: RequestInit = {}) => String(url) === 'http://t3.test/token'
    ? new Response('{"access_token":123,"scope":"orchestration:read"}', { headers: { 'content-type': 'application/json' } })
    : t3.fetch(url, opts);
  const real = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    let link = null as URL | null;
    const done = signIn('http://t3.test', { onLink: (l) => { link = new URL(l); } }).then(() => null, (e: unknown) => e);
    while (!link) await new Promise((r) => setTimeout(r, 5));
    await hit(`${String(link.searchParams.get('redirect_uri'))}?code=abc&state=${link.searchParams.get('state')}`);
    assert.match(String((await done as Error | null)?.message), /no token/);
  } finally { globalThis.fetch = real; }
});

test('OAuth metadata without its scopes names what T3 sent wrong', async () => {
  const t3 = fakeT3();
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => String(url).endsWith('/.well-known/oauth-authorization-server')
    ? new Response('{"registration_endpoint":"http://t3.test/register","authorization_endpoint":"http://t3.test/authorize","token_endpoint":"http://t3.test/token"}', { headers: { 'content-type': 'application/json' } })
    : t3.fetch(url, opts);
  try {
    await assert.rejects(signIn('http://t3.test', { onLink: () => {} }), /T3's OAuth metadata/);
    assert.equal(t3.seen.registered, null);
  } finally { globalThis.fetch = real; }
});

test('a tool result that is not an MCP result fails instead of reading as no data', async () => {
  const replies = [
    () => new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { headers: { 'content-type': 'application/json' } }),
    () => new Response(null, { status: 202 }),
    () => new Response('{"jsonrpc":"2.0","id":2,"result":{"content":"oops"}}', { headers: { 'content-type': 'application/json' } }),
  ];
  const real = globalThis.fetch;
  globalThis.fetch = async () => next(replies);
  try {
    await assert.rejects(connect({ resource: 'http://t3.test/mcp', token: 't' }).call('t3_thread_list'), /t3_thread_list: T3 sent a result the Pass cannot read/);
  } finally { globalThis.fetch = real; }
});

test('a refused sign-in (401) is an auth fault the board can tell apart', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
  try {
    const err = await connect({ resource: 'http://t3.test/mcp', token: 't' }).call('t3_environment_read').then(() => null, (e: unknown) => e as Error & { auth?: boolean });
    assert.equal(err?.auth, true);
    assert.match(String(err?.message), /T3 sign-in expired or revoked/);
  } finally { globalThis.fetch = real; }
});
