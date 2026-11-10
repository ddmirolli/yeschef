Yes, we should borrow from T3 Code, mostly its rules and data shapes, and keep our own code light. The biggest speed gap is live updates. T3 Code's own apps get changes pushed to them, while Yes Chef has to ask every 3 seconds. T3 Code already supports a way for us to get the push version too, but I haven't tested it.

**1. Your encryption question**
- The Chef de cuisine (CdC) reads everything in plain text, because their app holds the key. Only our relay sees scrambled data. It works like iMessage: Apple carries the message but can't read it, and your friend reads it fine.
- To finish a ticket, the CdC needs the call, the screenshots, the PR and the agent's last message. All of it travels encrypted and opens normally on the CdC's screen.
- Actions travel the other way. When the CdC taps Refire or answers a call, their app encrypts the action. The dev's Yes Chef decrypts it and runs it on the dev's own T3 Code.
- Go on a PR is a merge, so the CdC can do it with their own GitHub access even when the dev's laptop is shut.
- If the dev's laptop is asleep, a refire or answer waits and shows "Not heard", the word we already use.

**2. What to take from T3 Code** (read in their main branch today)
- **Live updates.** This is the biggest win.
  - T3 Code's apps keep one open connection per machine. They get one full copy, then only the changes. We ask every 3 seconds.
  - T3 Code doesn't give that stream to outside apps that sign in the way we do. But the stream only needs read access, and a T3 Code pairing can be limited to read access (`RpcAuthorization.ts:61`, `cli/pair.ts:488`).
  - So a read-only pairing could give us T3 Code's own speed, while actions still go through our limited sign-in.
- **Reconnect rules.** We should copy these as rules, not code:
  - Only one part of the app handles retries.
  - Wait times between retries are randomized and top out at 5 minutes.
  - The app checks the connection when it wakes or the network changes.
  - "Connected" and "data is current" are tracked as separate states.
  - Old data stays visible but never looks live. That's already our "not checked" rule.
- **The summary format.** T3 Code's server already sends a short summary of each thread to its relay for phone alerts: project, thread, stage, headline, model, time and a link. We can use the same format for each dev's updates. Theirs is plain text; ours would be encrypted.
- **Accounts.** T3 Code uses Clerk on desktop and mobile. Clerk's Organizations feature covers teams, roles and invites, and single sign-on is in the same feature. Clerk Billing covers per-seat plans. I haven't checked Clerk's pricing.
- **Desktop.** We already made T3 Code's two main choices: the app loads its own page from a private address and opens no network port. Still to take: automatic updates, and keeping the app running in the background so it can keep relaying.

**3. Your onboarding flow**
- It works as you describe it, and all of it fits before single sign-on, logs or reports.
- One addition: when the CdC taps Yes in the role dialog, their app gives that person the kitchen key at that moment. A leaked invite link on its own can't read anything.
- The chart only holds people. Each person's agents show up under them automatically, with no dragging.

**Decisions**
1. How does Yes Chef get live updates from T3 Code?
   a. A read-only pairing for T3 Code's live stream, plus our limited sign-in for actions. Test it first.
   b. Ask T3 to add push updates for outside apps like ours, through a code change to T3 Code. That's the cleaner route, but we'd be waiting on them.
   c. Keep asking every 3 seconds.
   Recommendation: a now. Offer b to the team next week.
2. How much do we take from T3 Code?
   a. Their rules, data formats and design choices, written into our own light code.
   b. Their actual code and frameworks, copied in. Their shared client code alone is 51k lines, isn't published as a package, and changes often.
   Recommendation: a.
3. What do we use for accounts?
   a. Clerk, with each kitchen as a Clerk organization and your role checkboxes as its permissions.
   b. Build our own.
   Recommendation: a. T3 Code uses it, and single sign-on and billing come with it later.

Once you answer, I'll write the brief with mocks of sign-up, the invite drawer and chart, the role dialog and the team pass.
