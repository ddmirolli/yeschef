# Yes Chef for the Mac: release plan v0.1

DRAFT, 2026-11-09. Step 2 of Dan's program (2026-11-09): someone downloads Yes Chef from yeschef.codes, opens it with no Gatekeeper warning, signs in to their own T3 Code, can see which version they run, and gets updates.

## Rulings (Dan, 2026-11-09 and 2026-11-10)

- **Apple account.** Yes Chef ships under Dan's personal Apple Developer Program membership, not ReviewWheel's. The Apple Development certificate on this Mac already belongs to that team: `O=Daniel Mirolli, OU=8J2K26SZNK` (read from the certificate).
- **Macs.** Apple silicon only.
- **Updates.** Model them on how T3 Code ships its own updates (section 6).
- **Hosting.** GitHub Releases on the public source repo, `ddmirolli/yeschef`, exactly like T3 Code (Dan, 2026-11-09). This replaces the releases-only repo ruled earlier the same day.
- **Open source.** MIT. A fresh public repo, `ddmirolli/yeschef`, made from a clean copy of main (ruling 1A, 2026-11-09). This repo is renamed and stays private as the archive. A private repo cannot serve downloads to the public, so the source goes public with the first release (section 8).
- **Secrets.** Yes Chef's secrets move to its own vault in Dan's family 1Password account, out of ReviewWheel's.
- **Notarization credential.** An App Store Connect team API key, as T3 Code uses. Dan asks Apple for API access on 2026-11-09; if Apple has not approved it by 2026-11-11, the app-specific password route is used instead (Dan, 2026-11-09). Apple approved it at once, the same day, so the fallback is not needed.
- **Releases build in GitHub Actions (2026-11-10).** Dan: "B sounds more sustainable long term, especially for nightly" (section 7). The local command stays as a fallback.
- **Signing secrets: the vault is the only copy (2026-11-10, answer 1a).** Asked through the release D thread, "1. Where the signing secrets live: a. a read-only 1Password service account on the "Yes Chef Release" vault, with only its token in GitHub, or b. copies in GitHub secrets. 2. Whether each Stable waits for your approval: a. yes, Nightly runs by itself, or b. no." Dan answered: "A / A". So one read-only service account reads the "Yes Chef Release" vault and nothing else, and GitHub holds only its token, `OP_SERVICE_ACCOUNT_TOKEN`, in the main-only `release` Environment. The runner reads the `.p12` and the `.p8` with the 1Password CLI (`op read` to files in `$RUNNER_TEMP`), not with 1Password's GitHub action, which drops line breaks from files (1password/load-secrets-action issue #123). It reads the vault only when a build runs. No setup script on Dan's Mac, and agents never run `op` on his account. This supersedes his 2026-11-09 rule that "Yes Chef Release" has no service account and needs Touch ID for each release; that rule now covers only the local fallback.
- **Each Stable waits for Dan's approval (2026-11-10, answer 2a).** A Stable builds only after Dan approves it in the `stable` Environment, from the GitHub app or github.com. Nightly runs by itself (section 7).

## Where it stands

Checked on this Mac on 2026-11-09, against the copy in `/Applications` and `desktop/` on main (e78ea4e).

| | Today | Shipping needs |
| --- | --- | --- |
| Gatekeeper | `spctl -a -t exec` says "rejected" | Accepted on any Mac |
| Signature | Apple Development (team 8J2K26SZNK), `codesign --deep` | Developer ID Application, signed inside out |
| Hardened runtime | Off (`flags=0x0`) | On, which notarization requires |
| Notarization | None | Notarized and stapled |
| Package | `.app` built into `/Applications` | DMG to install, ZIP for updates |
| Size | 253 MB app; 114.5 MB as a DMG or a ZIP | Same |
| Architecture | arm64, macOS 13 or later | Same (ruled) |
| Version | 0.1.0, typed twice (`package.json` and `main.ts`) | One source, shown in the app |
| Updates | None | T3 Code's model (section 6) |
| Hosting | None. The site's button goes to `#sign-in` | GitHub Releases on the public `ddmirolli/yeschef` (ruled) |
| Electron fuses | Defaults (RunAsNode on) | RunAsNode off and the others below |

## 1. Download

- yeschef.codes gets a **Download for Mac** button with the version, size and "macOS 13 or later, Apple silicon" under it. It also says that Yes Chef needs T3 Code on the same Mac.
- The button works the way t3.codes's does (PR D, 2026-11-10; read from t3.codes's own scripts that day). The visitor's browser asks GitHub's public API for the newest release (`/repos/ddmirolli/yeschef/releases/latest`) and links its `-arm64.dmg`; the line under the button shows that release's version and size. `yeschef.codes/download` is a page with Stable and Nightly, like `t3.codes/download`. Until GitHub answers, every button goes to `/download`. A release changes nothing on the site, so the site needs no deploy to ship a version. This replaces the planned `_redirects` line, which a release would have had to commit and deploy (section 5 says a release commits nothing).
- The DMG (114.5 MB) is too big for the site's Worker, which takes files up to 25 MiB. The files live in GitHub Releases on the public source repo, `ddmirolli/yeschef`, where T3 Code publishes its own (on `pingdotgg/t3code`). The updater works exactly like T3's, with no Cloudflare change. R2 was the other option and was not chosen.

## 2. Signing and notarization

- **Developer ID.** Sign with a Developer ID Application certificate from Dan's personal team. Only the Account Holder can make one (Dan's actions). Apple issues it from the G2 authority, and "certificates issued from G2 are valid for one year and must be renewed annually" (Apple, "Replacing Developer ID certificates issued from the previous Sub-CA"). Apps signed while it was valid keep running after it expires; a revoked one stops them launching. So a new certificate each year, before the old one expires, and never a revocation. Dan's first one: `Developer ID Application: Daniel Mirolli (8J2K26SZNK)`, issued by the G2 authority, valid 2026-11-10 to 2027-12-10 UTC (checked with `openssl x509`). Renew it before 2027-12-10.
- **Inside out.** electron-builder signs every helper, framework and the app in order with the hardened runtime, as it does for T3 Code. Start from its default Electron entitlements, remove what the app does not need, and keep `com.apple.security.cs.allow-jit` for V8. Test after each change.
- **Fuses first.** The build flips the fuses before it signs, because flipping them changes the binary.
- **Notarize the app.** electron-builder sends the app to Apple with an App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, as T3 Code's build uses), read from the "Yes Chef Release" vault (section 7), then staples it. This step covers the `.app` only.
- **Notarize the DMG.** T3 Code's build has no DMG step (checked in `scripts/build-desktop-artifact.ts`). Ours adds one: `xcrun notarytool submit --wait` and `xcrun stapler staple` on the DMG, so a downloaded DMG passes Gatekeeper before it is opened. Stapling changes the DMG, so the step then rewrites the DMG's `size` and `sha512` in `latest-mac.yml`.
- **Keychain.** Checked 2026-11-09 on a copy of Dan's data, and the old assumption (same team, so no prompt) was wrong. The first Developer ID build asked once for "Yes Chef Safe Storage". Assumed reason: the item's access list names the app by its signature, and Apple Development and Developer ID signatures differ even within one team. Dan chose Always Allow. A rebuilt Developer ID app (a new code hash) then read the saved sign-in in 6 seconds with no prompt, showed 72 tickets and answered the action probe with 409. Only Dan meets this prompt, once: new users never had an Apple Development copy.
- **Checks in the release script:** `codesign --verify --deep --strict` and `spctl -a -vvv -t exec` on the app, `spctl -a -vvv -t open --context context:primary-signature` on the DMG (`-t install` is for installer packages), `stapler validate` on both, and a fuse read.
- **PR B: built and notarized.** `desktop/build/package.ts` builds with electron-builder 26.16.1, as T3 Code does. Checked on this Mac with the Apple Development certificate (2026-11-09): all 14 signed files in the app carry the hardened runtime and `allow-jit` at most, team 8J2K26SZNK, fuses as in section 3; a dry run writes `Yes-Chef-0.1.0-arm64.dmg` (120.3 MB, signed), the `.zip` (116.3 MB) and `latest-mac.yml`; the zipped app carries `app-update.yml` for `ddmirolli/yeschef`. The checks live in `desktop/build/release.ts` and run after every build; `npm run check` runs them on a downloaded file. With `--release` they reject the dry run (Apple Development, no ticket), as they should. First real release build, 2026-11-09, from Dan's own Terminal window with the team key: Apple notarized the app in about 30 minutes, then the DMG. The release checks passed on the app from the ZIP and on the DMG: `spctl` accepts both as "Notarized Developer ID", both carry a stapled ticket, and `latest-mac.yml` lists the stapled DMG's size (120,342,209 bytes) and sha512, which match the file. A copy of the DMG with a browser's quarantine flag, and the app copied out of it, pass Gatekeeper too, and `syspolicy_check distribution` reports "App passed all pre-distribution checks and is ready for distribution". The temporary `.p8` was gone afterwards.
- **Notarization credentials.** Only a team API key works: Apple says individual keys "aren't able to use ... `notaryTool`". A team key with Developer access is enough: it notarized the first release build (2026-11-09). The build also takes a notarytool Keychain profile (`APPLE_KEYCHAIN_PROFILE`), the route for an app-specific password. It refuses `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` in the environment, because they would reach notarytool on a command line.

## 3. Hardening

- **Fuses:**
  - RunAsNode off. Anyone could otherwise run the signed binary as plain Node with our signature.
  - NODE_OPTIONS and `--inspect` flags off.
  - Cookie encryption on.
  - Extra file:// privileges off.
  - Embedded asar integrity and "only load the app from asar" on, with asar packing on.
  - electron-builder's `electronFuses` flips them right before it signs (read in its 26.16.1 source). PR B: done. Read back from the built app, and checked by running it: with `ELECTRON_RUN_AS_NODE=1`, `NODE_OPTIONS` and `--inspect`, the app started as itself and opened no debugger.
  - Electron 45's wire has nine fuses; `@electron/fuses` 1.8.0 names eight. The ninth keeps Electron's default.
- **The board server moves to `utilityProcess.fork`.** Today `main.ts` starts `client/server.mjs` with `ELECTRON_RUN_AS_NODE=1`, which the RunAsNode fuse ends. The server has ten `process.send` and `process.on('message')` call sites. A small adapter uses `process.parentPort` when present, so `node client/server.mjs` keeps working for the web prototype. PR A: done with a pipe in `client/server.mjs` (`appPipe`). ESM runs in the utility process (checked: the capture start runs the board there). PR B: the board server, `pass.py` and the desktop files are inside `app.asar`, in the repo's layout. Checked: a hidden capture start of the hardened, fused build on a copy of the data folder signed in with the saved sign-in (no Keychain prompt), showed 63 tickets and answered the action probe with 409.
- **What ships.** `client/*.test.mjs` currently ships in the app. The build leaves tests out. PR A: done (checked: no `*.test.mjs` in the built app).
- **No personal defaults in shipped code.** `client/server.mjs` falls back to Dan's T3 Connect address, Dan's tailnet name and `~/yeschef/pass.allow`. The desktop app passes its own values, so these never run there, but they ship in the bundle and in the repo we plan to open. Web mode should take them from the command line or the environment and refuse to start without them. PR A: done. Web mode exits with code 2 and names what is missing; `client/server.test.mjs` checks that and that the source names no address.

## 4. Sign-in

- **Find T3 Code.** Today the app assumes `http://127.0.0.1:3773`. T3 Code writes its address to `~/.t3/userdata/server-runtime.json` (`origin`, `port`, `serverVersion`), so the app reads it there, falls back to 3773, and keeps `YESCHEF_T3_ORIGIN` as the override. Assumed: every T3 Code install writes that file in the same place. PR A: done in `desktop/t3.ts` (checked on this Mac: it found T3 Code 0.1.7 through the file).
- **No T3 Code.** If T3 Code is not running, the window says so and links to t3.codes. Today it fails at sign-in. PR A: done. The app looks again every three seconds (checked: the capture start saves the page and quits).
- **Callback port.** Sign-in listens on fixed port 8622. `client/t3mcp.ts` registers a new OAuth client on every sign-in, so it can take any free port and register that one. This removes a clash with whatever else uses 8622. PR A: done. Checked against a stand-in T3 in `client/t3mcp.test.ts`, and in a real start the callback listened on a free port. A full approval on a free port is not checked.
- **The approval stays T3's.** The user still picks the access level and pastes a pairing code in T3 Code's own page. Yes Chef never makes the pairing code for them. That page is T3 Code's check that a person agreed.

## 5. Versions

- One source: `desktop/package.json`. `main.ts` reads `app.getVersion()` instead of typing `0.1.0`.
- Shown in the About panel, at the bottom of the Yes Chef menu, and in the client name T3 Code lists under Sharing & access ("Yes Chef 0.2.0").
- Nightly versions follow T3 Code's form, `0.2.0-nightly.20261110.1`, so the version alone says which channel a build is on.
- Each release gets a git tag `v0.2.0`, as T3 Code's. It was `desktop-v0.2.0` here until PR C: electron-updater reads a Nightly's channel from its tag as semver, so `desktop-v…` would hide every Nightly from the updater.
- Each Stable release gets a short entry in `desktop/CHANGELOG.md`, which becomes the release notes. Nightly notes name the commit.
- The app reads `serverVersion` from T3 Code and says so if it is older than the version we tested against. The release notes list the tested T3 Code version.
- PR A: one source, About, menu, client name and the older-T3 note are done. The tested version is 0.1.7 (`TESTED_T3` in `desktop/t3.ts`).
- PR C: a release passes its version to the build (`package.ts --version`), so `package.json` keeps the last Stable, as T3 Code's does, and a release commits nothing. Nightly is the patch after the newest Stable on GitHub or in `package.json`, with the UTC day and the day's next run number.

## 6. Updates, the way T3 Code does them

Read in T3 Code's source (origin/main 3fa57b92a2, 2026-11-08): `apps/desktop/src/updates/DesktopUpdates.ts`, `scripts/build-desktop-artifact.ts` and `.github/workflows/release.yml`.

| | T3 Code | Yes Chef |
| --- | --- | --- |
| Build and update libraries | electron-builder 26.16.1, electron-updater 6.8 | The same. electron-builder replaces `@electron/packager` |
| Files | DMG and ZIP, `T3-Code-${version}-${arch}`, plus `latest-mac.yml` | DMG and ZIP, `Yes-Chef-${version}-arm64`, plus `latest-mac.yml` |
| Feed | GitHub Releases (`provider: github`) on the source repo | GitHub Releases on the source repo, `ddmirolli/yeschef` |
| When it checks | 15 seconds after start, then every 4 minutes | The same |
| Download | Never on its own (`autoDownload` off). The user starts it | The same |
| Install | Never on quit (`autoInstallOnAppQuit` off). The user clicks restart | The same |
| Channels | Stable and Nightly. Nightly is a prerelease with its own app name and icon | Stable and Nightly, "Yes Chef (Nightly)" |
| What reaches Stable | Only a build Nightly users already ran | The same |
| Release drafts | Kept as a draft until every file is attached | The same |
| Where releases build | GitHub Actions | GitHub Actions, macOS arm64 only (section 7; Dan, 2026-11-10) |

- **Where the app runs from.** The updater cannot replace an app that runs from the DMG or from a translocated copy. On first start outside `/Applications`, the app offers to move itself there (`app.moveToApplicationsFolder()`).
- **Never silent.** No forced restart and no telemetry. The update check is the only call the app makes to us.

Built in PR C (`desktop/updates.ts`, `desktop/channels.ts`; checked on this Mac on 2026-11-10 with dry-run builds and a feed on `127.0.0.1`):

- **Two apps, not one.** Nightly is "Yes Chef (Nightly)", bundle ID `codes.yeschef.desktop.nightly`, with its own icon, data folder, Keychain item and update cache. T3 Code keeps one bundle ID and switches channels in its settings; Yes Chef has no channel switch. Squirrel.Mac installs only a bundle with the running app's bundle ID and team, so an update cannot cross channels.
- **No port.** electron-updater 6.8.9 hands the downloaded ZIP to Squirrel.Mac through a short-lived HTTP server on `127.0.0.1`, which Dan's no-port rule (2026-11-08) does not allow. Yes Chef replaces that step with a feed file and a `file://` URL. A test fails if an upgrade renames the step, and without it updates turn off.
- **The prompt.** A card at the bottom right of the window, over the board or a waiting page, and the same actions in the Yes Chef menu.

## 7. Release, in GitHub Actions

**Ruling (Dan, 2026-11-10).** Asked in the release D thread to choose between "a. You run them at the Mac next time you're there" and "b. I build a GitHub Actions release, the way T3 Code does, so you can start one from your phone", Dan answered: "B sounds more sustainable long term, especially for nightly". This supersedes his 2026-11-09 rule that the release key stays behind Touch ID on his Mac. Releases build in GitHub Actions, as T3 Code's do. The local command stays as a fallback (below).

`.github/workflows/release.yml` (PR E) runs the three parts of `build/publish.ts` as three jobs, modelled on T3 Code's `release.yml` and `release-desktop.yml` (read at 240446e2d9):

| Job | Runner | Does | Can reach |
| --- | --- | --- | --- |
| Plan | Linux | Picks the version and the commit, or decides the scheduled Nightly has nothing to do | No secrets; read-only token |
| Approve | Linux | A Stable only: waits for Dan's approval | The `stable` Environment, which holds no secret; no token permissions |
| Build | macOS 26, arm64 | Loads the signing material in one step (`build/ci-signing.sh load`), then steps 1 to 4; deletes the keychain and key even after a failure | The service account's token, through the `release` Environment; read-only token |
| Publish | Linux | Step 5, then reads the feed back the way the app does | `contents: write`; no signing secrets |
| Signing check | macOS 26, arm64 | By hand only: loads the signing material as Build does, asks Apple whether it accepts the key, deletes it all. Builds nothing | The service account's token, through the `release` Environment |

The steps, the same on a runner and on a Mac:

1. Pick the version and the commit. Nightly's version is computed (section 5) and it builds main; Stable's version is Dan's and it builds the commit of the newest published Nightly. The version goes into the build, and GitHub makes the tag `v<version>` at that commit when the release is published.
2. electron-builder builds arm64, flips fuses, signs with Developer ID, notarizes and staples the app, and writes the DMG, the ZIP and `latest-mac.yml`.
3. Notarize and staple the DMG, then rewrite its `size` and `sha512` in `latest-mac.yml` (section 2).
4. Run the checks from section 2 and a hidden `--capture` start on a temporary data folder.
5. Create the release as a draft, attach the DMG, the ZIP and `latest-mac.yml`, then publish it, so a feed never points at a missing file.

**How a release starts.**

- **Nightly, on a schedule:** every day at 08:23 UTC. Plan builds it only when main has commits since the newest published Nightly (`publish.ts plan nightly --if-changed`), so an unchanged main never starts the build job or reads a secret. Once a day, not T3 Code's every 30 minutes with a six-hour gap: each Nightly is a notarization round trip and an update prompt for every Nightly user, and a dispatch ships one sooner.
- **By hand:** github.com, the repo, Actions, Release, Run workflow, branch `main`. Channel `nightly` (no version), `stable` with a version such as `0.2.0` (its `desktop/CHANGELOG.md` section becomes the notes; a published Nightly must exist), `dry-run`, or `signing-check`.
- **Stable waits for Dan.** After Plan, the run stops at Approve until Dan approves it (Review deployments, `stable`, Approve and deploy) or rejects it. GitHub notifies required reviewers. Rejecting it ends the run with nothing built.
- **Signing check:** reads the vault as a release does, imports the certificate, asks Apple whether it accepts the notarization key (`notarytool history`, which notarizes nothing), prints only byte counts and counts, and deletes it all. Use it after any change to the vault or the token.
- **Dry run:** every pull request that touches `desktop/`, `client/` or the workflow, and a dispatch with channel `dry-run`. It builds unsigned (ad hoc, as T3 Code builds when `CSC_LINK` is missing), runs every check a build without a certificate can pass and prints the rest as `skip`, rehearses the keychain steps with a throwaway self-signed identity (`ci-signing.sh rehearse`), and publishes nothing.
- Runs wait in one queue (`concurrency.queue: max`), so a Stable started behind a Nightly is never dropped. A Stable waiting for approval holds the queue until Dan approves or rejects it.

**Where the signing secrets live** (Dan, 2026-11-10, answer 1a). Only in the "Yes Chef Release" vault in Dan's family 1Password account: the item `Developer ID Application` (the `.p12` and its password) and the item `Yes Chef notarization` (the `.p8`, `key id`, `issuer id`). A service account with read access to that vault alone reads them. GitHub holds one secret, its token, `OP_SERVICE_ACCOUNT_TOKEN`, in the `release` Environment and nowhere else.

**What keeps the signing secrets in the release.**

- The token lives only in the `release` Environment. Its one deployment rule is the branch `main`, and admins cannot bypass it (created 2026-11-10, read back with `gh api`). GitHub matches the rule against the run's `GITHUB_REF`, so a run from any other branch, or a pull request (`refs/pull/<n>/merge`), cannot read it.
- Build and Publish name the Environment only for a real release. A pull request or a dry run names none. The workflow has no `pull_request_target` trigger. `release.test.ts` reads the workflow and fails if a second secret appears, or if a job other than the two load steps gets the token.
- One step reads the vault (`ci-signing.sh load`), and only when a build runs: the schedule decides in Plan, with no secret, so an unchanged main reads nothing. A build makes seven CLI calls (two items' field labels and file names, two files, three fields) and one for the usage it prints. 1Password's limits for Families are 1,000 reads an hour per token and 1,000 requests a day for the whole account ("Service account rate limits", read 2026-11-10), and some CLI calls make more than one request.
- The CLI is version 2.41.1, pinned by the zip's SHA-256 and the binary's signing team (AgileBits, 2BUA8C4S2C). Each value is masked in the log as soon as it is read, checked by its form and never printed; items are named in errors by field label and file name only. The build step after it gets only the key's path and the two IDs.
- The build runs `npm ci`, so it is the job with code from npm, and its token cannot write to the repo. The job that can write never sees a signing secret.
- Actions are pinned by commit SHA. The workflow token is `contents: read`, with `contents: write` on Publish only.
- `ci-signing.sh cleanup` deletes the temporary keychain and the key folder with `if: always()`, before the files are uploaded. GitHub then discards the runner.

**The Stable gate** (Dan, 2026-11-10, answer 2a). The `stable` Environment holds no secret. Its rules: Dan (`ddmirolli`) as the one required reviewer, his own runs allowed (so he can approve a Stable he started), the branch `main`, no admin bypass (created and read back with `gh api`, 2026-11-10). One Environment holds the token, so Dan pastes it once; the gate is a separate job between Plan and Build. It fails closed: a signed build whose plan is not a Nightly waits at Approve, and Build and Publish run for it only when Approve succeeded. A Stable's channel is `latest` (`desktop/channels.ts`), so the gate compares against `nightly` only. Publish releases the plan the gate saw: the Plan job's output, not the plan file in the build's artifact, since the build job runs npm's install scripts. It takes only the build's time and files from that file, and stops on any other change or on files that are not the version's own (`trustedPlan` in `publish.ts`). `release.test.ts` evaluates the jobs' `if:` conditions as GitHub does, with the channels `pickRelease` plans, for each path below; with the gate keyed to a channel no plan emits, it fails. Paths checked:

- A dispatched Stable: Plan, then Approve, then Build and Publish only after an approval. A rejection skips both.
- The schedule and a dispatched Nightly: Plan picks a Nightly version from main, never a Stable.
- A dry run with a Stable version: unsigned, no Environment, never published.
- From any branch but main: Approve and the token's Environment both refuse it.
- The local fallback is Dan at his Mac with Touch ID, which is his approval in person.

A limit, not a barrier: agents' `gh` signs in as Dan, so it could approve a deployment as him. The rule is that agents never approve a deployment (AGENTS.md); only Dan does.

### The local fallback

`npm run release -- 0.2.0` (or `-- nightly`) still runs the same three parts on Dan's Mac, from a clean main, and is kept for the day Actions cannot run. It does not get in the way: the workflow calls `publish.ts` with `--ci`, which runs only in GitHub Actions, and the local path is unchanged. It refuses `dry-run`, which needs no key (`npm run dist -- --dry-run`).

Locally the Developer ID certificate is in the login Keychain on Dan's Mac. The App Store Connect key comes from 1Password through `op`, from the "Yes Chef Release" vault in Dan's family account, signed in as Dan, so `op` asks for his Touch ID. The release's service account is for Actions only: its token lives in 1Password and in the `release` Environment, never on a Mac. Agents' deploy secrets live in a separate Yes Chef vault.

Dan's rule (2026-11-09), now for the local fallback only (the vault's service account, 2026-11-10, replaced the rest): a Touch ID approval serves only the Yes Chef release, and nothing in ReviewWheel can use it. What 1Password allows (1Password CLI, "App integration security"): one approval covers one whole account, not one vault; on macOS it is bound to one terminal window (its `tty` and start time, with that window's sub-shells); it lasts 10 minutes after the last use, 12 hours at most; and locking the 1Password app revokes every approval. So:

- Dan runs the release in a new Terminal window opened only for it, and locks 1Password when it ends. On macOS 27 that Terminal first needs System Settings, Privacy & Security, Files & Folders, Terminal, "Data shared by 1Password". Without it the CLI says "No accounts configured" and offers to add the account with a typed password; stop it with Ctrl+C instead (1Password CLI, "App integration", troubleshooting; seen 2026-11-09).
- Agents never run the release's `op` calls. Their shells have no terminal, 1Password does not document how it scopes those, and T3 Code runs ReviewWheel and Yes Chef threads side by side.
- ReviewWheel's service account belongs to the ReviewWheel 1Password account and reads only its own vault (checked with `op whoami` and `op vault list`, 2026-11-09). It cannot reach Dan's personal account.
- The Claude guard blocks every `op` call that does not use ReviewWheel's service account, in every project, so a Claude agent cannot even raise a Touch ID prompt for the personal account (seen 2026-11-09). Assumed, not checked: other agents have no such guard. The prompt names the process that asks, so Dan approves only a prompt from the release window.

## Order of work

| PR | Contents | Waits on |
| --- | --- | --- |
| A | Versions, T3 Code discovery, free callback port, server in `utilityProcess`, no personal defaults, tests left out of the build | Nothing |
| B | electron-builder, fuses, hardened runtime, Developer ID signing, notarization, DMG and ZIP | Merged (#64, 2026-11-10) |
| C | electron-updater on T3 Code's schedule, Stable and Nightly, `npm run release` against `ddmirolli/yeschef` | Merged (#66 and #68, 2026-11-10) |
| Open source | LICENSE, CONTRIBUTING, no personal defaults, `tools/public_tree.py` | Nothing |
| Public day | Section 8: the public repo, then the first Stable release | C, Dan's go |
| D | Download buttons, the `/download` page, version line on the site, all read from GitHub's API | C. Safe before public day: until a release exists, `/download` says "No release yet." |
| E | Releases in GitHub Actions: Nightly on a schedule, Nightly and Stable by hand, Stable after Dan's approval, an unsigned dry run on pull requests (section 7) | Public day. Signed releases wait on Dan's actions 9 and 10 |

## 8. Open-source day

The public repo starts from one clean commit. Its history and PRs start that day, as T3 Code's public life did. This repo, with every commit and PR before that day, stays private.

1. From a clean main: `python3 tools/public_tree.py build /tmp/yeschef-public`. It leaves out the files in `PRIVATE` and refuses when any file holds a tailnet address, a home path, a key, a 1Password reference or pitch material. `test_public.py` runs the same scan on every change, so main stays clean until that day.
2. Rename this repo to `ddmirolli/yeschef-archive`. It stays private.
3. Create the public `ddmirolli/yeschef`. Push the copy as one commit, authored with the GitHub noreply address. Turn on Discussions with an Ideas category, as T3 Code has.
4. GitHub stops redirecting a renamed repo once its old name is reused (GitHub docs, "Renaming a repository"). Every local clone whose `origin` is `ddmirolli/yeschef` then reaches the public repo, whose history is new. T3 or Dan clones the public repo into the canonical checkout and the T3 project. Agents never clone. Open branches move over as patches.
5. Ship the first Stable release from the public repo (section 7), after a Nightly (ruling 2026-11-10). The site's buttons pick it up by themselves (section 1).

## Dan's actions

Apple's pages: "Create Developer ID certificates", "Create a certificate signing request" and "App Store Connect API" (developer.apple.com/help). Apple allows the developer account or Xcode; Xcode's steps are not on its page, so this uses the account.

1. **Membership.** At developer.apple.com/account:
   - If a banner says "The program license agreement has been updated", click Review agreement and accept it first. Until then Apple blocks Certificates, Identifiers & Profiles, App Store Connect and the App Store Connect API (the banner's own words, seen 2026-11-09).
   - Membership details: Team ID 8J2K26SZNK, Apple Developer Program, enrolled as Individual. "When you enroll ... you automatically become the Account Holder" (Apple's account help, Roles). Both a Developer ID certificate and API access need the Account Holder.
   - A banner that the default payment method cannot renew the membership does not block these steps. Add a card before the renewal date. Assumed, not checked: a lapsed membership cannot notarize new releases.
2. **Ask for API access first,** because Apple reviews it "case-by-case": appstoreconnect.apple.com, Users and Access, Integrations, Request Access, agree, Submit. Skip this if Team Keys already shows.
3. **Certificate request, on this Mac.** Keychain Access, menu Keychain Access, Certificate Assistant, Request a Certificate From a Certificate Authority. User Email Address: your Apple ID email. Common Name: `Daniel Mirolli Developer ID`. CA Email Address: empty. Saved to disk, Continue.
4. **The certificate.** developer.apple.com/account, Certificates, +, Developer ID, Continue, Developer ID Application. If asked for an intermediary, pick G2 Sub-CA. Choose File, the `.certSigningRequest`, Continue, Download.
5. **Install it.** Double-click the `.cer`. Then `security find-identity -v -p codesigning` lists `Developer ID Application: Daniel Mirolli (8J2K26SZNK)`.
6. **Back it up.** Keychain Access, My Certificates, the new certificate, Export as `.p12` with a strong password. Save the file and the password in the "Yes Chef Release" vault in your family 1Password (make it with + next to Vaults, in the same account as the Yes Chef vault, shared with no one and given to no service account but the release's, step 9), as an item named `Developer ID Application`, then delete the file.
7. **The notarization key, once access is approved.** Users and Access, Integrations, Team Keys, Generate API Key. Name `Yes Chef notarization`, Access Developer, Generate. Name and access cannot change later. Download the `.p8`: "The private key is available for download a single time", and Apple keeps no copy. Copy the Key ID (hover next to it under Active, Copy Key ID) and the Issuer ID ("near the top of the page", Copy). Apple: "Creating API Keys for App Store Connect API" and "Generating Tokens for API Requests".
8. **Store the key.** One item in "Yes Chef Release", named `Yes Chef notarization`: a `key id` field, an `issuer id` field, and the `.p8` attached as a file. Then delete the `.p8` from Downloads.

9. **The release's service account** (Dan, 2026-11-10, answer 1a). On 1Password.com in a browser on a Mac: Developer, Directory, Other, Create a Service Account. Name `Yes Chef release CI`. Vault access: "Yes Chef Release" only, Read Items only; no vault creation, no Environments; a service account's vaults cannot change later. Create it, then Save in 1Password. A phone does not work (Dan, 2026-11-10): the iPhone app has no Developer pages, and 1Password.com in Safari asks for the Secret Key. The desktop app does not work either: its Settings, Developer only turns on the CLI and SDK integrations; 1Password's docs name only 1Password.com and the CLI for creating one (read 2026-11-10).
10. **Its token in GitHub.** github.com/ddmirolli/yeschef, Settings, Environments, `release`, Environment secrets, Add environment secret. Name `OP_SERVICE_ACCOUNT_TOKEN`, value the token from step 9. Only in `release`: not in `stable`, and not as a repository secret.

Steps 3 to 6 do not wait on Apple's review, so they can be done the same day as step 2. Only steps 7 and 8 wait. Steps 9 and 10 need Dan at a Mac browser; no agent runs them. After step 10, a `signing-check` run proves both (section 7).

Not needed, since Apple approved API access at once on 2026-11-09. Kept for reference, the fallback if Apple had not approved it by 2026-11-11 (Dan's ruling): an app-specific password (account.apple.com, Sign-In and Security, App-Specific Passwords, `Yes Chef notarization`), saved once on this Mac with `xcrun notarytool store-credentials yeschef-notary --apple-id <email> --team-id 8J2K26SZNK`, which asks for it at a hidden prompt. The release then uses `APPLE_KEYCHAIN_PROFILE=yeschef-notary`.

## Decisions

None open. The last two, where the signing secrets live and whether each Stable waits for Dan, were ruled on 2026-11-10 ("A / A", Rulings).

## Not checked

- A full T3 Code approval on a free callback port.
- An update from GitHub. Checked on 2026-11-10 only with Developer ID dry-run builds (not notarized) and a feed on `127.0.0.1`: found 15 s after start, downloaded, installed by Squirrel.Mac on Restart and on When I Quit, for Stable and Nightly, with no listening port. The repo is private until section 8, so the GitHub provider has not read a real feed.
- Squirrel.Mac reopening the app after Restart. The drill turns it off: a reopened test copy would start on Dan's own data folder.
- `app.moveToApplicationsFolder()` itself. It would put a copy in `/Applications`.
- `npm run release` past its checks. It is the local fallback now, needs Dan and Touch ID, and no agent runs it.
- A signed build in Actions: the load step with the real vault, notarization from a runner, and the release checks there. The unsigned dry run rehearses the CLI download and the keychain steps, not these. The `signing-check` run is the first check of the vault and the key; the first Nightly is the first check of the rest.
- The vault items' exact shape. The CLI path is the one `npm run release` used on 2026-11-09 for the key; the certificate item has not been read by any script yet. A wrong shape fails with the item's field labels and file names, never its values.
- `OP_CONFIG_DIR` and `OP_CACHE` on the runner. Both are named in the CLI 2.41.1 binary's help text; their effect on a runner is not checked.
- Approving a Stable from the GitHub app on a phone, and its notification. The approval itself is GitHub's documented "Review deployments".
- That three tries cure the hidden `--capture` start on a runner. In four pull request dry runs on 2026-11-10 it failed twice: the app started and showed its page, then `capturePage` rejected with `UnknownVizError` (the runners have no GPU). The capture now tries three times and the check names any failed tries. If it still fails a release build, the run stops before publishing and can be started again.
- The schedule. It first runs the day after the workflow lands on main.
- Starting a release from the GitHub app on a phone. The web page's Run workflow button is the documented route; the app's is not checked.
- That GitHub drops the redirect when the old name is reused (section 8, step 4). This is from GitHub's docs, not tried here.
