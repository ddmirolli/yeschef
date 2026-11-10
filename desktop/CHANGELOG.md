# Yes Chef for the Mac: changes

Each Stable release has a section here, `## <version>`. `npm run release -- <version>` stops without one and uses it as the release notes on GitHub. Nightly releases need none.

## 0.2.0

- Signed with Developer ID and notarized by Apple, so it opens on any Mac with Apple silicon and macOS 13 or later.
- Updates itself from GitHub Releases. It checks 15 seconds after it starts, then every 4 minutes. You start the download, then choose Restart or When I Quit.
- Offers to move itself to Applications on its first start anywhere else, so it can update.
- Finds T3 Code on its own, and says so when T3 Code is not running.
- Opens no port on your Mac, apart from a moment during sign-in.
- Tested with T3 Code 0.1.7.
