# The team relay

**Status:** v0.1, 2026-11-10. Built in `relay/`, `client/seal.mjs`, `client/team.mjs` and `client/roles.mjs`. The screens and the Keychain come in a later PR. **Ruling:** Dan, 2026-11-10, "A": one Yes Chef relay on Cloudflare, free with a cap, and teams can host their own past it. Dan pays the bill. The cap's number waits for usage numbers.

## What it is

The relay is the only server Yes Chef runs. It passes sealed team data between each member's Yes Chef and cannot read it.

- **One Worker, one Durable Object per team.** The Worker routes `/v1/teams/<team>` to that team's object (`relay/worker.mjs`). The team's logic is plain JavaScript (`relay/room.mjs`), so the tests run it in Node.
- **SQLite storage.** Cloudflare's free plan runs only SQLite-backed objects.
- **WebSocket hibernation.** A team's object sleeps between messages while its sockets stay open, so a quiet team costs no duration. A `ping` gets its `pong` without waking the object.
- **The same pattern as T3 Code's relay, not its code or service.** T3 runs one relay on Cloudflare, free for now with a cap of 3 machines per account, and says "you can always fork it, self host, or use Tailscale" (`docs/user/faq.md` in T3 Code, read 2026-11-10).

## What the relay keeps, and nothing else

| Kept | Plain or sealed | How long |
|---|---|---|
| The roster: member ids, public keys, who may invite | Plain, signed by the lead | Until the lead changes it |
| Names, roles and permissions | Sealed with the team key, inside the roster | As above |
| The latest summary per member | Sealed and signed | Replaced on each update: no history |
| Open invites: a hash of each invite's proof, its end, its secret | The secret sealed with the team key | 7 days at most |
| Asks to join | Sealed with the invite's key; the public keys plain | Until the lead answers or the invite ends |
| Messages between members: actions, results, the welcome, a member's ask for the key | Sealed and signed | Until the receiver takes them, 15 minutes by default, 7 days at most |
| Usage per UTC day: requests, messages, rows written, bytes in | Plain counts | 90 days |

It keeps no code, no diffs, no T3 Code tokens and no history. A team id that nobody made gets no tables: a stray request writes nothing.

## Keys

All WebCrypto (`client/seal.mjs`), so the app and the relay share one file.

- **A member** is two P-256 key pairs made on the member's Mac: one signs (ECDSA), one agrees keys (ECDH). Its id is the first 16 bytes of SHA-256 over the signing key. The private keys never leave the Mac.
- **The team key** is AES-GCM, 256 bits, made by the lead. It seals summaries, actions and the roster's names and roles.
- **Every seal names where it travels** (its additional data: the team, the kind, the sender, the receiver). The relay cannot move a sealed blob to another member or kind.
- **Summaries and actions are also signed** by the sender, inside the seal. A member who holds the team key still cannot speak as another member.

## The invite

The first design had the team key itself travel in the link. The build sends an invite secret instead, and the team key only after the lead approves:

1. The lead's Yes Chef makes the link: `https://yeschef.codes/join#<payload>`. The payload names the relay, the team, the invite, the invite's secret, the lead's signing key, the end time (7 days), and the lead's and team's names. Everything after the `#` stays in the browser: no server sees it.
2. The relay gets only a hash of the invite's proof (derived from the secret with HKDF), the end time, and the secret sealed with the team key, so the lead can read asks that come in on a deputy's invite.
3. The dev's Yes Chef sends the proof and an ask sealed with the invite's other key (the dev's typed name, the projects shared), signed with the dev's signing key over the team, the invite, the dev's key agreement key and the sealed ask. The relay checks the proof's hash and the signature, then stores the ask. HKDF does not run backwards, so the relay cannot open the ask. The lead's Yes Chef checks the signature again before it shows the ask, so nobody can pair a dev's signing key with their own key agreement key and catch the team key in the welcome.
4. The lead approves with a new roster that lists the dev, then seals the team key to the dev's ECDH key.

A leaked link lets someone ask to join, never read anything. Each ask waits for the lead.

## Who may do what on the relay

- **Make a team:** anyone, with a first roster they sign as its lead. Team ids are 16 random bytes.
- **Open a socket:** a member, or a dev whose ask waits, with a token they sign over the team, method, path and time. It holds five minutes either side of the relay's clock.
- **Change the roster:** the lead only. The relay pins the lead's key from the team's first roster, and each roster's version is one more than the last.
- **Invite:** the lead, and members the roster marks `invite`.
- **Answer an ask:** the lead (approve by roster, or decline). A revoke also drops the asks on that invite.
- **Delete the team:** the lead. The relay deletes everything it keeps for that team.

The relay checks only who may change the team. What a role may do to a dev's threads is checked on the dev's own Mac, against the roster the lead signed.

## The app

`client/team.mjs` is one dev's Yes Chef on the relay; `client/roles.mjs` holds the roles. `client/teamhost.mjs` keeps the team alive in the board server and answers `/team` and the `kind=team` actions; `client/teamui.mjs` draws the screens.

**The screens** (mock v1, Dan's picks of 2026-11-10). ⌘K, Invite your team, opens `/team`. With no team: Make a team (team name, your name, the relay, `https://relay.yeschef.codes` by default) or open a link. The lead's page: the asks drawer at the top left, the link with Copy link and New link, and the chart: the lead, the Deputies, the areas with their Area owners and Engineers, Add area, and the Viewers aside. Dragging an ask (or a member) onto a slot opens the role dialog with that role and area; clicking one opens it too, for the keyboard. The dialog shows the dev's code, the role, the boxes (See is locked on) and the area, then Add to team or Decline. The dev's side: Join (name, T3 Code, the projects to share, what the team sees), the waiting screen with the code in large type, and the joined screen with the role, who can act on their threads, and the sharing switches. Declined, removed and deleted each have their own screen.

**The match code** (Dan's 2a). Six digits, the same on the dev's waiting screen and beside the ask at the lead: SHA-256 over the team, the invite, the invite's secret and the dev's two public keys. A key swapped on the way gives other digits. The relay knows the keys but not the secret, so it cannot try keys until one gives the dev's digits.

**Areas** travel inside the roster the lead signs, sealed with the team key: the list of names and each member's area. Only an Area owner or an Engineer sits in one. Until Rules gives an area its projects and mode, it is a name only. Each member's `under` (who they report to) goes there too, from the chart: an Engineer in an area reports to its first Area owner; everyone else reports to the lead. Each Mac checks it: an `under` that names nobody on the roster, or loops, reads as not checked.

**The link.** `https://yeschef.codes/join#<invite>` is a static page (`site/join.html`). It hands the fragment to the app as `yeschef://join#<invite>` and sends it nowhere else: no referrer, no request. The app opens Join with it.

**Where the state lives.** The desktop app seals the team state with the Keychain-held key, as it does the sign-in (`team.bin` next to it), and writes a new file before it replaces the old. A saved team that does not open is left untouched, and the page says not checked; a new team or a join cannot write over it. The web prototype keeps the team in memory only.

**What it keeps.** This Mac's two key pairs, the team key, the lead's signing key from the invite, the highest roster version it took, the projects this dev shares, the welcomes the lead still owes, when it last asked the lead for the key, and the ids of recent teammate actions. The app seals all of it before it touches a disk.

**The summary.** Only from the projects the dev shares, and nothing from coordinator threads. Per ticket: the thread id and title, the project, the stage, whether it waits on a person, agents working, open questions, whether the agent asked a decision, up to five PRs (repository, number, state, link), and the last update. No messages, no code. At most 100 tickets, waiting ones first, cut to fit 64 KiB. It goes only when it changed, at most once per the relay's limit, always the newest, and is cut again if its sealed size is over the limit. A Viewer sends none, and a dev made a Viewer sends a forget. Sharing nothing sends a forget. Dropping a project rebuilds the waiting summary at once, so the dropped project's tickets never go out, even when a summary was being sealed at that moment. A summary the relay refuses is dropped; a relay that does not answer is tried again after 20 seconds, then 40, up to 5 minutes. A teammate's screen shows the time the dev's Mac signed, not the relay's, and an older summary never replaces a newer one.

**Roles.** The words Dan approved on 2026-11-10. The Deputy's boxes are the ones Dan approved. Engineer = See only is Dan's ruling of 2026-11-10. The Area owner and Viewer defaults are proposed.

| Role | Boxes by default |
|---|---|
| Lead | All, always |
| Deputy | See, Reply, Edit the projects and the shared code list, Invite people |
| Area owner | See, Reply, Merge, Request changes or Hold |
| Engineer | See |
| Viewer | See. Sends no summary |

"See every ticket in the projects the team shares" is every role's. The lead can tick or clear any other box per person; the roster carries the result.

**A teammate's action.** Reply needs Reply. Merge, Request changes, Hold, and answering an agent's question or decision need Merge, Request changes or Hold. Settle and New thread never come from a teammate. The dev's own Yes Chef checks, in order, before anything reaches T3:

1. The seal opens with the team key and names this dev as the receiver, and the sender's signature holds against the key in the roster the lead signed.
2. An action seen before gets its first answer again and does not run twice. The seen ids survive a restart.
3. It is at most 15 minutes old, and at most 5 minutes ahead.
4. The sender's role allows it, as the lead's roster says. What the sender's own Mac claims does not count.
5. This dev shares tickets, the board is fresh (read without error in the last 60 seconds), and the thread is in a project this dev shares.

A teammate's action that arrives before the lead's welcome stays on the relay, not taken, and runs once the welcome brings the team key. Then it runs through the dev's own capped T3 sign-in, as the dev's own actions do (`client/actions.mjs`), with the message signed "Sam Ortiz (Lead), from Yes Chef: ". The answer goes back sealed and signed. An answer that comes after the sender stopped waiting still reaches the sender's screen.

**Reconnects** follow T3 Code's rules. One timer owns retries. The wait doubles from 1 second with full jitter, capped at 5 minutes. A wake probes at once. A ping every 30 seconds, and no pong in 10 closes the socket. The relay's close codes end the team on this Mac (declined, removed, deleted) or reconnect at once (approved). A socket that never opens asks `/me`: a 401 ends it as declined or removed, unless the relay's clock says this Mac's clock is off. The socket's health is its own field: nobody reads as online, and no summary as live, while this Mac's socket is not. A summary reads as live only while its sender is online and its board was read in the last 15 minutes. A sender sends an unchanged summary again every 10 minutes, so one that keeps reading its board stays live. A roster older than the highest version this Mac took ends the connection, even after a restart. A roster the lead signed without this Mac ends it as removed, even when the relay never closes the socket. The lead owes an approved dev the welcome from before the roster goes, so an answer the relay lost cannot leave the dev without the key. A dev on the roster whose welcome expired unread (7 days on the relay) asks the lead for another, at most once a day, sealed to the lead's key; the new welcome is sealed to the dev's own key, so a forged ask gains nothing.

## Limits and the cap

Settings are the Worker's vars (`relay/wrangler.jsonc`, `deploy/relay/wrangler.jsonc`).

| Var | Default | What it does |
|---|---|---|
| `SUMMARY_MIN_MS` | 10000 | One summary update or forget per member per 10 s. The app keeps the newest and sends it after. |
| `MAX_DEVS` | empty (off) | Members per team, asks included. |
| `MAX_DAILY_REQUESTS` | empty (off) | Requests plus messages the relay took for the team per UTC day. Refused ones do not count, so a stranger who knows the team id cannot spend it. The lead can always delete the team. |
| `USAGE_TOKEN` | unset (off) | A secret, set with `wrangler secret put`. Turns on `GET /v1/usage`. |

Fixed: a request body is at most 64 KiB, read no further; a socket frame at most 68 KiB, and a larger one closes the socket unread; a summary is at most 64 KiB, a message 16 KiB; 50 asks, 20 invites and 100 waiting messages per team; 4 sockets per member (a fifth closes the oldest); one ask to join per key per minute.

**Expiry.** Each team's object sets an alarm for its next expiry (an invite, a waiting message), so an idle team keeps nothing past its time. An ask ends with its invite: the waiting dev hears it and their socket closes, and the inviters hear it is gone. A forget empties the summary and keeps only its time, so forget and summary share the one limit.

**The cap.** Dan's ruling leaves the number open until there are usage numbers. `GET /v1/usage?days=7` (with `Authorization: Bearer <USAGE_TOKEN>`) lists each team's days, 40 teams a page:

```json
{ "teams": [{ "team": "…", "created": 1794333378448, "members": 4,
  "days": [{ "day": "2026-11-10", "requests": 52, "messages": 940, "rows_written": 611, "bytes_in": 1830000, "refused": 3 }] }],
  "total": 1, "next": null }
```

- `requests`: HTTP requests and socket opens the relay took. `messages`: socket messages in from members. Cloudflare bills a socket message at a twentieth of a request on the paid plan.
- `refused`: requests and messages the relay turned away (a bad token, a stray path, a dev not let in yet, a team over its cap). They write nothing of their own: the count waits in memory and goes in with the next real write, so it can run low when the object sleeps between them.
- `rows_written`: the team's data rows. Counting adds one more row write per request or message, for the usage row itself; that write is not in the number.
- Cloudflare's free plan allows 100,000 requests, 100,000 rows written and 13,000 GB-s of duration a day across the account (pricing page, read 2026-11-10).
- A team whose delete stopped after its data went, but before the registry heard, reads as gone and leaves the registry at the next usage read. So the list heals itself.

## The socket

JSON text frames. A message from the app carries an `id`; the reply carries the same `id`, as `{ "t": "ok" }` or `{ "t": "err", "code", "text" }`. A capped reply (`err cap`) carries it too.

| From the app | Who | Does |
|---|---|---|
| `summary { blob }` | member | Replace this member's summary. `err slow` with `retryAfter` inside the limit. |
| `forget` | member | Drop this member's summary: they stopped sharing. |
| `send { to, blob, ttl? }` | member | A sealed message for one member. |
| `done { item }` | member | Take a message: the relay deletes it. |
| `invite { invite, verifier, until, box }` | lead, `invite` members | Open an invite. |
| `revoke { invite }` | lead, the invite's maker | End an invite and its asks. |
| `decline { m }` | lead | Refuse an ask. |
| `roster { roster }` | lead | A new signed roster: approve, change roles, remove. |

| From the relay | Means |
|---|---|
| `hello` | On connect. A member gets the roster, every summary, its waiting messages, who is online, and (for inviters) the open invites and asks. A dev who waits gets `role: "pending"` only. |
| `summary`, `gone` | A member's new summary; a summary dropped. |
| `inbox` | A sealed message for this member. |
| `roster`, `presence` | The team changed; a member came online or went offline. |
| `pending`, `pending-gone`, `invite` | Asks and invites, for inviters. |
| `declined` | To a waiting dev: the ask was refused or its invite revoked. |

Close codes: 4001 approved (connect again as a member), 4002 declined, 4003 removed, 4004 team deleted, 4005 replaced by a newer socket.

## HTTP

| Request | Body | Answer |
|---|---|---|
| `POST /v1/teams/<team>` | `{ roster }`, version 1, signed by its lead | 201, or 409 if it exists; a 500 leaves nothing, so the app can try again |
| `POST /v1/teams/<team>/join` | `{ invite, proof, sign, dh, blob, sig }` | 202 `{ m, until }`; 403 bad proof, bad signature or `MAX_DEVS`; 410 the invite ended; 429 asked a moment ago, or the cap |
| `GET /v1/teams/<team>/ws?auth=<token>` | (WebSocket) | 101; 401 unknown member or old token; 429 the team's cap |
| `GET /v1/teams/<team>/me` | header `Authorization: YesChef <token>` | 200 `{ m, role, now }`; 401 `{ now }`: the relay does not know this key (declined, removed) or the Mac's clock is off; 429 the cap |
| `DELETE /v1/teams/<team>` | header `Authorization: YesChef <token>` | 200, lead only |
| `GET /v1/usage?days=&after=` | header `Authorization: Bearer <USAGE_TOKEN>` | 200, or 404 without the token |

## Tests

- `node --test client/seal.test.mjs relay/*.test.mjs`: keys, seals, invites, and the room in Node (`relay/fake.mjs` runs Cloudflare's SQL API over `node:sqlite`).
- `node relay/smoke.mjs <relay origin>`: the whole flow over real HTTP and sockets, against `wrangler dev` or a deployed relay. It makes throwaway keys and deletes its team at the end.

## Open

- **The cap's number:** Dan sets it from `/v1/usage`.
- **The Merge box has no area scope yet.** The rule: a Merge box covers every ticket in a French Brigade area, and only shared code changes in an Open kitchen area. Until areas exist, the box covers every project the dev shares.
- **A member who leaves still holds the team key.** The relay stops serving them the moment the roster drops them. Rotating the team key on removal is not built.
- **Pairing tokens last 30 days**: renewal and revoke on leaving.
