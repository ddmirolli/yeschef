# The Pass as a product: brief

**Status:** DRAFT for Dan (2026-11-06). **Owner:** the thread that wrote it. **Words:** `docs/pass-definitions-v1_0.md`. **Spec:** `docs/agent-brigade-spec-v1_0.md`.

## Intent

Dan, 2026-11-06: "a live website where people could go and create an account and download an Electron app of the pass, sign in with their T3 Connect account, and use the pass to orchestrate their entire T3 code pipeline with an Agent Brigade style orchestration layer ... this is basically like a skin to T3 Code."

The Pass is an interface layer. T3 Code runs everything. The Pass reads projects and threads from T3, shows them as a brigade, and sends each action back to T3.

## Rules

- **The Pass holds no project credentials.** No GitHub, Linear, or vault keys. Its only credential is the user's T3 sign-in, kept in the system keychain.
- **T3 is the only source.** Projects, threads, linked pull requests, and questions that wait on the user come from T3. Each project inherits its configuration and permissions from T3.
- **Every action goes through T3.** A send, a refire, an answer, or a new thread is a T3 tool call. The access the user grants at sign-in caps what the Pass can do.
- **No fork of T3.** T3 is open source (MIT, T3 Tools Inc.). The Pass builds on its supported client path. A change the Pass needs in T3 goes upstream as a contribution.
- **Themes.** The Pass has its own default theme. A user can import a T3 Code theme or a VS Code theme as JSON. T3 exports its themes in that form (T3 `docs/user/appearance.md`).

## How it connects (verified 2026-11-06)

Sources: T3's own docs and source in `~/Developer/t3code` (clone at 20497e4890, 2026-10-29), and the live local server.

- **Sign-in.** Any client that speaks remote MCP over HTTP with OAuth can connect to `https://<environment>/mcp`. On the same computer it can use `localhost`. From anywhere it uses the T3 Connect address. (`docs/user/outside-agents.md`.)
- **Approval.** The user approves the sign-in on a T3 page and picks an access level: read-only, approval-required, auto-accept-edits, auto, or full-access. A sign-in lasts 30 days and can be revoked under Settings, then Sharing & access. (`packages/contracts/src/auth.ts`, `mcpClientScopes`.)
- **The protocol.** Authorization code with PKCE, public clients, open client registration at `/oauth/mcp/register`. Redirects must be `https`, or `http` on `localhost`, `127.0.0.1`, or `[::1]`. (`apps/server/src/auth/McpOAuth.ts`; live metadata from `127.0.0.1:3773/.well-known/oauth-authorization-server`.)
- **Tools.** Read projects and threads, start and message threads, wait on a thread, answer a pending question (`t3_pending_request`: list, read, respond), and link pull requests. Thread reads include linked pull requests. (`docs/orchestration-v2/orchestrator-mcp-server.md`.)
- **No push for outside clients.** An outside client's token works only on `/mcp`: "MCP client tokens are restricted to /mcp; HTTP API and WebSocket RPC would bypass their access cap" (`apps/server/src/auth/EnvironmentAuth.ts`). T3's live subscriptions run on the WebSocket, and `/mcp` has no subscription or notification channel. So the Pass polls, and uses `t3_thread_wait` to wait on a thread. True push needs an upstream change. *Since build step 3 (2026-11-10): the Pass follows T3's WebSocket with a separate key, a pairing limited to `orchestration:read` (`client/t3live.mjs`). The MCP sign-in still cannot open the socket (checked live: 401 on the socket ticket).*

## The model on T3

| Pass | T3 |
|---|---|
| Project, and the All projects menu | T3 projects, across each environment the user signs in to |
| Station agent | A thread |
| Call at the pass | A pending question on a thread |
| Fire, Tasting, Sent | The state of the thread and its linked pull requests |
| Ticket | Open. One choice: a parent thread, with one child thread per station. Then the Pass stores nothing of its own. |
| Plating, Verified | Open: they need a place to live in T3, or a small store in the Pass account |

## What the website and account are for

Open. The account can carry the download, updates, and billing. It never holds T3 data.

## Today's pass

The Python pass on port 8494 stays live as the working prototype. Its design and words carry over. Its local rules (standard library only, tailnet only, answers only) govern the prototype, not the product.

## S0: the client spike

Prove the loop on Dan's Mac before any app code.

1. Register an outside client, and Dan approves it once (T3 labels the levels Read only, Supervised, Auto-accept edits, Auto, Full access).
2. List the tools the client gets. Read every project, a thread list, and one thread with its pull requests.
3. Time a poll of the thread list. Wait on one thread with `t3_thread_wait`.
4. Start one scratch thread that asks one question, and answer it with `t3_pending_request`.
5. Keep the token in memory only. Write a report without it.

Done means a report with the tool list, timings, and each step as passed or failed.

## S0 results (2026-11-06, through T3 Connect)

Run: `node spikes/t3-client-spike.mjs https://prod-1f046a21d95ebc69.t3coderelay.com` (this Mac's T3 Connect address). Dan told the thread to configure the sign-in itself, so it approved with a 5-minute pairing code from `t3 auth pairing create`, access "full-access". A real user approves on T3's page instead.

| Step | Result |
|---|---|
| Register a client | Passed (201) |
| Sign-in approved | Passed. Scopes `orchestration:read orchestration:operate settings:write source-control:write`, 30 days |
| MCP initialize | Passed, 30 ms. Server "T3 Code" 0.1.6. Capabilities: logging, tools, completions (no subscriptions) |
| Tools | 66, the same set T3's own agents get: thread list, read, send, launch, wait, interrupt, pending requests, projects, worktrees, `delegate_task` |
| Read every project | Passed, 46 ms, 10 projects |
| Thread list, all projects | Passed, 206 ms. Five polls, each checked: 191 to 208 ms, none failed |
| One thread with its PRs | Passed: linked PRs with their state |
| Start a scratch thread | Passed, 78 ms |
| `t3_thread_wait` returns when the thread asks | Failed: it ran to its 30 s timeout while the question waited. Poll `t3_pending_request` instead |
| See and answer the question | Passed: listed, read, answered "a" |
| The thread got the answer | Passed: the run completed and its final reply is exactly the answer sent ("a") |
| Token refused outside `/mcp` | Not tested. A real check needs a WebSocket handshake with T3's protocol. The source is the evidence (see above) |

What it proves: a client with no stored secrets except its T3 sign-in can see every project and thread, read PR state, start threads, and answer questions, over T3 Connect, at about 0.2 s per poll. The second run (strict checks, after PR-Agent's review) gave these numbers.

## The web prototype (Dan's 1a and 2a, 2026-11-06)

`client/` is the first client: read-only, Node standard library, no stored data.

- `client/t3mcp.mjs`: sign-in (OAuth with PKCE) and a small MCP client. The token stays in the process.
- `client/board.mjs`: T3 threads as tickets. A ticket is a top-level thread; its subagent threads are its stations. Stages: Order (never ran), Prep (ran, no PR), Fire (any thread running), Tasting (a PR open), Plating (a PR open and a question waiting), Sent (PRs merged), Verified (settled in T3 today with nothing open or running; older ones leave the board). A settled ticket with an open PR or running work keeps its stage. Held: Stopped, Failed, Snoozed. A waiting question puts a ticket at the pass in any stage. So does a hand-back: a top-level thread whose run ended and that is not settled has given the turn back to Dan, and waits at the pass as "Your turn" with the agent's last message. Settling the thread in T3 clears it (Dan, 2026-11-06, "A"). A finished ticket in Sent is already merged, so its main action is Settle, which moves it to Verified; it offers no Go (Dan, 2026-11-06). Coordinator threads (titles starting ATC or Expo) never wait at the pass. With no good poll, the page shows no tickets and says "not checked".
- `client/server.mjs`: follows T3's live shell stream (`client/t3live.mjs`, read only) instead of polling, and builds the board from it (open threads, settled threads from the last 14 days, and any missing parent of active work, `client/shells.mjs`). It reads over MCP only what the stream lacks: projects, waiting questions and hand-backs, each again only when its thread changes. It pushes each change to the page over server-sent events, and a beat every 5 s. Without a live, synchronized stream the page says "Not checked". It also reads each open thread's changed files and line ranges with a read-only `git diff` in its folder (`client/changes.mjs`), for the team calls; nothing shows them yet. Each T3 request has a 20 s deadline. Run `node client/server.mjs [t3-origin] [port]`.
- `tools/dev-approve.mjs <t3-origin> <link-file> <access>`: dev only, approves the sign-in on the machine that runs T3. It refuses a link for any other origin. Users approve on T3's page.
- Tests: `node --test client/board.test.mjs client/t3mcp.test.mjs`.

## Open

1. The ticket model in T3 (a parent thread, or something T3 adds).
2. Where Plating and Verified live.
3. Polling cost and limits for many projects, and whether to contribute push for MCP clients upstream.
4. The account and the website: what they carry.
