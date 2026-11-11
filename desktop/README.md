# Yes Chef for the Mac

The Pass in its own window, signed in to the T3 Code on this Mac.

## Finding T3 Code

- Yes Chef reads the address from the file T3 Code writes when it starts, `~/.t3/userdata/server-runtime.json`. Without that file it tries `http://127.0.0.1:3773`, T3 Code's default. `YESCHEF_T3_ORIGIN` overrides both.
- When T3 Code does not answer, the window says "T3 Code is not running on this Mac" and links to t3.codes. Yes Chef looks again every three seconds, so opening T3 Code is enough.
- Yes Chef 0.1.0 was tested with T3 Code 0.1.7 (`TESTED_T3` in `t3.ts`). An older T3 Code gets a note, never a refusal.
- The saved sign-in belongs to one T3 Code address. If T3 Code moves to another port, Yes Chef asks for a new sign-in.

## Install or update

```sh
cd ~/Developer/yeschef
vp install
cd desktop
npm run app -- --install
```

`desktop/` is a package of the repo's pnpm workspace, as T3 Code's desktop app is: `vp install` at the root installs it from `pnpm-lock.yaml`.

This builds `Yes Chef.app` with electron-builder and puts it in `/Applications`. Quit Yes Chef first; the script refuses to replace a running copy. Open it from Applications, then right-click its Dock icon and choose Options → Keep in Dock.

Every build is built the way a release is (`docs/desktop-release-plan-v0_1.md`, sections 2 and 3):

- The app is one `app.asar`: `desktop/` without its tests and build scripts, and `client/` without its tests (its `pass.css` is the board's base stylesheet), and electron-updater with its dependencies. pnpm links each package to its folder in `node_modules/.pnpm`; the build follows the links and stages the same files, laid out flat as npm would (`runtimePackages` in `build/release.ts`), where electron-builder's module collector finds them.
- The fuses are flipped before signing: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect`, cookies encrypted, and the app loads only from its asar, which is checked against the hash in `Info.plist`.
- Every helper, framework and the app are signed inside out with the hardened runtime. The only entitlement is `allow-jit`, for V8 (`build/entitlements.mac.plist`).
- The build then runs the checks in `build/release.ts` and stops if one fails.

The build signs with a Developer ID Application certificate from team 8J2K26SZNK if this Mac has one, else with an Apple Development certificate from that team (`YESCHEF_SIGN_IDENTITY` narrows the choice by hash or name). The Keychain ties Yes Chef's key to that Team ID, so it keeps trusting Yes Chef after an update. A self-signed certificate does not work: it has no Team ID, so macOS asks again after every build. Without a certificate the build signs ad hoc, without the hardened runtime, and warns.

## Release files

```sh
npm run dist                 # DMG, ZIP and latest-mac.yml in out/builder, notarized and stapled
npm run dist -- --dry-run    # the same files, signed with this Mac's certificate, not notarized
npm run dist -- --dry-run --version 0.2.1-nightly.20261110.1   # any build can take a release version
npm run check -- <app or dmg> [--release]
```

- `npm run dist` needs a Developer ID Application certificate from team 8J2K26SZNK and notarization credentials in the environment: `APPLE_API_KEY` (the path to the `.p8`), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, as T3 Code's build uses, or `APPLE_KEYCHAIN_PROFILE`, a profile saved with `xcrun notarytool store-credentials`. It refuses `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD`, because they would put the password on a command line.
- It names the files `Yes-Chef-<version>-arm64.dmg` and `.zip`. electron-builder notarizes and staples the app; the script then notarizes and staples the DMG, writes the DMG's new size and sha512 into `latest-mac.yml`, drops the DMG's now stale blockmap, and runs every check with `--release`.
- A dry run is for testing the build. Gatekeeper rejects its files on any other Mac, so never publish them.
- `npm run check` runs the same checks on a built app or a downloaded DMG. With `--release` it also needs the Developer ID signature, Gatekeeper's approval and the stapled tickets.
- Every build also checks the bundle ID, name and version, the update settings in `app-update.yml` and the feed, then starts the built app hidden (`--capture`) on an empty temporary data folder. With no saved sign-in a capture stops before signing in, so this start never reaches T3 Code's approval page.
- `--version` builds another version than `package.json`'s. The version picks the channel (below).

## Updates

The way T3 Code does them (`docs/desktop-release-plan-v0_1.md`, section 6; `updates.ts`):

- The first check runs 15 seconds after the app starts, then one every 4 minutes. A check that fails in the background stays quiet and tries again. While an update is offered, downloading or waiting for its restart, the checks wait.
- Nothing downloads on its own. A card at the bottom right of the window says "Yes Chef 0.2.1 is available": Download, or Later. Yes Chef → Check for Updates… checks at once and says what it found.
- Nothing installs on quit unless you choose it. When the download is checked, the card offers Restart, or When I Quit. After When I Quit, a quit waits a moment (at most 30 seconds) while Squirrel.Mac takes the update, so it installs.
- The feed is GitHub Releases on `ddmirolli/yeschef` (`app-update.yml` in the app). The check is the only call the app makes to us, and it sends no per-install ID.
- Squirrel.Mac installs only a bundle signed by the same team with the same bundle ID, so an update can never cross from one channel to the other.
- It cannot replace a copy on a disk image or a translocated copy. On the first start outside Applications, the card offers to move the app there (`app.moveToApplicationsFolder()`). An answer either way is kept in the data folder (`move-offered`); after that, an update card still offers the move.
- No port: electron-updater 6.8.9 hands the downloaded ZIP to Squirrel.Mac through an HTTP server on `127.0.0.1`. Yes Chef replaces that one step (`fileHandoff` in `updates.ts`): it writes a feed file next to the checked ZIP and points Squirrel.Mac at it with a `file://` URL. A test fails if an electron-updater upgrade renames that step; without it, updates turn off rather than open a port.

## Stable and Nightly

| | Stable | Nightly |
| --- | --- | --- |
| Version | `0.2.0` | `0.2.1-nightly.20261110.1`: the patch after the newest Stable, the UTC day, the run |
| App | Yes Chef | Yes Chef (Nightly), with its own icon (`build/icon-nightly.png`) |
| Bundle ID | `codes.yeschef.desktop` | `codes.yeschef.desktop.nightly` |
| Data folder, Keychain item | `Yes Chef`, "Yes Chef Safe Storage" | `Yes Chef (Nightly)`, "Yes Chef (Nightly) Safe Storage" |
| GitHub release | Latest, tag `v0.2.0`, feed `latest-mac.yml` | Prerelease, tag `v0.2.1-nightly.20261110.1`, feed `nightly-mac.yml` |
| Takes updates from | Stable releases only | Nightly releases only |

The two install side by side and share nothing. T3 Code keeps one bundle ID for both and switches channels in its settings; Yes Chef has no channel switch, so two apps cost nothing. The tags must be semver (`v<version>`): electron-updater reads a Nightly's channel from its tag.

## Release

Releases build in GitHub Actions (`.github/workflows/release.yml`), as T3 Code's do. The release plan, section 7, has the details.

- **Nightly** builds by itself every day at 08:23 UTC when main has changed since the newest Nightly. To ship one sooner: github.com/ddmirolli/yeschef, Actions, Release, Run workflow, branch `main`, channel `nightly`.
- **Stable**: Run workflow, channel `stable`, a version such as `0.2.0`. It builds the commit of the newest Nightly (the build Nightly users ran) and needs that version's section in `CHANGELOG.md`, which becomes the release notes. It waits for Dan's approval in the `stable` Environment before it builds.
- **Dry run**: every pull request that touches the app, or channel `dry-run`. Unsigned, never published.
- **Signing check**: channel `signing-check`. Reads the signing secrets, asks Apple whether it accepts the notarization key, builds nothing.

A run plans (the version and the commit), builds on a macOS arm64 runner (a clean copy of the commit, `vp install --frozen-lockfile` at its root, or `npm ci` in `desktop/` for a commit from before `desktop/` joined the pnpm workspace, then `npm run dist` with `--version`: build, notarize and staple the app and the DMG, the feed rewrite, the checks and the hidden start), then publishes (a draft release with the DMG, the ZIP, its blockmap and the feed, every file checked by name and size, then published, Nightly as a prerelease and Stable as latest, and the feed read back the way the app reads it).

The signing secrets live only in the "Yes Chef Release" 1Password vault. A read-only service account reads them, and GitHub holds only its token, in the `release` Environment, which runs from main only. Agents never approve a Stable.

The version goes into the build, not into a commit, so a release pushes nothing to main. GitHub makes the tag when the release is published. After a Stable, a PR can set `package.json` to that version, so local builds carry it.

### The local fallback

```sh
cd desktop
npm run release -- nightly    # a Nightly from main as it is now
npm run release -- 0.2.0      # a Stable, from the commit of the newest Nightly
```

For a day when Actions cannot run. It runs the same plan, build and publish on Dan's Mac. Dan runs it, from a clean main that matches GitHub, in a new Terminal window opened only for it. Agents never do: `build/release.zsh` refuses to run without a terminal, and so do the build and publish steps of `build/publish.ts`.

1. Checks and the plan, with no key: main, the repo is public, gh is signed in, the Developer ID certificate is here, and the version and commit. Answer y to go on.
2. One Touch ID approval: 1Password gives the App Store Connect key from the "Yes Chef Release" vault, signed in as Dan. The `.p8` goes to a private temp folder (`mktemp -d`) that is deleted on exit, as `APPLE_API_KEY`, with `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
3. The build, as above.
4. The key is deleted. Lock 1Password then; publishing needs no key.
5. The release, as above.

On macOS 27, Terminal first needs System Settings → Privacy & Security → Files & Folders → Terminal → "Data shared by 1Password". Without it the 1Password CLI says "No accounts configured" and offers to add the account with a typed password: stop it with Ctrl+C. `YESCHEF_OP_ACCOUNT` names the account if 1Password has several.

The site's `/download` page reads the newest release from GitHub by itself.

## Signing in

- The first start opens T3 Code's approval page in the browser. Pick the level your threads run at (usually Full access) and paste a pairing code from T3 Code → Settings → Sharing & access.
- Yes Chef then stays signed in for T3 Code's 30 days. The sign-in is saved in the app's data folder, encrypted with a key that macOS keeps in the Keychain ("Yes Chef Safe Storage").
- macOS asks once whether Yes Chef may use that key: choose Always Allow. The window says so while macOS waits. Updates signed the same way do not ask again. Moving from an Apple Development build to a Developer ID build asks once more (checked 2026-11-09). Quitting while the prompt waits ends the app at once.
- Yes Chef → Sign Out of T3 Code deletes the saved sign-in and quits. To end the sign-in in T3 Code too, revoke "Yes Chef 0.1.0" (the name carries the version that signed in) under Settings → Sharing & access. Sign-ins from before 2026-11-09, when the name had no version, are listed as "Yes Chef (desktop)". A revoked or expired sign-in is deleted on the next start, and the app asks again.

## No local port

The app opens no port on this Mac (Dan, 2026-11-08). The window loads `yeschef://board/`, and the app asks the board server for each page over the IPC pipe only the app holds. Updates open none either (above). Only sign-in opens one, briefly: T3 Code's approval page returns to a free port on `127.0.0.1` that this sign-in picks and registers with T3 Code, and the port closes once the sign-in is done. Until the approval link is out, the port answers 404 to everything. `YESCHEF_CALLBACK_PORT` pins one port instead. Before 2026-11-09 the callback was always `127.0.0.1:8622`, so sign-in failed when anything else held that port.

Before 2026-11-08 the board was at `http://127.0.0.1:8632`. On the first start after the update, the app moves the board's saved settings and unsent notes from that address to the new one, without opening the port.

## Who can act

Answer, Merge, Request changes, Reply, Hold and Settle travel from the board window to the app over Electron IPC, then to the board server, which runs in an Electron utility process inside the app, over that process's own message port. Other programs on this Mac cannot reach them. T3 Code caps every action at the level approved at sign-in.

## Development

- `npm start` runs the app from the repo (closing its Terminal quits it).
- The desktop code is strict TypeScript (`tsconfig.json`, on the repo's `tsconfig.base.json`). Electron's Node runs the `.ts` files with the types stripped, as Node 24 does, so the app's own code has no build step. The one exception is the window's preload: a sandboxed preload must be one CommonJS file, so `build/preload.ts` strips the types from `preload.cts` into `preload.cjs` (not tracked). `npm start`, `npm run capture` and every build make it first.
- `npm run typecheck` checks the types with `@effect/tsgo`, and `npm test` runs the desktop tests with vitest. Both use the workspace's tools, so run `vp install` at the repo root first. The tests: `t3.ts`; `build/release.ts` (the certificate choice, the fuses, the feed rewrite, the update settings); `build/publish.ts` (the release's version, commit, notes and files); `updates.ts` with `channels.ts` (the schedule, the cards and menu, the channels and versions, the file handoff); `keybindings.ts`; and the preload. `feed.test.ts` runs electron-updater's own GitHub provider, set up as the app sets it up, against a stubbed github.com: Nightly takes only Nightly releases, even when a Stable release is newer, and Stable takes only the release GitHub marks latest. The client's tests run from the repo root (`AGENTS.md`, "Verify"); the build leaves every test file out of the app.
- `npm run capture` runs a hidden window, saves `out/board.png`, checks the action path with a ticket that cannot exist, and quits. It never reads or saves a sign-in unless `YESCHEF_USER_DATA` points it at another data folder, and it never starts one: with no saved sign-in it saves `out/no-sign-in.png` and quits. With T3 Code not running, it saves `out/no-t3.png` instead and quits. Updates are off in a capture.

### The update drill

An update end to end on this Mac, with no GitHub release:

1. Build two versions of one channel, such as `npm run dist -- --dry-run --version 0.0.8` and `--version 0.0.9`, and keep each one's files.
2. Unzip the older ZIP into a temp folder. Never use the copy in `/Applications`.
3. Serve the newer build's files on this Mac only: `python3 -m http.server 8771 --bind 127.0.0.1 --directory <newer files>`.
4. Start the older copy hidden, on its own data folder:
   `YESCHEF_USER_DATA=<temp data> YESCHEF_CAPTURE_DIR=<temp out> YESCHEF_UPDATE_FEED=http://127.0.0.1:8771/ YESCHEF_UPDATE_DRILL=restart "<copy>/Contents/MacOS/Yes Chef" --capture`
5. The first check comes after 15 seconds. The drill clicks the card's own buttons (Download, then Restart; `quit` clicks When I Quit, waits for Squirrel.Mac and quits; `quit-now` quits right after When I Quit), saves `update-available.png` and `update-ready.png`, and quits. Squirrel.Mac then puts the newer version where the copy was. It does not reopen it, because a reopened copy would start without the test's data folder.

`YESCHEF_UPDATE_FEED` takes only `http` on `127.0.0.1` or `localhost`. Squirrel.Mac and electron-updater leave their caches in `~/Library/Caches` (`codes.yeschef.desktop.ShipIt`, `yeschef-desktop-updater`, and the Nightly ones); delete them after a drill.
