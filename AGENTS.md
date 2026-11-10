# Yes Chef agent instructions

Yes Chef (https://yeschef.codes, repo `ddmirolli/yeschef`) is Dan's agent-orchestration board for every project: the French brigade layer for agentic coding. The pass (`pass.py`) is a small local server that shows the board, live stages from GitHub and Linear, and everything that needs Dan. Its words are defined in `docs/pass-definitions-v1_0.md`. It is reachable only on Dan's tailnet.

## Rules

- **Python 3.9 standard library only.** The login service runs the macOS system Python. No dependencies, no build step, no external assets.
- **The pass acts only through `/answer`.** It never merges, pushes, releases, or runs a git write. Keep every check in `answer()` and its tests intact.
- **Missing data renders "not checked".** Never show a cached or guessed value as current.
- **Never touch the live service from a task.** The live pass is port 8494 (`com.yeschef.pass`, data in `~/yeschef/`; `~/agent-brigade` and `~/rw-brigade` are links to it from before the 2026-11-06 renames; the repo itself is `~/Developer/yeschef`, with `~/Developer/agent-brigade` a link). Use `python3 pass.py --demo <port>` and the fixtures. Never POST to the live `/answer`, never write `answers.jsonl`, and never run `t3 thread send`. That hard rule, not the device list, keeps agents from answering (see README, "Who can answer"). `board.py` writes boards for the expo only: in a task, point it at a temp file with `--board`, never at `~/yeschef/board.json`.
- **Secrets** come only through the ReviewWheel 1Password service account and `op run` (see `tools/shoot.sh`). Never print a secret or write one to a file. One exception, by Dan's CLIProxy ruling (2026-10-28): the local CLIProxy hub's API key lives in the hub's own file, `/opt/homebrew/etc/cliproxyapi-keys.txt` (mode 600), not in the vault. `tools/review.sh` reads it there and passes it only to PR-Agent's environment.
- **Browser work** uses Browserbase through `tools/shoot.sh`. Never use local Chrome.
- **This repo goes public** (MIT; Dan, 2026-11-09: a fresh public repo from a clean copy of main). No tracked file may hold a tailnet address, a home path, a key, a 1Password reference or pitch material. `python3 tools/public_tree.py check` scans for them, and `test_public.py` runs it. A file that must stay private goes in `PRIVATE` in that script.

## Verify

- `python3 -m unittest test_pass.py test_board.py test_public.py`
- `python3 pass.py --demo 8600`, then `tools/shoot.sh 8600 /tmp/shots demo` and look at the shots.
- The desktop app: `node --test desktop/*.test.mjs`, and `npm run capture` in `desktop/` on a copy of the data folder (see `desktop/README.md`).
- The site's download links: `node --test site/*.test.mjs`.
- The web prototype in `client/`: `node --test client/*.test.mjs`. It runs against a real T3 sign-in, so a task starts it only when Dan asks.

## Docs

- `docs/design-brief-v1_0.md`: the design brief for the pass.
- `docs/agent-brigade-spec-v1_0.md`: the governing spec (moved here from ReviewWheel on 2026-11-06).
- `docs/pass-definitions-v1_0.md`: the locked words for the stages and panels. Where the spec uses an older word, this page wins.
- `docs/pass-calls-v1_0.md`: how an agent asks Dan a decision, with screenshots, in its own T3 message, and how the Pass shows and answers it. The Pass replaces the ATC: never route a call through a coordinator.
- `docs/ui-rubric-v1_1.md`: the grading rubric for UI, UX and design (v1.1 locked by Dan, 2026-11-07). Every council or hill-climb score uses it.
