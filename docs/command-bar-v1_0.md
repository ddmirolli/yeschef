# The ⌘K action bar, v1.0

Status: PR 1 built (the bar, its motion, search, history and suggestions). PR 2 built (Send a note to any thread).
PR 3 built (Appearance), its choices redrawn as pictures after Dan's look. PR 4 built (editable shortcuts).
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
prototype), the browser keeps ⌘T and ⌘N for itself, so there ⌘K, then New thread, is the way in. These are the default
keys. Settings → Shortcuts changes them (see Shortcuts below).

Inside the bar:

| Key | Does |
| --- | --- |
| Type | Searches actions, threads and settings. Every row shows its own key on the right. |
| ↓ in the empty field | Shows the suggestions at once (Dan, 1A). |
| ↑ in the empty field | Brings back the last action, like a terminal. ↑ again goes older, ↓ goes newer, ↓ past the newest clears the field. |
| ↑ ↓ in a list | Moves the highlight. Rows that say "not checked" are skipped. |
| ↵ | Runs the highlighted row. On a recalled action it runs that action again. |
| ← → in a step of pictures | Moves along the pictures (Change appearance, Change density). ↑ ↓ work too. |
| ⌫ in an empty step | Goes back from a step ("Go to a thread", "Send a note", "Change appearance") to the full list. |
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
   - View: You and View: Team (see below).
   - Change appearance (⌥⇧⌘A) and Change density: each opens a step of pictures (below). Typing a choice's name
     finds it at once: "dark" finds Change appearance: Dark, with its picture on the right.
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

## Appearance

PR 3. Before it, the theme followed the system only. Its first look was a list of radio rows with gray blocks, and
three "Appearance:" rows in the bar. Dan, 2026-11-10: "Horrible design", use T3 Code's theme previews instead, the
ones that draw the home view in each look. This is that.

- **Three choices.** System, Light and Dark, T3 Code's names. Each one is a picture of the home view in that look: the
  rail with its stage dots, the ticket list, and the open ticket with its pull requests, screenshots, options and blue
  action. System is the same picture split down the middle, light on the left and dark on the right, as T3 Code draws
  it.
- **Settings → Layout.** Appearance and Density are rows of three pictures. Click a picture to pick it. The current one
  has the blue ring. Each picture is a radio button underneath, so Tab, the arrow keys and Space work as in any form.
  Density's pictures show the ticket list up close, in the look you have now.
- **⌘K.** One row, Change appearance (⌥⇧⌘A), opens a step with the same three pictures side by side. ← → or ↑ ↓
  moves, ↵ picks, ⌫ goes back. The current one has the ring. Change density works the same way. The pick becomes the
  last action, "Appearance: Dark" or "Density: Compact", so ↑ ↵ picks it again. Keywords: theme, mode, light, dark,
  system, match, auto, color, night, day.
- **The pictures use the page's own colors.** When the page is built, `client/theme.mjs` reads the page's tokens for
  light and dark (`rootTokens`: every `:root` block in order, `var()` resolved) and draws the pictures with them
  (`miniCss`). A new color on the page changes the pictures too. A token the pictures need and cannot find stops the
  build. The pictures are drawn in container units, so one picture serves the Settings tile and the bar's thumbnail.
- **Key.** ⌥⇧⌘A steps System, Light, Dark, in T3 Code's `appearance.cycle` order, and a toast names the new one. It
  works with the bar, Settings or New thread open. Shortcuts lists it.
- **Saved on this Mac** (`localStorage`: `yc.theme`). System saves nothing. The choice is on the page before its
  first paint, so a Light choice on a dark Mac never flashes dark.
- **How.** The page's dark and light rules are `prefers-color-scheme` blocks. `client/theme.mjs` writes each one twice
  when the page is built: once for System (a root with no `data-theme`) and once for the choice
  (`:root[data-theme=dark]` or `light`). The guard sits in `:where()`, so no rule changes weight, and with no choice the
  page looks as it did. It goes on each selector's first part as "the root, or anything in it", because the view and
  density classes sit on `<html>` itself (`.v-kitchen .rail .tile`). A block it cannot read stops the build instead of
  staying half-themed.
- **The desktop app.** The page tells the app through its bridge (`yeschef.theme`), and the app sets Electron's
  `nativeTheme`, so the title bar, menus and the update card follow too. Only the board page may set it.
- **Not changed.** The live pass's own page (`pass.py`). An agent's screenshots stay as the agent took them.

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

## View: You and View: Team

Scope addition, Dan, 2026-11-10: "also add switching to a quick action in the command K action bar".

- Two View rows next to Expand the view: **View: You** and **View: Team** ("Team", as on the footer chip; Dan,
  2026-11-10). Their icons are the app's own person and toque, the footer chip's.
- The team row's line names the team, for example "Lantern, 14 people below you". A missing name or count reads
  "not checked".
- The current view shows **Now**, as Density does.
- Keywords: switch, team, me, mine, solo, lead, reports, scope.
- No default key. Settings → Shortcuts gives each one a key (`view.you`, `view.team`).
- **Mode names.** A row that names a team mode uses the full name: **Open kitchen** or **French Brigade**, never
  "Open" or "Brigade" alone (Dan, 2026-11-10). "open" and "brigade" stay in its keywords, so either word still
  finds it.
- **Gate.** Only a user with reports sees them. The views are not built yet, so the page passes `views: null` and
  `setScope: null`, and `barCore().viewRows()` returns nothing. When the views land, `views()` returns
  `{ hasReports, current: 'you' | 'team', team: { name, below } }` and `setScope(scope)` switches. The rows then
  show with no other change.

## Shortcuts

PR 4. Settings → Shortcuts, as in mock v3's Shortcuts tab. Code: `client/keys.mjs` (the commands, key names, routing
and clashes), tested in `client/keys.test.mjs`. The Mac app's file: `desktop/keybindings.mjs`.

- **The list.** One row per command, in two groups: App and On a call. Each row shows its keys as keycaps, with
  Change on the right. The search field on top filters by name, line or key. A third group, Fixed, lists the keys that
  never change.
- **Record.** Change turns the row blue and waits for a key. Modifiers show in the row while you hold them. The next
  full key is the new key. Esc keeps the old key, and Settings stays open. Tab or a click outside the row stops
  recording.
- **Refused keys.** A key macOS keeps (⌘Q, ⇧⌘Q, ⌘W, ⌘H, ⌘M, ⌘Tab, ⇧⌘Tab, ⌥⌘D and the like) or a fixed key says why in the row, and
  recording goes on. The suggested action's key also works while you write a note, so it needs ⌘ or ⌥.
- **Clash.** A key another command has, where both can apply, turns the row orange: "Taken. H is already Hold until
  8:00 tomorrow." **Swap them** gives each command the other's key. **Keep R** leaves both as they were. The other
  command gets only keys it could record itself: no fixed key, nothing another command has there, and ⌘ or ⌥ for
  the suggested action. When it gets none, the button reads **Take it**; a command with no key offers **Take it**
  and **Cancel**. The Action bar and the suggested action always keep a key, so when a swap would leave either
  without one, the row offers only Keep: "⌘↵ is already The suggested action, which always keeps a key."
- **Reset.** A changed row shows the Rules dot and Reset, which gives that command its default back. A command that
  had one of those keys gives it up. Left with no key, it gets its own default back when that is free, so Reset on
  one side of a swap undoes it. **Reset all** gives every command its default and empties the list.
- **Labels.** Every key label shows the key now in use: the action bar's tooltips, the More menu, the ⌘K rows, toasts
  and the lines that say why a key did nothing. A command with no key shows none. Outside a Mac the labels read Ctrl,
  Alt and Shift.

| Command | Name | Default | When |
| --- | --- | --- | --- |
| `commandPalette.toggle` | Action bar | ⌘K | Always. It always keeps a key. |
| `chat.new` | New thread in T3 Code | ⌘T, ⌘N | Always |
| `thread.note` | Send a note to a thread | None | Always. Opens the bar at that step. |
| `thread.goto` | Go to a thread | None | Always. Opens the bar at that step. |
| `settings.open` | Settings | ⌘, | Always |
| `shortcuts.open` | Shortcuts | ? | Always |
| `appearance.cycle` | Appearance: next | ⌥⇧⌘A | Always |
| `view.toggle` | Expand or collapse the view | V | Always |
| `view.you` | View: You | None | Always |
| `view.team` | View: Team | None | Always. With no team, a toast says so. |
| `send.undo` | Undo the send | Z | Always |
| `ticket.suggested` | The suggested action | ⌘↵ | `!dialog`. Keeps a key, with ⌘ or ⌥. |
| `ticket.merge` | Merge | M | `ticket` |
| `ticket.approve` | Approve | A | `ticket` |
| `ticket.requestChanges` | Request changes | F | `ticket` |
| `ticket.reply` | Reply | R | `ticket` |
| `ticket.addNote` | Add a note | N | `ticket` |
| `ticket.hold` | Hold until 8:00 tomorrow | H | `ticket` |
| `ticket.settle` | Settle | E | `ticket` |
| `ticket.more` | More | . | `ticket` |
| `ticket.open` | Open in T3 Code | O | `ticket` |

Fixed: J and K (next and previous ticket, ↓ and ↑ too), Space and ⇧Space (page the message), the option letters A to I
while a question waits, ← and → (questions and screenshots), Esc, ⌘R (refresh). The launch dialog's ⌘↵ and the bar's
own Send stay ⌘↵: the suggested action's `!dialog` keeps them apart.

**The file.**

- **Where.** The Mac app keeps the list in `keybindings.json` in its data folder. A browser keeps it in
  `localStorage` (`yc.keys`). Open the file (Mac app only) opens it in your editor for `.json`.
- **Start.** As T3 Code does at start (`apps/server/src/keybindings.ts`), the Mac app writes every default into a
  new file, and an empty list too. In a file whose every entry Yes Chef uses, it adds the defaults of each command
  the file does not name, before the file's entries, and leaves out a default whose key and when an entry already
  has. A file with an entry Yes Chef cannot use is left as it is. Open the file makes the same new file when there
  is none.
- **Shape.** T3 Code's: a list of `{ "key": "mod+shift+u", "command": "view.team", "when": "ticket" }`. A key names
  `mod`, `alt`, `shift`, then the key, joined with `+`. `mod` is ⌘ on a Mac and Ctrl elsewhere. A sign carries its
  own Shift (`?`), except a shifted digit's, which reads as the digit: `!` is `shift+1`. Written with `shift`, a US
  sign is the sign Shift types: `shift+/` is `?`, and `alt+shift+/` is `alt+?`. With ⌥, a key reads as its
  US key, whatever the Mac types: ⌥/ is `alt+/`, not ÷, and ⌥E is `alt+e`. Off a Mac, AltGr types a character
  (AltGr+E is € on a German keyboard), so a key pressed with it is never a shortcut. `when` joins names
  with `&&`, each with an optional `!`: `ticket` (a ticket is open) and `dialog` (the bar, Settings, New thread or a
  screenshot is open). No chords.
- **T3 Code's rules** (`packages/shared/src/keybindings.ts`, `mergeWithDefaultKeybindings`;
  `apps/web/src/keybindings.ts`, `resolveShortcutCommand`). The rules are the defaults of every command the list
  does not name, then the list in order. A command the list names has only the list's keys: an entry replaces its
  command's defaults, it never adds to them. Of the rules for a key whose `when` holds, the last runs, whichever
  command it is. An entry with no `when` applies everywhere. An empty list is every default. There is no
  `-command`: a command keeps a key until a later rule takes it.
- **Settings writes as T3 Code's Settings does.** A recorded key, a Swap or a Reset takes the command's entries out
  and puts the new ones at the end, with the command's own `when`. Every other entry stays where it is.
  - Swap them: the other command's entries become its keys but this one, plus the keys it got.
  - Take it: the other command keeps its entry. The new one is later, so it wins the key wherever both apply, and
    the other keeps the key only where the new one's `when` does not hold (Merge on V merges with a ticket open; V
    still expands the view with none).
  - Reset: the command's defaults go at the end, so it takes its keys back.
  - Reset all: writes every default.
- **What Settings shows.** A key shows on a command when it runs that command somewhere. The Action bar and the
  suggested action always keep a key that runs them outside a dialog wherever their `when` holds. That is Yes
  Chef's own rule; T3 Code has none.
- **Edits by hand.** The app reads the file at start and each time the window comes back, so an edit applies when
  you return. An entry Yes Chef cannot use is named under the buttons and skipped: a key it cannot read or that is
  not text, a when it
  cannot read or that can never hold (`ticket && !ticket`), a plain key or ⌘↵ whose when needs `dialog` (a dialog
  keeps those), or a key Settings would refuse (macOS's, a fixed key, a suggested-action key with no ⌘ or ⌥). Such
  an entry replaces no default, as T3 Code ignores an invalid rule. When the file leaves the Action bar or the
  suggested action with no key, it gets its default back after every rule, and the note says from whom. An entry
  Yes Chef cannot use, or for a command it does not have, is kept where it is, with every field (an `args` too). A file that is not valid JSON is named and not
  read. The next change in Settings writes it again.

**Routing.**

- With nothing changed, every key works exactly as before PR 4, except a key an input method uses while it composes
  text (Japanese, Chinese): it is the method's alone, as in the action bar.
- With a change, a new key reaches the page as its command's default key, so each action keeps one code path.
- A command with no default key runs from the router, in a dialog too. Go to a thread and Send a note to a thread
  close Settings, New thread or a screenshot first, as ⌘K does.
- A default key its command gave up does nothing where that command applies, and keeps its meaning elsewhere. The
  same holds when the file gives it back under a when that does not hold there.
- A plain key typed in a field, or pressed while a dialog is open, is never a shortcut. Nor is ⌘↵ in an open
  dialog: it sends there, in the bar and in New thread.
- While a question waits, its option letters come before any shortcut.

## PR split

Each PR is small, goes into main, and waits for Dan's look.

1. **The bar (this PR).** Motion, search over the existing actions, history, ↑ and ↓, suggestions, Esc. ⌘T and ⌘N
   open New thread.
2. **Send a note to any thread (built).** The row "Send a note to a thread…" picks a thread, then a note. It reuses
   the note path (`reply`, sent with mode `queue`, as T3 Code's queue does).
3. **Appearance (built).** System, Light and Dark, as pictures of the home view in Settings and in the bar, and
   ⌥⇧⌘A. Density's choices are pictures too.
4. **Editable shortcuts (built).** Settings → Shortcuts: record a key, resolve a clash (Swap them or Keep), and Reset
   all. Saved in the shape of T3 Code's `keybindings.json`: a key, a command, and when it applies.
