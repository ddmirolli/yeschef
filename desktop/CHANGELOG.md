# Yes Chef for the Mac: changes

Each Stable release has a section here, `## <version>`. `npm run release -- <version>` stops without one and uses it as the release notes on GitHub. Nightly releases need none.

## 0.2.3

- You, expanded: your threads flow through the stages as one chart, left to right. Each thread is its own strand, and each band stops at the stage it is in.
- The header is the project picker, with icons only.
- Your team now comes from the team relay: what each teammate's Yes Chef sends, live.
- Your team, expanded: in Open kitchen, a row per person with their threads and the reviewers each PR waits on; in French Brigade, a chart of the team's threads by stage, grouped by feature (the Linear project of their tickets) or by person.
- Act on a teammate's call from The Pass: Reply, Request changes, Rebase, Roll back, answer their question, or Hold. It goes to their Yes Chef, which checks your role and runs it through their own T3 Code sign-in, with your name on it.
- It's fine clears a team call from every Pass that shows it, and records who cleared it and when.
- Readers for your team's calls: the fixes tried, the last message, and the changed files. A PR that is too big opens its diff from T3 Code in a panel beside the reader, with T3 Code's switches to collapse all files and hide test files.
- The reader shows the Linear tickets your agents read in T3 Code, from their own Linear calls. Yes Chef makes no Linear calls of its own.
- Settings → Rules holds your team's rules: escalation, thresholds, model checks and areas.
- Tested with T3 Code 0.1.7.

## 0.2.2

- Invite your team: ⌘K, Invite your team. Make a team and send its link. Each dev who opens it asks to join, and you place them on the chart: Lead, Deputies, areas with their Area owners and Engineers, and Viewers. Drag an ask onto a slot, or click it. The same six digits show on their screen and beside their ask, so you add the right person.
- Join a team from its link. You see your role, who can act on your threads, and what you share.
- Open kitchen, expanded: Your team as a full board. The base and when it went red, merges today by hour, PRs waiting for review, agents running, who's on what, and each Overlap: a file that two live threads both change. The Pass sits beside it as a column.
- Your teammates see more of your work: when each thread started, its last message and open question, the lines it changes, and each PR's checks, ready time and merge.
- Yes Chef checks what it gets from T3 Code, GitHub, the team relay and the update server. A reply it cannot read is refused or shown as not checked, never shown as a guess.
- Tested with T3 Code 0.1.7.

## 0.2.1

- Change any shortcut in Settings → Shortcuts. Record a new key, swap it with the command that has it, or reset one or all. The Mac app keeps your keys in `keybindings.json` in its data folder, in T3 Code's format and with its rules: an entry replaces its command's default keys, and the last rule for a key wins.
- No more blinking: a refresh redraws only what changed, so the open ticket and the selected card stay still.
- Settings sits in the middle of the window and scrolls inside it, so it never runs off a short window.
- The expanded view is the six stage columns alone, from the top of the window to the bottom. When they do not fit, they scroll sideways, and a word in a title is never split.
- Tested with T3 Code 0.1.7.

## 0.2.0

- Signed with Developer ID and notarized by Apple, so it opens on any Mac with Apple silicon and macOS 13 or later.
- Updates itself from GitHub Releases. It checks 15 seconds after it starts, then every 4 minutes. You start the download, then choose Restart or When I Quit.
- Offers to move itself to Applications on its first start anywhere else, so it can update.
- Finds T3 Code on its own, and says so when T3 Code is not running.
- Opens no port on your Mac, apart from a moment during sign-in.
- Tested with T3 Code 0.1.7.
