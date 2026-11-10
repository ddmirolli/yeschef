Every `/free/` tile now has a dark version, in PR #2151. I checked it on the branch preview. Nothing is live until you say go.

![/free/ in dark mode, after](/Users/chef/rw-artifacts/2026-11-02/free-thumbs-dark/free-desktop-dark-after.png)

**What changed**
- **Research, Guides, QR:** new dark versions. The QR code stays dark-on-white on a small white patch, as the dark-mode spec requires.
- **`/booked/`** uses the same grid, so its Scan and QR tiles go dark too.

**Checks**
- Light mode is unchanged: 0 pixels differ before vs after on `/free/` and `/booked/`, desktop and mobile.
- Before and after, dark and light (tailnet only): https://mac.example.ts.net:8443/2026-11-02/free-thumbs-dark/index.html

**Where it stands**
- ATC has #2151 for a line-read ([ATC 10-28](<t3-thread://v2/5f0c2a1e-4b7d-4c3a-9e21-0d6b8a7c3f10/mcp:c116042a-bb2b-4208-b853-8b83342a1245>)). I'm watching the PR and will fix any failed check.

**Decision for you**
1. Ship #2151?
   - a. Yes, merge once CI is green.
   - b. Change something first (say what).

   **Recommendation: a.**
