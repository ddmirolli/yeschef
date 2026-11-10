// Dev only, on the machine that runs T3: approve a waiting Pass sign-in without the browser page.
// Dan, 2026-11-06: "configure it yourself". A real user approves on T3's sign-in page instead.
// It mints a 5-minute pairing code with T3's documented CLI (`t3 auth pairing create`), posts the
// decision, and delivers the redirect to the client's local callback. The code is never printed or saved.
// Usage: node tools/dev-approve.mjs <t3-origin> <link-file> <read-only|approval-required|auto-accept-edits|auto|full-access>
// It refuses a link for any other origin, so a planted link file never receives the code.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LEVELS = ['read-only', 'approval-required', 'auto-accept-edits', 'auto', 'full-access'];
const [origin, file, access] = process.argv.slice(2);
if (!origin || !file || !LEVELS.includes(access)) { console.error('usage: node tools/dev-approve.mjs <t3-origin> <link-file> <' + LEVELS.join('|') + '>'); process.exit(2); }
const expected = new URL(origin).origin;
const link = new URL(readFileSync(file, 'utf8').trim());
// Bind to the named T3: the link, its resource, and that server's own metadata must all point at it.
const meta = await (await fetch(`${expected}/.well-known/oauth-authorization-server`)).json();
if (link.origin !== expected || meta.issuer !== expected || link.searchParams.get('resource') !== `${expected}/mcp`
  || `${link.origin}${link.pathname}` !== meta.authorization_endpoint) {
  console.error(`Refused: the link is not a sign-in for ${expected}.`);
  process.exit(1);
}
// Bind to a Pass client on this machine: the code must go to a loopback callback, and the signed client id
// must name that same callback. A client registered elsewhere, with its own redirect, is refused.
const redirect = new URL(link.searchParams.get('redirect_uri') || 'about:blank');
let registered = [];
try { registered = JSON.parse(Buffer.from((link.searchParams.get('client_id') || '').split('.')[0], 'base64url').toString()).r || []; } catch {}
if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname) || redirect.pathname !== '/callback'
  || registered.length !== 1 || registered[0] !== redirect.href) {
  console.error('Refused: the sign-in does not return to a Pass client on this machine.');
  process.exit(1);
}
const p = Object.fromEntries(link.searchParams);
const scopes = access === 'read-only' ? ['orchestration:read']
  : access === 'full-access' ? ['orchestration:read', 'orchestration:operate', 'settings:write', 'source-control:write']
  : ['orchestration:read', 'orchestration:operate'];
const out = JSON.parse(execFileSync(`${process.env.HOME}/.t3/bin/t3`,
  ['auth', 'pairing', 'create', '--json', '--ttl', '5m', '--label', 'The Pass dev approval', ...scopes.flatMap((s) => ['--scope', s])], { encoding: 'utf8' }));
if (typeof out.credential !== 'string') { console.error('t3 auth pairing create returned no credential'); process.exit(1); }
const authorization = Object.fromEntries(['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'resource', 'scope'].map((k) => [k, p[k]]));
const r = await fetch(`${link.origin}/oauth/mcp/decision`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ authorization, decision: { _tag: 'pairing-code', access, code: out.credential } }) });
const body = await r.json().catch(() => ({}));
if (!body.redirectTo) { console.error(`T3 did not approve (${r.status}): ${JSON.stringify(body).slice(0, 200)}`); process.exit(1); }
const cb = await fetch(body.redirectTo);
console.log(`Approved as ${access}. Client callback answered ${cb.status}.`);
