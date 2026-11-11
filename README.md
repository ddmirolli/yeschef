<img src="assets/icon.svg" width="64" height="64" alt="">

# Yes Chef

The French Brigade layer for agentic coding, across every project (https://yeschef.codes). The Pass is its main screen, the live board: tickets move left to right through the stages (Backlog, Planned, In progress, In review, Ready to merge, Merged), and Dan rules on everything that needs him in the Pass panel on the right. The words are defined in `docs/pass-definitions-v1_0.md`.

Yes Chef is a Mac app. It finds T3 Code on the same Mac, signs in to it, and reads everything from T3 Code and GitHub. It stores no T3 data of its own.

## Files

| Folder | Use |
|---|---|
| `desktop/` | The Mac app, `Yes Chef.app` (Electron). Build, install, releases and the capture check: `desktop/README.md`. |
| `client/` | The board server and the Pass page. The app runs it in a utility process; `node client/server.mjs` runs it alone as the web prototype. |
| `relay/` | The team relay, a Cloudflare Worker: `relay/README.md`. |
| `site/` | yeschef.codes and its live demo: `site/README.md`. |
| `tools/` | Screenshots through Browserbase (`shoot.sh`), the site demo build, the public-tree check, the PR-Agent review. |
| `docs/` | The spec, the locked words, the briefs and the release plan. |
| `fixtures/` | Made-up T3 messages for the tests. |

The first pass was a Python login service on port 8494 with a board writer for the expo. Dan retired both on 2026-11-10; the Mac app replaced them.

## Tests

See `AGENTS.md`, "Verify".

## License

MIT, see `LICENSE`. Contributions: see `CONTRIBUTING.md`.
