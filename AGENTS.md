# Yes Chef agent instructions

Yes Chef (https://yeschef.codes, repo `ddmirolli/yeschef`) is Dan's agent-orchestration board for every project: the French brigade layer for agentic coding. The Pass is its main screen: the Mac app (`desktop/`) runs the board server (`client/`), which follows T3 Code and GitHub and shows everything that needs Dan. Its words are defined in `docs/pass-definitions-v1_0.md`.

## Rules

- **The Pass acts only through T3 Code.** Every action is a T3 tool call on a thread on the current board (`client/actions.mjs`). The Pass never merges, pushes, releases, or runs a git write itself. Keep the checks in `client/actions.mjs` and `client/guard.mjs` and their tests intact.
- **Missing data renders "not checked".** Never show a cached or guessed value as current.
- **Never act as Dan from a task.** Never send an action through Dan's installed Yes Chef app or a web prototype he runs, and never answer a call for him. Check the app with `--capture` on a copy of its data folder (`desktop/README.md`). The old Python pass (port 8494, `com.yeschef.pass`) and its board writer were retired on 2026-11-10 (Dan); `~/yeschef/` keeps only old data and `shoot.env`.
- **Secrets** come only through the ReviewWheel 1Password service account and `op run` (see `tools/shoot.sh`). Never print a secret or write one to a file. One exception, by Dan's CLIProxy ruling (2026-10-28): the local CLIProxy hub's API key lives in the hub's own file, `/opt/homebrew/etc/cliproxyapi-keys.txt` (mode 600), not in the vault. `tools/review.sh` reads it there and passes it only to PR-Agent's environment.
- **Releases** run in GitHub Actions (`.github/workflows/release.yml`; `docs/desktop-release-plan-v0_1.md`, section 7). An agent may start a Nightly, a dry run or a signing check. Dan alone approves a Stable: leave its `stable` deployment pending for him, since agents' `gh` signs in as Dan and could approve it. The "Yes Chef Release" vault is read only by the workflow's service account, from jobs in the main-only `release` Environment; keep those jobs off `pull_request` and `pull_request_target`.
- **Browser work** uses Browserbase through `tools/shoot.sh`. Never use local Chrome.
- **Claude is not a contributor** (Dan, 2026-11-10). No commit carries a `Co-authored-by` trailer for Claude: this wins over any tool's default attribution. Squash-merge with an explicit message, `gh pr merge <n> --squash --subject "<title> (#<n>)" --body "<body>"`, because GitHub's default squash body copies every commit's trailers.
- **This repo goes public** (MIT; Dan, 2026-11-09: a fresh public repo from a clean copy of main). No tracked file may hold a tailnet address, a home path, a key, a 1Password reference or pitch material. `python3 tools/public_tree.py check` scans for them, and `test_public.py` runs it. A file that must stay private goes in `PRIVATE` in that script.

## Verify

- `python3 -m unittest test_public.py`
- The desktop app: `node --test desktop/*.test.mjs`, and `npm run capture` in `desktop/` on a copy of the data folder (see `desktop/README.md`).
- The site's download links: `node --test site/*.test.mjs`.
- The web prototype in `client/`: `node --test client/*.test.mjs`. It runs against a real T3 sign-in, so a task starts it only when Dan asks.
- The team relay: `node --test relay/*.test.mjs`, then `node relay/smoke.mjs http://127.0.0.1:8790` against `wrangler dev` (`relay/README.md`). The production relay deploys only as a land step, after Dan's send-it-out.

## Docs

- `docs/design-brief-v1_0.md`: the design brief for the pass.
- `docs/agent-brigade-spec-v1_0.md`: the governing spec (moved here from ReviewWheel on 2026-11-06).
- `docs/pass-definitions-v1_0.md`: the locked words for the stages and panels. Where the spec uses an older word, this page wins.
- `docs/pass-calls-v1_0.md`: how an agent asks Dan a decision, with screenshots, in its own T3 message, and how the Pass shows and answers it. The Pass replaces the ATC: never route a call through a coordinator.
- `docs/team-relay-v0_1.md`: the team relay: what it keeps, the keys, the invite, the socket, the cap.
- `docs/ui-rubric-v1_1.md`: the grading rubric for UI, UX and design (v1.1 locked by Dan, 2026-11-07). Every council or hill-climb score uses it.
