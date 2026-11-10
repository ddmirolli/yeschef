# The ⌘K action bar, v1.0

Status: PR 1 built (the bar, its motion, search, history and suggestions). PR 2 built (Send a note to any thread).
PRs 3 and 4 are below and not built.
Approved look and motion: [mocks/command-bar-v3.html](mocks/command-bar-v3.html) (mock v3, Dan, 2026-11-10: "Then yes, build").
Code: `client/bar.mjs`, tested in `client/bar.test.mjs`, wired into the page in `client/server.mjs`.
Words: the developer words of `pass-definitions-v1_0.md`. Where the mock uses an older word, the definitions win.

## Keys

| Key | Does |
| --- | --- |
| ⌘K | Opens the action bar. ⌘K again closes it. |
| ⌘T, ⌘N | Open New thread in T3 Code. Before 2026-11-10, ⌘K did this. |
| ⌘, | Opens Settings. |

Each of the three closes whichever of the others is open, so only one is up at a time. In a browser tab (the web
prototype), the browser keeps ⌘T and ⌘N for itself, so there ⌘K, then New thread, is the way in.

Inside the bar:

| Key | Does |
| --- | --- |
| Type | Searches actions, threads and settings. Every row shows its own key on the right. |
| ↓ in the empty field | Shows the suggestions at once (Dan, 1A). |
| ↑ in the empty field | Brings back the last action, like a terminal. ↑ again goes older, ↓ goes newer, ↓ past the newest clears the field. |
| ↑ ↓ in a list | Moves the highlight. Rows that say "not checked" are skipped. |
| ↵ | Runs the highlighted row. On a recalled action it runs that action again. |
| ⌫ in an empty step | Goes back from "Go to a thread" or "Send a note" to the full list. |
| ⌘↵ in a note | Sends it. Esc goes back to the list of threads. |
| Esc | Clears the field first, and the bar sinks. A second Esc closes it. |
| Tab | Moves between the field and the footer's Clear recent actions button. The list is not a tab stop. |

## Motion

All values come from mock v3.

- **Open.** The bar opens empty at the window's dead center, with no slide.
- **Rise.** The first character lifts it to the typing position: 112 px from the top in a 900 px window (12.5% of the
  height, at least 12 px and at most 112 px). The list unfolds under the field.
- **Sink.** When the field is empty again, the bar waits 250 ms, so a quick retype does not bounce it. Then it sinks
  to the center and starts a 5 s count.
- **Suggestions.** After 5 s empty, it rises with the last action and the suggestions. Suggestion rows pop in from
  +150 ms, 40 ms apart, with a small lift and scale. Typed results show at once, with no pop.
- **Curve.** Apple's default spring: duration 0.5 s, bounce 0. In CSS that is 735 ms with the `linear()` curve in
  `bar.mjs` (`SPRING`).
- **Retarget.** One transform and one grid row move the bar. Typing during a motion only retargets it. Nothing waits
  for an animation to end.
- **Reduce Motion.** No slide: the bar fades out, moves, and fades back in. Rows fade in. Typing during the fade
  never cuts it short: it fades back in wherever the bar should be by then.
- **Hover.** Hover moves the highlight without rebuilding the rows, so it never cuts the pop-in short.

## What the bar holds

Typed search finds rows in this order. Inside each group, the rows whose titles best answer the words come first. A
group whose best row answers the words better moves up: "send a note" finds Send a note to a thread… before the open
ticket's Note. On a tie, the order below holds, so the open ticket's actions lead. A step's list never reorders its
groups.

1. **This ticket: (title).** The open ticket's actions, read from its own buttons, so they always match the screen:
   - the ⌘↵ action ("Send a: Keychain", "Merge", "Settle"), tagged Suggested;
   - each option ("Pick b: …", key B);
   - Merge or Approve, Request changes, Reply, Hold, Settle, Note;
   - Open in T3 Code (O).

   A form that is busy (a send in its Undo window) offers nothing. Reply and Request changes open the note, as their
   keys do. They never send an empty note.
2. **The Pass.** The next ticket at The Pass. If T3 did not answer, this row says "Next in The Pass: not checked" and
   cannot run.
3. **Threads.** New thread in T3 Code (⌘T). Send a note to a thread… (below). Go to a thread… opens a step that lists
   every thread on the board.
4. **View.**
   - Expand the view or Collapse the view (V).
   - View: You and View: Your team (see below).
   - Density: Default, Comfortable and Compact. The current one shows **Now**.
5. **Settings.** Rules, Keyboard shortcuts (?), Settings (⌘,).
6. **Threads: on the board.** Threads match only once you type: by title, project and stage, never by preview text.

A row runs what it says from the page as it is now. If the board changed and the row's target is gone, the bar says
"No longer available" and runs nothing. A ticket action on a ticket that is not open opens that ticket first.

A row also runs only what it says. If the same action now reads differently, for example another pick on the same call
after an Undo, or Expand the view once the view is expanded, the bar says "Changed since" with what it would do now,
and runs nothing.

Focus leaves the page while the bar is open. Esc puts it back where it was. A row that runs leaves it there, so
nothing that reacts to focus (focusing your own answer's text picks it) can change the form between showing the row
and running it.

A ticket action belongs to one hand-back: its id carries the call's key, the question's request, or else the thread's
latest message. A saved action on a thread that has since handed back again says "No longer available", so ↑ ↵ never
sends an old answer to a new call.

## Send a note to a thread

PR 2. The mock's compose step, built on the ticket's own Reply.

- **Pick.** Send a note to a thread… lists every thread on the board, the ones that take a note first. A thread that
  takes none now is listed under "Takes no note now" with its reason and cannot be picked: a T3 question waits on it
  (answer it in the ticket), a send to it is waiting out its Undo, or its ticket has no Reply now. A thread whose call
  waits on you takes a note, as the ticket's own Reply does: its row says "Its call waits on you", and the line under
  the note says it goes as your Reply to its call.
- **Write.** The note opens in the bar: the thread, a note field, Back and Send (⌘↵). The line under it says "Goes to
  the agent as your message, queued like T3 Code's own queue."
- **One path.** It is the ticket's own Reply: the same form, draft, Undo toast and T3 send (`reply`, mode `queue`).
  Each keystroke goes into the ticket's note, so the note is that ticket's draft. Leave and come back, in the bar or in
  the ticket, and it is still there. An empty note says "Write the note first." and sends nothing. The note holds
  as many characters as the ticket's own note (4,000). Past that, a paste is never cut: the bar says how long the note
  is, keeps the ticket's draft at its last text that fit, and sends nothing until you shorten it.
- **Leave.** Esc or Back goes back to the list of threads. ⌘K closes the bar, and the draft stays.
- **Send.** ⌘↵ closes the bar. A note to another thread leaves you on the ticket you had open. A note to the ticket
  you have open is its own Reply, so you move on to the next ticket, as Reply does. The Undo toast names the thread. A
  thread at The Pass leaves it, as any reply does.
- **Again.** It becomes the last action, "Send a note to (title)", which opens that thread's note again. Once T3
  confirms the note, the thread is the "your last note went here" suggestion.

## Last action and history

- Whatever you run becomes the last action. Running it again moves it to the top. The bar keeps five.
- History stays on this Mac (`localStorage`: `yc.bar.recent`, and `yc.bar.noted` for the last note's thread).
- "Clear recent actions" sits in the suggestions footer, as Apple's HIG asks for a way to clear history. It clears
  both keys.

## Suggestions

Suggestions come from real data only. A source that is missing says "not checked". Nothing is guessed.

- **Last action** (↑), with its age.
- **The ticket on screen:** its recommended action, when it has one ready.
- **The next ticket at The Pass,** with its preview. If the board is not live, the row says "not checked" instead.
- **The thread your last note went to,** with when. It is recorded only when T3 confirmed the note.

## View: You and View: Your team

Scope addition, Dan, 2026-11-10: "also add switching to a quick action in the command K action bar".

- Two View rows next to Expand the view: **View: You** and **View: Your team**.
- The team row's line names the team, for example "Lantern, 14 people below you". A missing name or count reads
  "not checked".
- The current view shows **Now**, as Density does.
- Keywords: switch, team, me, mine, solo, lead, reports, scope.
- No default key. PR 4 lets you bind one in Keyboard shortcuts.
- **Mode names.** A row that names a team mode uses the full name: **Open kitchen** or **French Brigade**, never
  "Open" or "Brigade" alone (Dan, 2026-11-10). "open" and "brigade" stay in its keywords, so either word still
  finds it.
- **Gate.** Only a user with reports sees them. The views are not built yet, so the page passes `views: null` and
  `setScope: null`, and `barCore().viewRows()` returns nothing. When the views land, `views()` returns
  `{ hasReports, current: 'you' | 'team', team: { name, below } }` and `setScope(scope)` switches. The rows then
  show with no other change.

## PR split

Each PR is small, goes into main, and waits for Dan's look.

1. **The bar (this PR).** Motion, search over the existing actions, history, ↑ and ↓, suggestions, Esc. ⌘T and ⌘N
   open New thread.
2. **Send a note to any thread (built).** The row "Send a note to a thread…" picks a thread, then a note. It reuses
   the note path (`reply`, sent with mode `queue`, as T3 Code's queue does).
3. **Appearance.** Dark, Light and Match system, in the bar and in Settings. Today the theme follows the system only.
4. **Editable shortcuts.** Settings → Shortcuts: record a key, resolve a clash (Swap them or Keep), and Reset all.
   Saved in the shape of T3 Code's `keybindings.json`: a key, a command, and when it applies.
