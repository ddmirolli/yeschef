# Calls at the Pass, straight from T3 (v1.0)

Dan, 2026-11-06: the Pass and Yes Chef replace the ATC thread. An agent asks Dan directly, in its own T3 thread. The Pass reads the question and its screenshots from T3 and sends Dan's answer back to that thread. Nothing goes through a coordinator or a board file.

## What the agent writes

End the turn with one message that holds the decision. This is the form Dan's output standard already asks for:

```markdown
![after, dark, 390](/Users/dan/rw-artifacts/2026-11-06/topic/after-dark-390.png)
![after, light, 1440](/Users/dan/rw-artifacts/2026-11-06/topic/after-light-1440.png)

**Decision for you**
1. Ship #2151?
   - a. Yes, merge once CI is green.
   - b. Change something first (say what).

   **Recommendation: a.**
```

- **Options:** lettered `a.`, `b.`, `c.` (or `A.`, `(a)`, `a)`), at least two, starting at `a`. A line indented under an option adds to it.
- **Question:** the line just above the options. End it with `?`, or name it a decision or call.
- **Recommendation:** `Recommendation: a.` within three lines after the options, or `(recommended)` on the option. Words after the letter are fine (`Recommendation: a now. Offer b later.`): the Pass shows them on that question's card and drops the line from the message.
- **Several decisions:** number them `1.`, `2.`, each with its own lettered options.
- **Screenshots:** Markdown images. A full path (or `~/`) under the home folder or `/tmp`, or an `https` address. An image path in backticks shows too. Folders and relative paths do not.
- **Visual decisions:** a decision about anything Dan can see (a screen, a layout, a pill, copy on a page) shows a screenshot of each option, labelled with its letter. Mock up an option that is not built yet. Shots on disk that the message does not name never reach the Pass (Dan, 2026-11-08, after a visual call arrived with none). In the app, the rule "Screenshots in visual calls" sends this with each thread it launches, and the Pass flags a visual call that arrives without them (Settings → Rules).
- **Links:** Markdown links to `https` addresses and T3 thread links open from the Pass.

## What the Pass does

- The ticket moves to The Pass with a blue pill that counts its questions ("3 questions"). With an open PR it sits in Ready to merge.
- The sheet shows the screenshots, then the agent's message, with the choices pinned below it, one question at a time, the recommendation marked.
- Dan picks and sends. The thread gets one queued message: `Dan, from the Pass: my call.` then `1a. Yes, merge once CI is green. (Ship #2151?)` and his note, if any.
- A call stays open through PR-bot runs ("checks passed"). It closes when the thread receives any new message, from Dan or another thread.
- Merge and Request changes step aside while a call is open: the call carries its own choices. Reply, Hold, and Settle stay.

## Limits

- The Pass reads the last call since the thread's last received message. An older call that the agent repeated is the one it shows.
- A screenshot is served only while a message on the board names it, and only if its bytes are a PNG, JPEG, WebP, or GIF up to 20 MB, outside hidden folders (except `~/.t3`).
- T3's own question tool (`AskUserQuestion`) still works and shows first. It carries no screenshots and times out, so a decision with visuals uses this message form.

Code: `client/calls.mjs` (parser, image checks), `client/board.mjs` (sheet), `client/actions.mjs` (the `call` answer). Tests: `client/calls.test.mjs`.
