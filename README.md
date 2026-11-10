<img src="assets/icon.svg" width="64" height="64" alt="">

# Yes Chef

The French Brigade layer for agentic coding, across every project (https://yeschef.codes). The Pass is its main screen, the live board: tickets move left to right through the stages (Backlog, Planned, In progress, In review, Ready to merge, Merged), and Dan rules on everything that needs him in the Pass panel on the right. The words are defined in `docs/pass-definitions-v1_0.md`.

It runs as a login service on one Mac and is reachable only on that Mac's tailnet, at the address in `BRIGADE_ORIGIN`.

## Files

| File | Use |
|---|---|
| `pass.py` | The server. Standard library only, system Python 3.9. `--demo <port>` serves the fixture board. |
| `board.py` | The board writer. The expo's one way to change the board file. |
| `docs/board-format.md` | The board file format: every field, including per-call `visual`. |
| `test_pass.py`, `test_board.py`, `test_public.py` | Tests: `python3 -m unittest test_pass.py test_board.py test_public.py` |
| `tools/public_tree.py` | Builds the public copy and checks that no tracked file holds a private address, path or key. |
| `fixtures/` | Demo board, demo GitHub and Linear facts, demo images. All fictional. |
| `tools/shoot.sh` | Screenshots at 1440 and 390, light and dark, through Browserbase. |
| `run-pass.sh` | Launch wrapper. Reads the Linear key through the ReviewWheel service account. |
| `install.sh` | Installs the login service (macOS shows it as "The Pass") and publishes port 8494. |

## Projects

Each component names its GitHub repo with `"repo": "owner/name"`. A dish or the board may set `repo` as the default. Without one, the pass uses `BRIGADE_REPO` from `~/yeschef/pass.env`. No project is built in: a PR with no repo anywhere shows "not checked" and says why.

## The board writer

The format is in `docs/board-format.md`. The expo is the only board writer (spec D1). It changes the board only through `python3 ~/yeschef/bin/board.py` (installed next to the pass), never by hand:

| Command | Does |
|---|---|
| `check` | Validates the board against spec section 8 and the call rulings. Exit 1 on an error. |
| `show [DISH]` | Prints the board or one dish. |
| `put < dish.json` | Adds one dish, or replaces the dish with the same id in place. |
| `drop DISH` | Takes a dish off the board. |
| `drop-call DISH ANSWER_ID` | Takes an answered call off, by the answer id in "Dan ruled at the pass". |
| `plating DISH` / `plating DISH off` | Sends a dish in review to Dan's look (Ready to merge), or takes it back. |
| `plate DISH RECEIPT` | Records the receipt: the dish goes on the spike. Refused while a call waits. |
| `service open EXPO_THREAD` / `service close` | Opens or closes service. Open is refused while a service is open. Close is refused while an open dish has no carry, 86, or blocked. |
| `service expo EXPO_THREAD` | Hands the open service to a new expo (an ATC handoff). |

Each write takes a lock, validates the whole new board, keeps the old file as `board.json.bak-<time>`, and swaps the new file in atomically. An invalid board is never written. Errors block a write: a call without context, thread, or time; a recommendation that matches no option; an image the pass cannot show. Warnings do not: an unknown key, or a visual call without images. `--board PATH` or `BRIGADE_BOARD` picks another board.

## Thread state

Every thread a dish names (its components and calls) is read through `t3 thread show --json`, read only, cached 60 s like GitHub and Linear. A tile shows its most urgent thread: Asks you in T3, Failed, Interrupted, Thread not checked, Working, Idle (with how long), Settled, Archived. On hold tiles and tiles on the spike show only the alerts, up to "Thread not checked". A plate lists each thread with its state, title, stations, model, and last update. A failed read lights the T3 lamp and shows "Thread not checked", never an older state.

## Who can answer

A tap on a call option posts to `/answer`. The pass accepts it only when all of these hold (brigade spec, `docs/agent-brigade-spec-v1_0.md`, section 8):

- `netstat -anv` shows the client end of the connection owned by a live process of another user (Tailscale's network extension runs as root). Anything else counts as a process on this Mac and is refused, including a client that half-closes or closes its socket after it sends.
- The `Tailscale-User-Login` and the client tailnet IP that `tailscale serve` sets match `~/yeschef/pass.allow`. The allowed devices are Dan's phone and this Mac, where Dan works (amendment 4).
- The `Origin` is the pass page, and the call and option are on the current board.

An agent on this Mac can reach the pass through the tailnet as Dan. The device list does not stop that. The hard rule does: no agent ever POSTs to `/answer` or writes `answers.jsonl`. Each refused tap writes one line to `~/yeschef/pass.log` with the time, status, reason, login, and device.

## Install or update

1. Create `~/yeschef/pass.allow`, mode 600, with one line `login <Dan's tailnet login>` and one `device <tailnet IP>` line per device Dan answers from (`tailscale status`).
2. Create `~/yeschef/pass.env` with:
   - `LINEAR_API_KEY=<op:// reference>`, found by a live vault metadata read under the service account. Never put the reference in this repository.
   - `BRIGADE_ORIGIN=https://<mac>.<tailnet>.ts.net:8494`, the pass page's address. Required: the pass will not start without it, and `/answer` accepts only this Origin.
   - `BRIGADE_T3_WEB=<T3 Code web address>` and `BRIGADE_T3_ENV=<environment id>`, for thread links. Without them, threads show as plain text.
   - `BRIGADE_REPO=<owner/name>` if the board names no repo.
3. For screenshots only: create `~/yeschef/shoot.env`, mode 600, with one line `BROWSERBASE_API_KEY=<op:// reference>`, found the same way.
4. Run `zsh install.sh` from this folder.
5. Check `curl -s http://127.0.0.1:8494/healthz` and open the tailnet link.

**Upgrading an older install** (`~/agent-brigade` or `~/rw-brigade` is a real folder): skip steps 1 to 3. Make sure its `pass.env` has `BRIGADE_ORIGIN` (step 2), and `BRIGADE_REPO=<owner/name>` if the board names no repo, then run `zsh install.sh`. It stops the old service (`com.agentbrigade.pass` or `com.reviewwheel.pass`), moves the folder to `~/yeschef`, and leaves the old path as a link. If `~/yeschef` already exists, or both old folders are real, it changes nothing and says so.

## Stop

`launchctl bootout gui/$(id -u)/com.yeschef.pass` and `tailscale serve --https=8494 off`. Logs: `~/yeschef/pass.log`.

## License

MIT, see `LICENSE`. Contributions: see `CONTRIBUTING.md`.
