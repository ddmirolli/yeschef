# The Pass: definitions

**Status:** LOCKED (Dan, 2026-11-06). **v1.1** (Dan, 2026-11-10): developer words inside the product. "We should not try to be clever inside the product." Kitchen words are for marketing and education only. **v1.2** (Dan, later on 2026-11-10): the two modes keep their kitchen names in full, Open kitchen and French Brigade, and In progress turns gray. **Supersedes:** the stage words in `docs/design-brief-v1_0.md` once Dan locks this page. **Mock:** `docs/mocks/pass-v2-mock.html`. **Reference scene:** The Bear, S2E7, "Richie Steps Up at the Michelin Star Restaurant" (youtu.be/1ABxxKbqXhc). Dan: "a sensational example of what The Pass should do."

One rule governs this page: one word, one meaning. Inside the product, words developers already know name everything: the things, the stages, the actions and the labels (v1.1). Kitchen words stay in marketing and education. The brand (Yes Chef, the cloche), the panel name (The Pass) and the two mode names (Open kitchen, French Brigade) stay.

## Names

- **Yes Chef:** the product and the system (Dan, 2026-11-06; formerly Agent Brigade). Agents work like a French kitchen brigade: one chef, one expo, a line of station cooks. That picture is for marketing and education; the product uses the words on this page.
- **The Pass:** the tool, and the expo. It replaces the ATC thread in T3 (Dan, 2026-11-06). On screen, the name appears once: as the title of the panel on the right. The logo stands alone top left.
- **Lead:** Dan (Chef de cuisine in marketing). **Line:** the area agents, one T3 thread each.
- **Project:** a T3 project. The project menu defaults to **All projects**, which has no icon (Dan, 2026-11-09: for clarity).
- **Ticket:** one outcome, usually one Linear issue. A ticket can have several PRs, one per area.
- **Area:** a kind of work: website, funnels, app-ui, backend, data, words, design. The board file's field keeps its old name, `station`, so live boards stay valid.

## Stages

Tickets in a stage are **in flight**. A ticket sits at the stage of its least advanced PR.

| # | Stage | Meaning | Enters when | Leaves when |
|---|---|---|---|---|
| 1 | Backlog | No brief yet | It is on the board | The brief is locked |
| 2 | Planned | Brief locked, agent and worktree assigned | The brief is locked | The agent starts building |
| 3 | In progress | Agents building: commits, draft PR, checks running or red | First commit or PR, or a change request | The PR is ready and checks are green |
| 4 | In review | Council, hill climbing, PR-Agent, CodeRabbit where used | PR ready, checks green | Reviews pass |
| 5 | Ready to merge | The lead's look | Reviews pass | The lead merges, requests changes, or holds |
| 6 | Merged | Merged and deployed to staging. A project with no staging: merged to main. | The merge lands | The receipt is filed |

The release from staging to production is the lead's own act. It is not a stage.

A stage is a label, never stored data. The Pass works out each stage from GitHub and T3 on every read, so older boards and threads read the same under the new words.

## Counts

In the header, right of the logo: **Active** (tickets in a stage), **Verified today** (tickets whose receipt was filed today), **On hold**. The board has no "In flight" label; the word stays in this page only.

## The Pass (the panel)

- **The Pass:** the panel on the right. Subtitle: "Needs your focus. Oldest first." It lists every ticket that needs the lead: every question at any stage, and every ticket at Ready to merge.
- **At the pass:** a ticket that needs the lead. It keeps its column and its count, and shows a blue edge and the blue cloche.
- **Blue** means "at the pass", matching the logo.
- **GitHub colors** (Dan, 2026-11-07): the stages that are pull request states wear GitHub's Primer colors. In review is an open PR, green (`#1a7f37` light, `#3fb950` dark). Merged is merged, purple (`#8250df`, `#ab7df8`). A closed PR and a Canceled ticket are closed, red (`#d1242f`, `#f85149`). Backlog, Planned and In progress are a gray ramp, lightest to darkest. Ready to merge stays blue. *In progress was amber until 2026-11-10. Dan: "orange tells me that something's wrong".*
- **The action bar** (Dan, 2026-11-10, mock v1, calls 1a, 2a and 3a): the open ticket's actions sit in one row, bottom-left, pinned to the ticket's foot, in every view (the reader, the sheet over the full kitchen, phones, and the team views). The message scrolls above it, and the row looks the same at 1440 and 2560. In order: the blue action, then Changes and Reply as an icon and one word, then Hold and Settle as icons after a thin divider, then More (⋯).
- **The blue action:** the recommended one. Merge, Approve, "Send a" on a question, or Settle once merged. With two questions it names both picks ("Send 1a, 2b"); with three or more it reads "Send all", and its tooltip lists every pick. ⌘↵ sends it. While R or F arms Reply or Request changes, that one turns blue and takes ⌘↵.
- **Keys** show only in a tooltip, on hover or keyboard focus: the full name, then the key ("Merge: the agent merges it  M or ⌘↵"). The bar shows no key at rest.
- **More** (key `.`, as in Gmail): a floating card above the button. Each row is an icon, a word and its key: Add a note (N), Open in T3 (O). New actions go here, not in the row.
- **Hints** (a wrong key, a refused send) show just above the bar, so the buttons never move.
- **Phones** (call 2a): four slots. The blue pill, then Changes, Reply and More, each an icon over a small word. Hold and Settle move into More, which opens as a sheet from the bottom.
- **A narrow window**: the bar steps down by the ticket's own width, so it never clips. Under 560 px, Changes and Reply show only their icons. Under 420 px, Hold and Settle move into More, with their keys. Under 300 px, the row wraps. The tooltips keep every name and key.
- **Merge** (key M): the lead sends a ticket with an open pull request out. The agent merges it.
- **Approve** (key A): on a ticket with no open pull request there is nothing to merge, so the same button is Approve. The agent goes ahead with what it handed back, a plan or a finding (Pass call 1a, Dan, 2026-11-10). A ticket with a question shows no Approve, so A never meets option a. A pull request that opens or closes after the lead looked stops the send: the lead looks again.
- **Request changes** (key F, "say what to fix"): the lead sends a ticket back to In progress. It always carries a note to the agent: what to fix. The button says "Changes" (call 1a); the tooltip, the keys sheet and the toasts keep "Request changes".
- **Reply** (key R): a note to the agent, with no stage change.
- **Hold** (key H): the lead moves a ticket to On hold, until 8:00 tomorrow.
- **Settle** (key E): the ticket leaves the pass. Once merged, Settle moves it to Verified.
- **Cancel:** the lead cancels a ticket. It moves to On hold, under Canceled.
- **Seen:** the agent picked up the lead's call, read from T3 thread state. A call with no pickup after 5 minutes shows "Not seen" in red.

## Labels on a ticket

- **Up next:** the next ticket to reach Ready to merge.
- **ETA N min:** the ticket should reach Ready to merge in about N minutes. Shown only from a real estimate, with its time. Never guessed.
- **Merging:** the lead merged. The merge and the staging deploy are running. A failure sends the ticket back to In progress, in red.
- **Runner:** the agent that carries the ticket to staging after a merge.
- **Verified:** a Merged ticket whose receipt is filed: the expo checked the whole ticket works. It moves to the Verified group at the end of Merged, with a green check, and counts as Verified today (Dan, 2026-11-06: "change Done to Verified"). Merged alone means merged, not yet checked.

## Layout

- **Header:** the logo, then the counts. No bar line or material: the columns start right under it. In the Pass on a wide screen there is no header: the logo sits on The Pass's row in the stage list, the columns start at the top, and a red "not checked" strip shows under them (Dan, 2026-11-08). The logo still switches views.
- **Stage list foot:** in the Pass on a wide screen, the project menu (All projects by default) sits under the stage list, pinned to the bottom of the column with no rule above it (Dan, 2026-11-09), with the Live light and Settings in two equal boxes on the line under it (Dan, 2026-11-08). The highlighted stage names the open list, so the list has no title of its own. The Pass item has no cloche: the app icon beside it is the only one.
- **The focused Pass, wide:** three columns. The stage list; the tickets, which scroll in their own rounded column; and the reader, a separate panel. The logo, The Pass item and both panels share one top line, and the logo sits in the same place in both views (Dan, 2026-11-08).
- **Open ticket:** nothing opens by itself. The reader stays blank ("Pick a ticket to read it here.") until the lead picks a ticket. The picked card shows a blue left edge, in light and dark, and keeps its four round corners. Cards sit 12 px from both sides of their column. After a send, the next ticket at the pass opens (Dan, 2026-11-08).
- **Ticket head:** the title (the T3 thread's), the blue pill with the number of questions, the model in the top bar, the pull requests and the screenshots stay pinned at the top of the reader while the message scrolls under them, when they leave the message at least half the reader (Dan, 2026-11-08).
- **Reader:** the open ticket fills the reader, framed only by a thick border in the column's colour. Its actions stay pinned to the bottom, like Gmail's Reply and Forward (Dan, 2026-11-08), in the action bar.
- **Cards:** a ticket card reads like an email (Dan, 2026-11-08). Top line: the project's icon and name, the model, the age. Then the T3 thread's title, one line of preview (the first question, or the gist of the agent's last message), and labels: the blue pill with the number of questions ("3 questions"), the stage, and up to two PR numbers with a dot for open or merged ("+N PRs" for the rest). The question's options and the recommendation are not on the card. Compact density hides the preview.
- **Several questions:** the answer area shows one question at a time, as a card with "1 of 3", arrows and a dot each (Dan, 2026-11-08, over a Gmail-style stack). A pick, or a letter key, brings the next unanswered question forward; ← and → move between them. The buttons stay pinned under the card, so the area keeps its height however many questions there are. A question's options stop at the reading width (Dan, 2026-11-10).
- **Shortcut keys:** the action bar's keys show in its tooltips only (Dan, 2026-11-10). Open in T3 shows its key as a small badge when you hover over or tab to it.
- **Settings:** Density for the lists, Rules, and Shortcuts. There is no Ticket layout choice: the Side panel layout is gone, and every ticket uses the action bar (Dan, 2026-11-10).
- **Pills:** one pill, blue, and it means a decision waits on the lead. It names how many: "1 question", "3 questions". Every ticket at the pass waits on the lead, so the pill never says "Asks you" (Dan, 2026-11-08). A hand-back has no pill: its stage already says what it wants.
- **Kitchen and phones:** no stage list, so the Live light, the project menu and Settings sit at the right of the header.
- **Live light:** "Live", or "Not checked" when a source fails. Its tooltip names the T3 Code server and when it was last checked. The app has no footer; `?` and Settings open the shortcuts. The Pass web page (`pass.py`) keeps its footer.
- **Light and dark:** in the app, light mirrors dark. A white page, grey panels, white cards inside them.
- **Lost connection:** the lists and counts hide and say "Not checked", with a red strip under the panels and at the top of an open ticket. Nothing else on the page changes (Dan, 2026-11-08).
- **Live:** the screen never needs a refresh. Changes slide in as they happen, and an open plate is never reloaded.

## Rules

Settings → Rules (Kitchen rules until 2026-11-10) holds how your projects work, laid out like T3 Code's settings: groups of rows, a title and a line on the left, a switch or a menu on the right (Dan, 2026-11-08). The stages and actions stay the same for everyone; these rules are each setup's own.

- **Applies to:** All projects, or one project. A project's own value shows a dot and Reset, which gives it back to All projects.
- **Calls:** screenshots in visual calls (on or off); what the Pass does with a visual call that has none (flag it, or nothing); the decision form (numbered and lettered, or the agent's choice).
- **Review:** the pull-request reviewer (none, CodeRabbit, PR-Agent, Codex); council and hill climb (only when I ask, agent decides, never).
- **Tools:** the browser (agent's choice, Browserbase, local); the issue tracker (none, Linear, GitHub Issues).
- **House notes:** free text added to every brief.
- **How they reach agents:** each thread Yes Chef launches gets the project's rules under its prompt, headed "Rules (Yes Chef):". The Pass checks calls that come back: a call about something you can see, with no screenshots, shows a "No screenshots" flag, and "Ask for them" fills Reply with the ask. Threads started elsewhere follow their own instruction files.
- **Saved:** each change saves at once, one rule at a time, in the app's data folder. The file keeps its name, `kitchen-rules.json`, so saved rules load as before. A failed save says so in red until one works, and the menu goes back to the saved value. If Yes Chef cannot read the file, Settings says so and Launch waits until a save replaces it.

## Live updates (plan, not checked end to end)

- **Browser:** the Pass pushes changes to the page over Server-Sent Events. Python's standard library can serve them.
- **T3:** T3 Connect is T3's remote access through a T3 account (`t3 up --connect`). The T3 server already pushes thread events to its own web client. Not checked: whether an outside app may subscribe to that stream. Today the Pass polls `t3 thread show`.
- **GitHub and Linear:** both push through webhooks, which need an address the internet can reach. The Pass is on the tailnet only, so it polls them with cheap conditional requests and shows each age in the footer.

## On hold

- **Blocked:** waits on something outside the line.
- **Not checked:** a source failed. The ticket shows "not checked", never an older stage.
- **Canceled:** cancelled. The board file keeps the value `"close": "86"` for it, so live boards stay valid.

## Teams words (in design)

The words only; what each does lives in the Teams brief.

- **Modes:** **Open kitchen** and **French Brigade**, always in full, in the product and in marketing. Never "Open" or "Brigade" alone. Dan, 2026-11-10: the names should always call people's minds back to why the app is called Yes Chef, and to what that frame gives them.
- **Views:** **You** (every user: your own threads) and **Team** (a user with people under them: everyone below, at every level, in the mode the lead set). The Pass follows the view. The footer chip and its toggle show the person and You, or the toque and Team, in both modes; never the team's name or the mode's (Dan, 2026-11-10).
- **Roles:** Lead, Deputy, Area owner, Engineer, Viewer (Chef de cuisine, Sous chef, Chef de partie, Commis and Stagiaire in marketing).
- **Team** lists the people. **Projects** lists the work, one **Project** each. **Overlap:** two devs' tickets change the same file at the same time.

## Retired words

Each row names the word that replaced it on its day.

| Old | New |
|---|---|
| The rail | In flight |
| Off the rail | Held |
| Head of the pass | The Pass (the panel) |
| Pass (stage) | Plating, then Sent |
| Service (stage) | Sent |
| Service (session) and the expo lamp | Gone. The Pass is the expo. |
| Carried | Gone. The ticket stays in its stage. |
| 86 | Killed |
| Dish | Ticket (in the interface; code renames later) |

Retired inside the product on 2026-11-10 (Dan: developer words; kitchen words for marketing only):

| Old | New |
|---|---|
| Order, Prep, Fire, Tasting, Plating, Sent | Backlog, Planned, In progress, In review, Ready to merge, Merged |
| Held, Killed | On hold, Canceled |
| Go, Refire, Hold, Kill | Merge (Approve with no pull request), Request changes, Hold, Cancel |
| Walking in N, Walking out, On deck | ETA N min, Merging, Up next |
| Kitchen rules | Rules |
| Menu, Course, Staff | Projects, Project, Team |
| Chef de cuisine (CdC), Sous chef, Chef de partie, Commis, Stagiaire | Lead, Deputy, Area owner, Engineer, Viewer |
| Station, Collision, Heard | Area, Overlap, Seen |

Reversed the same day (v1.2): the modes were briefly Open and Brigade. They are **Open kitchen** and **French Brigade** again, in the product too. Every other row above stands.

## The Pass as expo

Dan's goal (2026-11-06): the Pass replaces the ATC thread in T3. That lifts rules the repo holds today. Each needs Dan's ruling before code:

- **Invariant 3** ("the pass acts only through `/answer`") and the AGENTS.md rule "never runs `t3 thread send`". As expo, the Pass sends briefs, change requests, and calls to agent threads.
- **Merges.** Merge means a merge to staging. Today the Pass never merges. In ReviewWheel, the SDBP and ATC merge rules name who may merge; they change too.
- **Judgment work** the ATC does today (writing briefs, triage, deciding Ready to merge, estimating ETA N min): the line agents report their own state, and the Pass routes it (Dan, 2026-11-06). Dan chose this because it also fits other users who sign up and run the Pass on their own T3 Code.

## Deferred

- Ticket flags (Triple check, Customer-facing, Needs visuals). Today's red "no visuals attached" flag stays.
- Staggered firing and a wait list.
- Project list read from T3, then a T3 login.

## What this changes in code (not made yet)

- `GATES`, `GATE_HINT`, and `component_gate`: merged to the base branch is Merged. GitHub cannot show Ready to merge, so the Pass sets it.
- The board's `plated` field today means "receipt filed". It becomes `spiked`, and `plating` means "at the lead's look". Both are data names: they keep their old words so live boards stay valid.
- `place()` stops moving a ticket with a call out of its column.
- New board fields: `walking` (minutes and set time, shown as ETA N min), `runner` (agent), and a note on each change request.
- `docs/board-format.md` changes, and so does section 8 of the brigade spec (`docs/agent-brigade-spec-v1_0.md`, moved here 2026-11-06).
