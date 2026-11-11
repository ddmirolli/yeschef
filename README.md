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

## Language

Strict TypeScript on T3 Code's toolchain. Dan's rulings, 2026-11-10:

- **1 = C.** T3's TypeScript and tools now: its strict `tsconfig.base.json`, pnpm, Vite+, vitest, and `@effect/tsgo` for the typecheck. No Effect yet. Later pull requests move the I/O edges (the T3 and GitHub clients, the relay, the updater) to Effect with Schema. The renderers stay plain TypeScript.
- **2 = B.** The port does not wait for open pull requests. What is merged gets ported.
- **3 = B.** The Python pass is retired, not ported (#22).

Node 24 runs `.ts` files with the types stripped, and so does the Node inside Electron, so the app and the relay need no build step for their own code. Ported so far: `relay/`, `client/seal.ts`, `site/` (#24, Astro), the client's core (the board, calls, actions, the action bar and keys, the T3 and GitHub clients, the followers, the theme, You and Open kitchen), `desktop/` (the app, its updater and its release scripts), and the client's team modules (the team client, its roster, inbox and summaries, the `/team` page and its host, the roles and the stream shells), with their tests. The window's preload is the one file built at all: Electron needs it as one CommonJS file, so `desktop/build/preload.ts` strips its types. Still JavaScript, in the order they move: `client/server.mjs`, then `tools/` and `spikes/`.

## Tests

See `AGENTS.md`, "Verify".

## License

MIT, see `LICENSE`. Contributions: see `CONTRIBUTING.md`.
