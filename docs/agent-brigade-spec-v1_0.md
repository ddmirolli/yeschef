# Agent brigade and the pass

**Version:** 1.0
**Date:** 2026-11-05
**Status:** LOCKED (Dan ruled D1 to D6 on 2026-11-05 after the one adversarial pass; decision log)
**Home:** this repository since 2026-11-06 (Dan: "why would rw need any part of it"). Moved whole from ReviewWheel `docs/ops/projects/reviewwheel-agent-brigade-spec-v1_0.md` at ReviewWheel `main` 5f1d141ac. Paths that start with `docs/ops/`, `scripts/`, or `.github/` are in the ReviewWheel repository. They describe how ReviewWheel's kitchen runs on the brigade.
**Words:** the stage, panel, and Held words are in `docs/pass-definitions-v1_0.md` (locked 2026-11-06). Where this spec uses an older word, that page wins.
**Governance:** build fit-to-spec (`docs/ops/build-governance.md`), sized and critiqued under `docs/ops/reviewwheel-axe-sharpen-protocol-v1_2.md`.
**Companions:** `docs/ops/rulings/coderabbit-summon-queue.md` (review slots), `docs/ops/rulings/t3-native-tools-first.md` (PR waits), `docs/ops/projects/tier3/reviewwheel-release-sop-v1_2.md` (releases), `docs/ops/rulings/design-enforcement.md` (design checks).
**Supersedes:** nothing in the repository. When locked, it replaces the ATC role that lives outside the repository in the `rw-atc` skill and the handoff ledgers in `~/rw-scratch/atc/` (see "Census").

**Intent line:** Dan runs ReviewWheel from one live screen, the pass, and only makes final calls. Agents carry each dish across stations to a verified plate. The board holds the state, not a thread, so nothing resets except the daily board by design.

We build an operating model (the brigade) and a live tailnet dashboard (the pass) that replace the single ATC thread.

---

## 1. Why

- The ATC holds all state in its own conversation. When the conversation fills, the thread ends and a ledger carries the state forward. `[H]` 17 handoff ledgers exist in `~/rw-scratch/atc/`; two ATC threads ran on 2026-11-04; the newest ledger has 203 narrative lines.
- One ATC does five jobs: merge, line-read, review-slot queue, releases, and relays to Dan. `[H]` read in `~/rw-scratch/atc/handoff-2026-11-04-1600-atc-4c0c66ec.md`.
- Work is verified one PR at a time. Nobody verifies the whole outcome when it crosses products. Dan's example: SEO lives in website head tags and `llms.txt`, in the Rank product, on the Google Business Profile, and in keyword review replies.

## 2. Intake (Dan, 2026-11-05)

Dan's words, quoted from the thread:

- On stations: "restricting agents to different workstations because they're only working on reputation or rank or whatever, is sort of missing the point ... more based off of surface is potentially best."
- On the pass: "a permanent live dashboard ... for everything that's in flight that's on our tail scale network ... I would just live in the pass."
- On roles: "agents would be doing everything, and you would only have to weigh in for any final decisions."
- Dan accepted all four recommendations on 2026-11-05: (1a) seven surface stations plus the tournant, (2a) grow the focus dashboard into a read-only live pass first, then add call buttons, no T3 fork, (3a) the dish is the board unit, (4a) the pilot dish is the dark-mode climb.

**Definition of Done (the scene).** Dan opens the pass on his phone or Mac. He sees each dish in flight, its components by station, each component's gate, and a short list of calls that wait on him, each with lettered options and one recommendation. He opens a call, answers it, and returns to the pass. Agents move the dish to the plate. At close, every open dish shows carry, 86, or blocked. The next morning the board shows the same dishes, rebuilt from live sources, and a new expo runs the service.

## 3. Roles

| Role | Who | Job |
|---|---|---|
| Chef de cuisine | Dan | Sets the menu (priorities), gives taste overrides and release go. |
| Expo | One thread per service | Calls dishes, assigns components, checks plates, merges at the pass. Reads and writes the board. Keeps no state in its conversation that is not on the board. Inherits the ATC duties in the `rw-atc` skill. |
| Station cook | A builder thread per component | Builds one component under its station card. Ends when the component clears the pass. |
| Tournant | A builder thread for a small dish | Carries one small dish across several stations, with every station card it touches. |
| Plongeur | The expo at close | Settles finished threads, stops PR watches, records carry, 86, or blocked. |

**Stations set standards. They are not walls.** Any agent loads every card that its work touches.

## 4. Stations

These are ReviewWheel's stations. Another project names its own. Each station is one card file at `docs/ops/brigade/stations/<station>.md`. This table is the only list of stations.

| Station | Kitchen | Surface it owns |
|---|---|---|
| website | Garde manger | Astro sites (`website/`, `help/`), generated customer sites (`platform/sites/`), head tags, structured data, Tag Manager, `llms.txt` |
| funnels | Entremetier | `ad/` funnels, ad creative, pixels, the signup entry |
| app-ui | Rôtisseur | `platform/app` screens and components, web now, native mobile later |
| backend | Poissonnier | `platform/app/convex`: schema, jobs, webhooks, provider adapters, money and message paths |
| data | Boucher | Zero-party and first-party data sets, Search Console, scans, enrichment, attribution |
| words | Saucier | Customer copy (rw-copywriter lane), specs, rulings, canon |
| design | Pâtissier | Brand, components, mockups, the taste test for customer-facing UI |

**Card contents (template).** Each card has these sections and no others:

1. Owns: paths and surfaces.
2. Taste: the review method for this station (council, CodeRabbit, line-read), by pointer to its ruling.
3. Checks: the commands that must pass.
4. Traps: pointers to rulings and known failures. A card points to a rule. It never restates it.
5. Done means: the observable result for a component at this station.

## 5. The rail (gates)

Superseded by `docs/pass-definitions-v1_0.md` (2026-11-06): the stages are Order, Prep, Fire, Tasting, Plating, Sent, a merge into the base branch is Sent, and the release to production is Dan's own act. The table below is the 2026-11-05 version, kept for its history.

Each component moves through these gates. A dish is at the gate of its least advanced component.

| Gate | Fact that sets it | Source |
|---|---|---|
| Order | Dish exists on the board | board file |
| Prep | Brief or spec exists at its repository path (axe-sharpen sizing) | board file |
| Fire | Branch or PR is open | GitHub |
| Taste | All checks are green and the station's taste method is pending | GitHub |
| Pass | PR is merged to its base (`staging` for app, `main` for website and docs) | GitHub |
| Service | Released to production, with Dan's go. A merge to `main` deploys production, so for website and docs, Pass and Service happen together. | GitHub release, version probe |
| Plated | The expo verified the whole dish in production | board file, with a receipt link |

**Dan's look (customer-facing UI, Dan ruling 2026-11-05).** Dan is the chef at the pass. A customer-facing UI component comes to him only after the council passes it at Taste. The council score rule is in the council ruling (PR #2288). The expo puts one call on the board with two options:

- "Send it out": the component may move to Pass. This is the merge gate.
- "Refire": the component goes back to Fire with Dan's note. It returns to Taste, then to Dan.

## 6. Service: open and close

- **Open.** Dan starts a service by launching the expo (one message). No timer starts it (no scheduled Claude wakeups, global rule). The expo takes the carried dishes from the board file, then refreshes every fact from live sources. It reads no narrative ledger.
- **During.** T3 wakes the expo on PR events (`watch_pull_request`). The expo writes each state change to the board file at that moment.
- **Close.** The expo marks every open dish carry, 86, or blocked on Dan, settles finished threads, and ends. The board file is the handoff. No narrative ledger.
- **Length.** One expo runs one service. A second service the same day starts a new expo from the board.

## 7. The pass

A small local server on the MacBook renders the board on each page load and refreshes the open page every 60 seconds. It reads each source at most once a minute, and only while a page asks.

- **Where:** the Mac's tailnet address on port 8494 (`BRIGADE_ORIGIN`), tailnet only, from `127.0.0.1:8494` (D2). Source: the local Yes Chef repository, `~/Developer/yeschef` (was `~/Developer/agent-brigade`, still a link), outside this repository (amendment 5). Its README holds the install and run steps.

- **Sources:** the board file, `gh` (PRs, checks, releases), Linear (dish issues). It grows out of `~/rw-scratch/focus-dashboard/build.py` `[H]`, which already merges Linear, `gh`, and an overlay file.
- **Views:** calls for Dan (top), dishes in flight with components by station and gate, carried dishes, plated today.
- **Expand to rule:** each call and each dish opens on a click. An open call shows its context, its images at full width, the options, the owning thread, and the description of every PR on the dish. A visual call with no image shows a red "no visuals attached" flag. The page does not reload while anything is open.
- **Missing data:** a source that fails renders "not checked" with the failure time. Stale data never shows as current.

## 8. Contracts

**Board file** (`~/yeschef/board.json`, outside every worktree; `~/agent-brigade` and `~/rw-brigade` link to that folder; the expo writes it, D1). The full current format, with every field added since, is `docs/board-format.md`:

```json
{
  "service": { "opened": "ISO-8601", "expoThread": "T3 thread id", "closed": null },
  "dishes": [
    {
      "id": "REV-123",
      "outcome": "One-line scene of the plated dish",
      "close": "carry | 86 | blocked | null",
      "components": [
        { "station": "website", "thread": "T3 thread id", "pr": 0, "base": "main", "prep": "repo path or null" }
      ],
      "calls": [
        { "question": "text", "options": ["a. ...", "b. ..."], "recommend": "a", "thread": "T3 thread id", "asked": "ISO-8601",
          "context": "plain text; blank lines split paragraphs; lines that start with '- ' are bullets",
          "images": [{ "path": "~/rw-artifacts/<date>/<topic>/<file>.png", "caption": "after, dark, 390" }],
          "links": [{ "label": "text", "url": "https://..." }] }
      ],
      "plating": { "at": "ISO-8601" },
      "plated": { "receipt": "URL or path", "at": "ISO-8601" }
    }
  ]
}
```

The pass derives Fire, Tasting, and Sent from GitHub. The file does not store them. `plating` marks a dish for Dan's look; `plated` is the receipt.

**Answers (S5).** Each open call shows one button per option and an optional note. A click posts to `/answer`. The pass accepts it only when all of these hold. (1) `netstat -anv` proves the request came through Tailscale: the client end of the connection belongs to a live process of another user. `tailscale serve` connects from Tailscale's network extension, which runs as root. Every agent on this Mac runs as Dan, so a direct POST to 127.0.0.1 shows Dan's own process. No row, a process of Dan's user, PID 0, an exited process, or a netstat failure all count as local and are refused. netstat names a socket's last owner even after the client half-closes or closes it, which lsof does not. (2) The login and device that `tailscale serve` sets (`Tailscale-User-Login`, and the client tailnet IP in `X-Forwarded-For`, both of which replace any client copy) match `~/yeschef/pass.allow`. The allowed devices are Dan's phone and this Mac, where Dan works. An agent on this Mac can reach the pass through the tailnet as Dan, so the hard rule below, not the device list, keeps agents from answering. (3) The `Origin` is the pass page. (4) The call and option are on the current board. It sends one message through `t3 thread send` to the call's thread and to the expo. Before the send it appends `{key, dish, question, option, note, login, at, threads}` to `~/yeschef/answers.jsonl`, so a receiver that checks always finds it. A logged call cannot be answered twice. A send that reaches no thread appends a `failed` line, so Dan can click again. A send that reaches only some threads stays answered and shows Dan which thread missed it (HTTP 207), never the board. A message from the pass starts with "Dan ruled at the pass" and carries the answer id. The expo checks that id in the log, acts, and takes the call off the board. To change an answer, Dan writes in the thread. A log line proves a tap on an allowed device through the tailnet, unless a process on this Mac wrote the file directly. No agent ever writes `answers.jsonl` or POSTs to `/answer`.

**Calls carry their full context (Dan ruling 2026-11-05).** Dan must be able to rule from the pass alone. Every call has `context`: what happened, why it needs him, and what each option does. A call on a dish with a website, funnels, app-ui, or design component also has `images`. A dish may carry `context`, `images`, and `links` too. Images live under `~/rw-artifacts/`; the pass serves only that folder.

## 9. Invariants

1. A GitHub fact always wins over the board file for Fire, Tasting, and Sent.
2. A source that fails renders "not checked". The pass never shows a cached value as current.
3. The pass never merges, pushes, releases, or runs a git write. Its one action is S5: it relays Dan's click on a call option to the owning thread and the expo, and appends the answer to its own log.
4. Every dish open at close has carry, 86, or blocked. The next open drops none of them.
5. No Claude agent runs on a timer to update the pass.
6. Each rule lives in one ruling or card. Cards and this spec point to it.

## 10. Slices

| Slice | What | Touches | Depends on | Critical | Done means |
|---|---|---|---|---|---|
| S0 | Probe a supported T3 read and write path | read-only spike | D1 | no | Runs before S5 only; the path has receipts |
| S1 | Seven station cards plus the card template | `docs/ops/brigade/` | LOCK | no | Each card passes `scripts/ste-lint.py` and docs-ref-check |
| S2 | The pass v1, read-only | the pass server (in the Agent Brigade repository since amendment 5), port 8494 | D1, D2 | no | Dan opens the tailnet link and sees the board with live gates |
| S3 | Expo service protocol: open, during, close | `rw-atc` skill evolves to expo | S1, S2, D3 | no | One service opens and closes with no narrative ledger |
| S4 | Pilot dish: the dark-mode climb | design, app-ui, website | S3, D6 | no | Dan runs the pilot from the pass and rules on the scene |
| S5 | Call buttons: Dan answers from the pass | pass server, T3 | S0, D4 | yes (authorization path) | Dan clicks an option on his phone; the owning thread and the expo get it once; nothing without his tailnet login and the pass page's Origin can post |

## 11. Never

- **Never fork T3 in this build.** `[H]` the local `t3code` clone is 84 commits behind origin, and `~/Developer/t3code/docs/orchestration-v2/README.md` calls the orchestrator a rewrite. A fork would conflict at the layer we change.
- **Never keep stations as standing threads.** They fill up and need resets, which is the failure this spec removes.
- **Never let the pass act.** A dashboard that can merge or release turns a view into an unreviewed approval path.
- **Never publish the pass outside the tailnet.** `tailscale funnel` stays banned (global rule).
- **Never write the board into a worktree.** Daily state in a branch creates merge noise and leaks thread ids into the repository.

## 12. Empty states

- No dishes: the pass says the kitchen is clean and shows the last close time.
- No service open: the pass shows the board read-only and a "no expo" banner.
- A source down: "not checked" per Invariant 2.

## 13. Kill switch

Throw this approach away if any of these happen:

- An expo cannot run one full service without a mid-service handoff.
- After the pilot, Dan answers calls in threads instead of on the pass.
- The pass can read T3 thread state only through T3's private database.

## 14. Census

- `[H]` 48 files under `docs/`, `scripts/`, and `.github/` say "ATC". All are project specs or briefs that name the ATC as merger. Historical versions are never re-edited. New specs say "expo" after LOCK.
- `[H]` `docs/ops/rulings/` has no ATC statement. The review-slot rule names the summon script, not a role.
- `[H]` The ATC role is defined only in `~/.agents/skills/rw-atc/SKILL.md` (39 lines) and agent memory. S3 evolves that skill. It does not fork it.
- `[M]` The council merge gate for customer-facing UI exists in agent memory from the hill-climb thread, not in a repository ruling. The design card must point to that ruling once it lands (D6).

## 15. Must verify

| Claim | Tag | Check |
|---|---|---|
| T3 MCP credentials are scoped to one provider session and expire | `[H]` | `~/Developer/t3code/docs/orchestration-v2/orchestrator-mcp-server.md`, "Transport And Authentication" |
| BUB and CUB run on GitHub Actions and cannot read local T3 state | `[H]` | `.github/workflows/briefs.yml` runs on `blacksmith-4vcpu-ubuntu-2404` |
| A local process can read and post to T3 threads through a supported API | `[H]` | S0, 2026-11-05: `t3 thread show` and `t3 thread send` on the running server. The CLI signs in as a short-lived MCP client of the owner and revokes it on exit. |
| The gallery behind port 8443 is a static file server for `~/rw-artifacts` on 127.0.0.1:8730 | `[H]` | `~/rw-scratch/artifacts-server/serve.py`, PID 46872 |

## 16. Decisions (Dan ruled all six on 2026-11-05: "Proceed with your recommendations across the board")

1. **D1 (a).** The expo writes thread ids into the board file. The pass reads GitHub and Linear live. S0 becomes optional: run it only before S5.
2. **D2 (a).** The pass gets reserved HTTPS port 8494 and runs as a login service. The global `CLAUDE.md` tailnet ruling lists it as reserved.
3. **D3 (a).** Dan opens service with one message. The expo closes at 20:00 ET.
4. **D4 (a).** Pass v1 links each call to its thread. Buttons wait for S5.
5. **D5 (a).** One Linear issue per dish. Components are PRs and child issues.
6. **D6 (a).** The hill-climb thread runs the dark-mode climb as the pilot dish and lands its council ruling for the design card to point to.

---

## Decision log

- 2026-11-05 (Dan): stations by surface, not product. Dish is the board unit. The pass grows out of the focus dashboard, read-only first. No T3 fork now. Pilot is the dark-mode climb. Spec drafted at DRAFT status.
- 2026-11-05 (adversarial pass, thread owner, exit fixed before start: one pass, fix, then Dan rules): 3 findings, all fixed. Service open contradicted the board-file handoff (now: carried dishes from the file, facts from live sources). Website and docs merges to `main` deploy production, so Pass and Service coincide. D2 pointed to an unnamed ruling (now names the global `CLAUDE.md` tailnet ruling).
- 2026-11-05 (Dan): D1 to D6 ruled (a). Status DRAFT to LOCKED. The pass port is 8494.
- 2026-11-05 (Dan, amendment 1): "a council score should gate ever bringing customer-facing UI to me for final sign-off and approval ... Then I give one final look and if it's wrong I send it back and give the command to refire. If it's not wrong then I say we're good send it out." Added Dan's look to section 5. The council pass gates the call to Dan; his "send it out" gates the merge. The global agent instructions and PR #2288 carry the same rule.
- 2026-11-05 (Dan, amendment 2): "If something is at the pass, ready for me to rule on it, I should be able to click on it and have it expand and show me full context as well as any visuals that are relevant." Calls gained `context`, `images`, and `links` (section 8); the pass expands calls and dishes (section 7).
- 2026-11-05 (Dan, amendment 3): "how do I action the pass from the pass? ... have buttons on options A and B that when I click it fires to the appropriate thread". S0 ran: `t3 thread send` is T3's supported write path (receipts in section 15). S5 built (section 8, "Answers"). The S5 Definition of Done changed: T3 marks a CLI message as an MCP message, not as Dan. Dan is identified by his tailnet login at the pass, and every answer is logged with it. Any local agent can still post to a thread through MCP, as before; the answer id in the log is how the expo tells a real click from a relay.
- 2026-11-05 (adversarial pass on S5, thread owner, exit fixed before start: one pass, fix, ship): 1 finding, fixed. The pass logged an answer only after the send, so a fast receiver could miss it in the log. It now logs before the send and records a failed send. Open until Dan's first phone click: that iPhone Safari sends `Origin` on a same-page form post (`[M]`; a missing header fails closed with a clear message).
- 2026-11-05 (expo review of #2297, finding 1): a process on this Mac could POST to 127.0.0.1 with Dan's headers and pass every check, so a log line did not prove a tap. Fixed: the pass refuses any TCP peer that its own user can see (probe: a request through `tailscale serve` comes from the root network extension; a local `curl` shows as a process of the same user), and it accepts only allowed devices (Dan's phone). Live probes: the loopback attack with perfect headers and a POST through the tailnet from this Mac were both refused.
- 2026-11-05 (Dan blocked at the pass, amendment 4): phone-only answers refused every tap from the Mac, where Dan works ("I'm basically at a standstill"). The Mac is now an allowed device. Phone-only did not make the log trustworthy anyway, because a process on this Mac can append to the log directly. The loopback refusal and the hard rule stay. The pass now writes each refusal to `pass.log`.
- 2026-11-05 (CodeRabbit round 1 on #2297, head d4b809c7a): 4 findings, all fixed. (1) Major: the peer check failed open when a local client closed before lsof ran (reproduced 3 of 3). The check now accepts only positive proof: the pass's own socket is the only match. (2) A partial send redirected to the board as if it had succeeded; it now returns 207 with the failed thread named. (3, 4) `install.sh` accepted any body containing "ok" and could wait about 90 s; it now needs a 2xx with the exact body "ok" inside a hard 30 s deadline.
- 2026-11-05 (Dan, amendment 5, rulings 1a and 2a): the pass leaves this repository. Its code lives in the local Agent Brigade repository (`~/Developer/agent-brigade`), which serves every project, not only ReviewWheel: each component names its GitHub repository. `automations/brigade/` is removed; this spec still governs the ReviewWheel brigade (roles, gates, stations, board, answers). A design bake-off from the same seed (Claude Opus 5.5, Claude Fable 5.1, GPT-6.1 Sol, GPT-6 Astra) picked the Opus entry, live on port 8494 since 16:20 ET. In Agent Brigade the peer check moved from lsof to netstat (95db1ef): a forged local tap that half-closed or closed its socket left lsof's view; netstat still names the socket's owner. Section 8, item (1), now states that check.
- 2026-11-06 (Dan): the pass's words locked in `docs/pass-definitions-v1_0.md`: stages Order, Prep, Fire, Tasting, Plating, Sent; The Pass is the panel on the right; Held replaces Off the rail; "86" shows as Killed. Shipped in Agent Brigade #3. Section 8 gained `plating`.
- 2026-11-06 (Dan, 2a): the service is `com.agentbrigade.pass` and its data `~/agent-brigade/` (#4). No project is built into the code.
- 2026-11-06 (Dan, 1a): this spec moved whole into the Agent Brigade repository. The Pass serves every project in Dan's T3 Code account, so ReviewWheel keeps no part of it, only a pointer.
- 2026-11-06 (Dan): "Done" becomes **Verified**: a Sent ticket whose receipt is filed. Sent alone means merged, not yet checked. The header counts Verified today.
- 2026-11-10 (Dan, "3. B"): the Python pass (`pass.py`), the board writer (`board.py`), their tests, the board format page and the `com.yeschef.pass` login service are retired, and port 8494 is freed (D2 ends). The Mac app (`desktop/`) and its board server (`client/`) replace them. The shared stylesheet moved to `client/pass.css`.
