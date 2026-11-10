# The pass, design v1: brief and bake-off

**Status:** LOCKED (Dan, 2026-11-05). **Size:** one-page brief. **Owner:** the thread that seeded this repo.

## Intent

Dan is the chef at the head of the pass. Dishes flow toward him from left to right, like plates on trays in a kitchen. He sees a plate arrive, opens it, sees everything he needs, and rules with one click or one key. It must feel as if Apple designed a dashboard and workflow engine that brings the French brigade to agent orchestration.

## Dan's words (2026-11-05)

"Stuff would flow in as tiled dishes on trays, just like in a kitchen, from left to right, and then I would then spend my time leading up the head of the pass, which is the far right, seeing a plate or a dish come through, clicking it to expand it, seeing everything that I need to, being able to action it with buttons. And shortcut keys ... The light mode version will be pleasant and easy to use. The dark mode version would not feel overly techy. Basically, if Apple designed a dashboard and workflow engine like this to bring French Brigade to agent orchestration."

## End state

1. **Flow.** Dishes are tiles. They move left to right through the gates of the rail (`GATES` in `pass.py`: Order, Prep, Fire, Taste, Pass, Service, Plated). The head of the pass is the far right. It holds every dish with an open call for Dan, and it is the strongest element on the page. Carried, 86, and blocked dishes stay visible but quiet.
2. **Open a plate.** A click (or Return) opens the dish: full context, images large, every option as a button, an optional note, the owning thread, the components with their gates, and each PR description. Closing returns focus to the tile.
3. **Act.** Each option is a button. A send needs one deliberate confirm step (not `window.confirm`). Show success, failure, and "already answered" in place. The page must never reload while a plate is open.
4. **Keys.** Arrow keys move between tiles. Return or Space opens. Escape closes. Keys 1 to 9 pick an option in an open call, then a confirm key sends. `?` shows every shortcut. Show the key hints in the interface the way macOS menus do.
5. **Apple feel.** Follow Apple's Human Interface Guidelines (HIG): clarity, deference, depth; the system font stack; Apple system colors; grouped backgrounds; continuous rounded corners; quiet materials; generous, consistent spacing. Light mode is pleasant and calm. Dark mode uses Apple's elevated grays (for example `#1C1C1E`, `#2C2C2E`), never pure black with neon, and no terminal or monospace look except for ids.
6. **Phone.** Dan answers on his iPhone and on this Mac (see `README.md`, "Who can answer"). At 390 px the head of the pass comes first and every action is in thumb reach. The trays still read as a flow.
7. **Many projects.** One pass serves every project. Each tile shows its project (the short repo name from `comp_repo`).
8. **Truth.** A source that fails still renders "not checked" with its time (Invariant 2). A visual call with no image still shows the red "no visuals attached" flag.
9. **Access.** WCAG AA contrast in both modes, visible focus, real buttons, `prefers-reduced-motion` honored.

## Scope fence (do not change)

- Python 3.9 standard library only. No build step, no npm, no external fonts, scripts, or CDNs. The page loads nothing from outside the pass.
- `answer()` and its checks, the `/answer` contract (POST form fields `key`, `option`, `note`), `component_gate`, `dish_gate`, `cached`, and every `Answers` and `Gates` test stay as they are. Rendering tests may change markup assertions, but each must still prove the same behavior.
- The pass acts only through `/answer` (Invariant 3).
- Never touch the live pass: port 8494, the `com.reviewwheel.pass` login service, `~/rw-brigade/`, `install.sh`, `run-pass.sh`. Never send to `/answer` on the live pass. Never run `t3 thread send`.

## Non-goals

New data sources, editing the board, drag and drop, accounts, persistence beyond the answers log, notifications.

## Done means

- `python3 -m unittest test_pass.py` passes.
- `python3 pass.py --demo <your port>` serves the fixture board with your design.
- `tools/shoot.sh <port> <out-dir> <label> '<actions>'` produced the 12 shots (1440 and 390, light and dark: board, full board, open plate). Look at every shot yourself before you report. Browserbase runs Linux Chrome, so it shows a fallback font where Dan's Apple devices show San Francisco.
- `docs/entries/<label>.md` records: the design idea in three lines, the HIG principles you applied, the shortcut list, the exact shoot command, and known gaps.
- One or more commits on your own branch. Do not merge, push, or touch `main`.

## Bake-off (Dan, 2026-11-05)

Four entries, each built alone from the same seed commit: Claude Opus 5.5, Claude Fable 5.1, GPT-6.1 Sol, and GPT-6 Astra, all at xhigh effort. The seeding thread compares them on the same shots and the same demo, picks the best, and continues from it. Ideas from the other entries may be carried over.

| Weight | Criterion |
|---|---|
| 30 | Dan's flow: find the plate at the head of the pass, open it, rule, in seconds |
| 25 | Apple craft: hierarchy, type, spacing, materials, restraint |
| 15 | Phone at 390 px |
| 10 | Dark mode that does not feel techy |
| 10 | Keyboard flow and shortcut hints |
| 10 | Code health: small, readable, fence kept, tests honest |
