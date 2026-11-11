// @effect-diagnostics nodeBuiltinImport:off - The loopback OAuth callback is a Node HTTP boundary, as in T3 Code's CliTokenManager.ts.
// The Pass's only link to T3: an outside MCP client that signs in with OAuth (docs/pass-product-brief-v1_0.md).
// Effect at the edge, the way T3 Code's own MCP client (apps/server/src/peer/PeerMcpClient.ts) and its loopback OAuth
// sign-in (apps/server/src/cloud/CliTokenManager.ts) do it: HttpClient for every request, a Schema for every reply, a
// tagged error for every failure. The board server keeps its Promises: signIn() and connect() run the programs here.
// The token lives in this process only.
import * as NodeHttp from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Deferred from 'effect/Deferred';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Semaphore from 'effect/Semaphore';
import * as Stream from 'effect/Stream';
import * as Digest from 'effect/crypto/Digest';
import * as SecureRandom from 'effect/crypto/SecureRandom';
import * as Base64Url from 'effect/encoding/Base64Url';
import * as Sse from 'effect/encoding/Sse';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import type { T3Caller } from './contracts.ts';

/** The MCP protocol version T3 Code's /mcp speaks (PeerMcpClient.ts uses the same). */
const PROTOCOL_VERSION = '2025-06-18';

// What T3's OAuth endpoints send, as far as the sign-in reads it.
const AuthServer = Schema.Struct({
  registration_endpoint: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  scopes_supported: Schema.Array(Schema.String),
});
const ProtectedResource = Schema.Struct({ resource: Schema.String });
const Registration = Schema.Struct({ client_id: Schema.String });
// An empty token is no sign-in (PR-Agent r1 on #37).
const TokenReply = Schema.Struct({
  access_token: Schema.NonEmptyString,
  scope: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
});

// A JSON-RPC message on the wire. Any message may arrive on a stream; only the reply with our id is read in full.
const RpcEnvelope = Schema.fromJsonString(Schema.Struct({ id: Schema.optional(Schema.Unknown) }));
const RpcReply = Schema.fromJsonString(Schema.Struct({
  id: Schema.Number,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
}));
// The result of an MCP tools/call, as PeerMcpClient.ts reads it.
const ToolResult = Schema.Struct({
  content: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))),
  structuredContent: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
});
const Json = Schema.fromJsonString(Schema.Unknown);
// Why T3 refused a request outside a 2xx: T3 Code's own { error, message } (McpHttpServer.ts), or a JSON-RPC error.
const Refusal = Schema.fromJsonString(Schema.Union([
  Schema.Struct({ message: Schema.String }),
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
]));

/** A finished sign-in: the MCP resource and its bearer token. */
export interface SignedIn { resource: string; token: string; scope: string | undefined; expiresIn: number | undefined }

/** The sign-in could not finish. The message says which step failed. */
export class T3SignInError extends Schema.TaggedError<T3SignInError>()('T3SignInError', {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string { return this.reason; }
}

/** T3 Code refused the token (401): the sign-in expired or was revoked. The board server checks `auth`. */
export class T3AuthError extends Schema.TaggedError<T3AuthError>()('T3AuthError', {}) {
  get auth(): true { return true; }
  override get message(): string { return 'T3 sign-in expired or revoked'; }
}

/** T3 dropped our MCP session (404 on an established one). The call starts a new session once. */
export class T3SessionEndedError extends Schema.TaggedError<T3SessionEndedError>()('T3SessionEndedError', {}) {
  override get message(): string { return 'T3 ended the session; reconnecting'; }
}

/** An MCP request or tool failed. The message names the method or tool. */
export class T3CallError extends Schema.TaggedError<T3CallError>()('T3CallError', {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string { return this.reason; }
}

const isOk = (status: number): boolean => status >= 200 && status < 300;

/** Runs a program at the Promise boundary. Fetch is read at each run, so a test's stand-in for it is the one used. */
const run = <A, E>(program: Effect.Effect<A, E, HttpClient.HttpClient>): Promise<A> =>
  Effect.runPromise(program.pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
  ));

/** GET a JSON document and decode it, or fail naming the document. */
const getJson = Effect.fn('t3mcp.get_json')(function* <S extends Schema.Decoder<unknown>>(url: string, schema: S, what: string) {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  return yield* http.get(url).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
    Effect.mapError((cause) => new T3SignInError({ reason: `${what} could not be read: ${cause.message}`, cause })),
  );
});

// PKCE as CliTokenManager.ts makes it: a verifier, its SHA-256 challenge and a state, from WebCrypto.
const makePkceRequest = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const verifier = Base64Url.encode(yield* random.randomBytes(32));
  const challenge = Base64Url.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(verifier)));
  const state = Base64Url.encode(yield* random.randomBytes(16));
  return { verifier, challenge, state };
}).pipe(
  Effect.provide([SecureRandom.layerWebCrypto, Digest.layerWebCrypto]),
  Effect.mapError((cause) => new T3SignInError({ reason: 'could not make the sign-in secret', cause })),
);

/** The loopback callback. Until `arm` is called, every request to it is a 404. Closed when the scope ends. */
const listen = Effect.fn('t3mcp.listen')(function* (port: number) {
  const callback = yield* Deferred.make<URL>();
  let armed = false;
  // Every answer closes its connection, so no kept-alive socket outlives the sign-in, however the close is timed.
  const server = NodeHttp.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/callback' || !armed) { res.writeHead(404, { connection: 'close' }).end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' }).end('The Pass is signed in to T3. You can close this tab.');
    armed = false;
    Deferred.doneUnsafe(callback, Effect.succeed(u));
  });
  yield* Effect.acquireRelease(
    Effect.callback<void, T3SignInError>((resume) => {
      server.once('error', (cause) => resume(Effect.fail(new T3SignInError({ reason: `could not listen for the sign-in: ${cause.message}`, cause }))));
      server.listen(port, '127.0.0.1', () => resume(Effect.void));
    }),
    () => Effect.sync(() => { server.close(); server.closeIdleConnections(); }),
  );
  return {
    redirect: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`,
    arm: () => { armed = true; },
    approval: Deferred.await(callback),
  };
});

const signInProgram = Effect.fn('t3mcp.sign_in')(function* (origin: string, port: number, name: string, onLink: (link: string) => void, timeoutMs: number) {
  const http = yield* HttpClient.HttpClient;
  // The callback listens before T3 hears of it.
  const loopback = yield* listen(port);
  const meta = yield* getJson(`${origin}/.well-known/oauth-authorization-server`, AuthServer, "T3's OAuth metadata");
  const { resource } = yield* getJson(`${origin}/.well-known/oauth-protected-resource`, ProtectedResource, "T3's MCP resource metadata");
  const registered = yield* HttpClientRequest.post(meta.registration_endpoint).pipe(
    HttpClientRequest.bodyJsonUnsafe({ client_name: name, redirect_uris: [loopback.redirect], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    http.execute,
    Effect.mapError((cause) => new T3SignInError({ reason: `could not reach T3 to register: ${cause.message}`, cause })),
  );
  if (!isOk(registered.status)) return yield* new T3SignInError({ reason: `T3 refused the client registration (${registered.status})` });
  const { client_id } = yield* HttpClientResponse.schemaBodyJson(Registration)(registered).pipe(
    Effect.mapError((cause) => new T3SignInError({ reason: `T3's client registration could not be read: ${cause.message}`, cause })),
  );
  const { verifier, challenge, state } = yield* makePkceRequest;
  const link = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id, redirect_uri: loopback.redirect, code_challenge: challenge,
    code_challenge_method: 'S256', state, resource, scope: meta.scopes_supported.join(' ') })) link.searchParams.set(k, v);
  loopback.arm();
  onLink(link.toString());
  const answer = yield* loopback.approval.pipe(
    Effect.timeoutOrElse({ duration: Duration.millis(timeoutMs), orElse: () => Effect.fail(new T3SignInError({ reason: 'no approval in time' })) }),
  );
  if (answer.searchParams.get('state') !== state) return yield* new T3SignInError({ reason: 'state mismatch' });
  const denied = answer.searchParams.get('error');
  if (denied) return yield* new T3SignInError({ reason: 'sign-in denied: ' + denied });
  const tokenResponse = yield* HttpClientRequest.post(meta.token_endpoint).pipe(
    HttpClientRequest.bodyUrlParams({ grant_type: 'authorization_code', code: String(answer.searchParams.get('code')), redirect_uri: loopback.redirect,
      client_id, code_verifier: verifier, resource }),
    http.execute,
    Effect.mapError((cause) => new T3SignInError({ reason: `could not reach T3 for the token: ${cause.message}`, cause })),
  );
  const token = yield* HttpClientResponse.schemaBodyJson(TokenReply)(tokenResponse).pipe(
    Effect.mapError((cause) => new T3SignInError({ reason: `no token (${tokenResponse.status})`, cause })),
  );
  return { resource, token: token.access_token, scope: token.scope, expiresIn: token.expires_in } satisfies SignedIn;
}, Effect.scoped);

/** Register with the T3 environment at `origin`, show the sign-in link, and wait for the approval on a local callback.
 *  Port 0 (the default) takes any free port on 127.0.0.1. Each sign-in registers a new client, so the client is
 *  registered with the port this sign-in holds, and nothing clashes with whatever else uses a fixed one. */
export function signIn(origin: string, { port = 0, name = 'The Pass', onLink, timeoutMs = 30 * 60 * 1000 }: { port?: number; name?: string; onLink: (link: string) => void; timeoutMs?: number }): Promise<SignedIn> {
  return run(signInProgram(origin, port, name, onLink, timeoutMs));
}

/** A small MCP client over streamable HTTP. call() returns the tool's structured result, or throws. */
export function connect({ resource, token }: { resource: string; token: string }, { timeoutMs = 20000 }: { timeoutMs?: number } = {}): T3Caller {
  let session: string | null = null, id = 0, ready = false;
  const initLock = Semaphore.makeUnsafe(1);

  const rpc = Effect.fn('t3mcp.rpc')(function* (method: string, params: unknown, notify: boolean) {
    const http = yield* HttpClient.HttpClient;
    const sent = session;
    const myId = notify ? null : ++id;
    const response = yield* HttpClientRequest.post(resource).pipe(
      HttpClientRequest.setHeaders({ accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`,
        'mcp-protocol-version': PROTOCOL_VERSION, ...(sent ? { 'mcp-session-id': sent } : {}) }),
      HttpClientRequest.bodyJsonUnsafe(myId === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: myId, method, params }),
      http.execute,
      Effect.mapError((cause) => new T3CallError({ reason: `${method}: could not reach T3 (${cause.message})`, cause })),
    );
    session = response.headers['mcp-session-id'] || session;
    // A refusal names its status, and T3's reason when the body gives one.
    const refused = response.text.pipe(
      Effect.map((text) => Option.match(Schema.decodeOption(Refusal)(text), { onNone: () => '', onSome: (r) => `: ${'message' in r ? r.message : r.error.message}` })),
      Effect.orElseSucceed(() => ''),
      Effect.flatMap((said) => Effect.fail(new T3CallError({ reason: `${method}: HTTP ${response.status}${said}`.slice(0, 300) }))),
    );
    if (myId === null) {
      if (!isOk(response.status)) return yield* refused;
      yield* Effect.ignore(response.text);
      return undefined;
    }
    if (response.status === 401) return yield* new T3AuthError();
    // A 404 on an established session means T3 dropped it: start a new session on the next call.
    if (response.status === 404 && sent) { session = null; ready = false; return yield* new T3SessionEndedError(); }
    if (!isOk(response.status)) return yield* refused;
    const unreadable = (cause: unknown) => new T3CallError({ reason: `${method}: T3 sent a reply the Pass cannot read`, cause });
    // On a stream, read only until our reply arrives; the server may keep the stream open.
    const raw = (response.headers['content-type'] ?? '').includes('event-stream')
      ? yield* response.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.filterEffect((event) => Schema.decodeEffect(RpcEnvelope)(event.data).pipe(Effect.map((m) => m.id === myId))),
        Stream.map((event) => event.data),
        Stream.runHead,
        Effect.mapError(unreadable),
      )
      : Option.some(yield* response.text.pipe(Effect.mapError(unreadable)));
    if (Option.isNone(raw)) return yield* new T3CallError({ reason: `${method}: T3 closed the reply without an answer` });
    const reply = yield* Schema.decodeEffect(RpcReply)(raw.value).pipe(Effect.mapError(unreadable));
    if (reply.error) return yield* new T3CallError({ reason: `${method}: ${reply.error.message}` });
    return reply.result;
  }, (effect, method) => effect.pipe(
    // A deadline on every request: a reply that never ends must not stall the poll loop.
    Effect.timeoutOrElse({ duration: Duration.millis(timeoutMs), orElse: () => Effect.fail(new T3CallError({ reason: `${method}: T3 did not answer in ${timeoutMs} ms` })) }),
  ));

  // One initialize at a time. A failed one is not kept: the next call starts over on a clean session.
  const init = initLock.withPermits(1)(Effect.suspend(() => ready ? Effect.void : rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {},
    clientInfo: { name: 'the-pass', version: '0.1.0' } }, false).pipe(
    Effect.andThen(rpc('notifications/initialized', {}, true)),
    Effect.tap(() => Effect.sync(() => { ready = true; })),
    Effect.tapError(() => Effect.sync(() => { session = null; })),
  )));

  const call = Effect.fn('t3mcp.call')(function* (name: string, args: Record<string, unknown>) {
    yield* init;
    const callOnce = rpc('tools/call', { name, arguments: args }, false);
    // One retry on a fresh session.
    const raw = yield* callOnce.pipe(Effect.catchTag('T3SessionEndedError', () => init.pipe(Effect.andThen(callOnce))));
    const result = yield* Schema.decodeUnknownEffect(ToolResult)(raw).pipe(
      Effect.mapError((cause) => new T3CallError({ reason: `${name}: T3 sent a result the Pass cannot read`, cause })),
    );
    const text = result.content?.[0]?.text;
    const data: unknown = result.structuredContent
      ?? Option.getOrElse(Schema.decodeOption(Json)(text ?? ''), () => text);
    if (result.isError) {
      const said = typeof data === 'string' ? data : yield* Schema.encodeEffect(Json)(data).pipe(Effect.orElseSucceed(() => String(data)));
      return yield* new T3CallError({ reason: `${name}: ${said}`.slice(0, 300) });
    }
    return data;
  });

  return { call: (name, args = {}) => run(call(name, args)) };
}
