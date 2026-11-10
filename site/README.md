# Yes Chef marketing site

Static. No build, no packages. One remote request: the visitor's browser asks GitHub's public API for the newest release (`releases.js`), as t3.codes does. Serve the folder as it is (the demos need a server that sends `.mjs` as JavaScript, which this one does on macOS; `python3 -m http.server` has no `/download` route, so open `download.html` there):

```sh
python3 -m http.server 8615 --bind 127.0.0.1 --directory site
```

## Deploy

Live at https://yeschef.codes as the Cloudflare Worker `yeschef-site` (static assets, custom domain), config in `deploy/yeschef/wrangler.jsonc`. Deploy from the repo root with Wrangler 4 (`npx wrangler@4 deploy --config deploy/yeschef/wrangler.jsonc`), with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` supplied at run time by the RW 1Password service account. `site/.assetsignore` keeps this README and `CREDITS.md` off the site.

## Files

- `index.html`: the page.
- `download.html`: the download page, served at `/download` (Cloudflare serves `download.html` there and sends `/download.html` to it).
- `releases.js`: the download links, the way t3.codes does them (PR D, 2026-11-10). Every Download button starts at `/download`; the script asks GitHub for the newest Stable release (`/releases/latest`) and links its `-arm64.dmg`, and the line under the hero's button names its version and size. On `/download` it does the same for Stable or Nightly (`?channel=nightly`, the newest of GitHub's latest 30 releases with a `-nightly.` tag; if all 30 are Stable, the page links GitHub's Nightly list rather than say there is none). Answers are kept for the tab in sessionStorage. A 404 (no release yet, or the repo still private) leaves the buttons on `/download`, which says "No release yet." A failed request or a body that fails to read leaves the buttons there too, and the page links GitHub Releases. A release changes nothing here: the site needs no deploy to ship a version. `releases.test.mjs` tests it (`node --test site/*.test.mjs`); `.assetsignore` keeps tests off the site.
- `style.css`: the page styles.
- `site.js`: the nav hairline, the hero motion (ported from T3 Code's site, MIT; see `CREDITS.md`), the "I run" toggle, the hero demos (each loads the first time its view shows), and the buttons under the modes that drive them.
- `demo/`: the hero demos, one per view, each in an iframe.
  - `app.html` (agents view): the Yes Chef app itself on a made-up kitchen. Generated; never edit it by hand (see Placeholders). `shim.js` stands in for the app's server, `boot.mjs` starts `kitchen.mjs` (the made-up kitchen and its kitchen rules), and `lib/` holds the app's own modules, copied from `client/`.
  - `team.html` (devs view): a clickable mock of a lead's Pass and full kitchen, written by hand. Teams is in design.
- `fonts/`: Fraunces (headings) and Figtree (body), latin subsets, SIL OFL 1.1.
- `assets/`: the Yes Chef mark, the agent marks from T3 Code's site, and the start section's shots.

## Origin

Dan picked Fable's bakeoff entry as the base on 2026-11-06 and asked for:

- no logo lockup above the headline; the station labels stay on the hero marks;
- Opus's "Run the pass" demo in place of Fable's service demo, with its glitches fixed;
- any ticket opens full screen with its visuals, so visitors can compare before and after;
- a cookbook display face for headings (Fraunces) and a plain sans for body (Figtree).

Later on 2026-11-06 Dan added: the cloche badge centred above the headline and the nav lockup in Fraunces; a calmer demo (fixed line under The Pass, a slower Last call); developer-plain brigade copy built on the Chef staying at the pass; the problem (our own story) and the fix as two cards; no footer licence line or Credits page (the MIT notice stays in `site.js`, `CREDITS.md` stays in the repo).

On 2026-11-07 Dan added "The bill" after Our way: the token chart from a replay of our own 30 days of T3 Code logs (Oct 8 to Nov 7), with Yes Chef in place of the ATC threads cutting 19% without auto-compaction and 14% with it. The scenario figures are modeled, and the copy says so. Keep the four rows, values and 0 to 40B scale as they are; Claude and Codex have their own chart tokens because blue means "at the pass".

Later on 2026-11-07 Dan cut the eyebrows and asked for headers in plain dev talk, the way t3.codes writes them ("Bring your own sub", "If you don't like something, fork it."). His hero (final, same day): "The French Brigade layer for agentic coding." and "Run T3 Code in our open-source layer, work The Pass like a Chef de Cuisine, and let your agents cook." (Chef de Cuisine is a title: capitalized, no accents, "de" lowercase) His one kept header: "French kitchens solved agentic coding a long time ago." No eyebrows on this page.

On 2026-11-09 Dan added the team view. "I run" over [agents][devs] sits between the sub-line and the button and switches the page between solo (agents) and team (devs). Team is the default; `?view=solo` or `?view=team` picks one, and the page remembers the last pick. The control moves like Apple's segmented control within 300 ms (a plain fade under reduced motion). Team hero: "The French Brigade layer for agentic dev teams." and "Run your team’s T3 Code in our open-source layer, work The Pass like a Chef de Cuisine, and let every agent cook."

Later on 2026-11-09 Dan ruled how the toggle changes the whole page (rulings 1A, 2B and 3C):

- One page. Every section is in both views, in the same order, and swaps its words and pictures in place. Never add a section or a block that only one view has.
- The agents view speaks to a dev who runs their own agents in T3 Code. The devs view speaks to the lead. (Until the full pass below, the agents view's kitchen section spoke to a dev joining a lead's kitchen. Dan overruled that.)
- Each `.swap` slot stacks its `[data-swap="solo"]` and `[data-swap="team"]` versions in one grid cell, so the slot is as tall as its taller version and a flip never moves the page. Where one version runs a line shorter at some width, it sits in the taller slot. To measure a version's own height, set `align-self: start` on the slot's children first; grid items stretch to the slot.
- Once the hero's toggle scrolls up under the nav, a second toggle shows in the nav: left of Download on wide screens (2B), in place of Download and GitHub at 600 px and below (3C). Both toggles stay in step.
- Check a change at 18 widths, 1440 to 320: a flip at every section moves nothing, and nothing scrolls sideways.

Later on 2026-11-09, after #60, Dan asked for a full pass:

- The hero shows a demo you can click for each view, never the same picture in both: the app itself in the agents view, the Teams mock in the devs view. Nothing leaves a demo's pass on its own: every ticket there waits for the visitor's call (the old demo closed tickets by itself). New work may still arrive while they watch. The old "Try it" section and its simulated service are gone; the service's plate drawing moved to `tools/hero-art/`.
- Section order: the demo; the modes (Open kitchen and French Brigade for a lead, Kitchen rules for a dev on their own); the problem; French Brigade and what it does for you; speed, tokens and the bar; how you run the Pass; how to start. The babysitting section is cut.
- The agents view's modes slot shows Kitchen rules, which the app has today (ruling 1A). Open kitchen and French Brigade for a dev on their own need a merge-mode setting in the app first; switch the slot only once it ships.
- Every picture shows the current app or the current Teams mocks. No older renders.
- Tokens stay "modeled, not measured", and the page gives no number for time saved until it is measured.

Later on 2026-11-09 Dan renamed the toggle's segments from [agents][devs] to [solo][team], the same words as `?view=solo` and `?view=team`.

## Placeholders

- The hero's and the close's buttons were "Sign in with T3 Code" (`#sign-in`) until PR D. There is no hosted sign-in: the Mac app signs in with T3 Connect.
- The nav's GitHub link points at `ddmirolli/yeschef`, which is private until it goes open source.
- `demo/app.html`: the Yes Chef app's own page on a made-up kitchen (three made-up products, Fernpay, Loopline and Quillo, with logos in `tools/hero-art/icons/`), from `demo/kitchen.mjs`. Never real projects. After a change to the app's UI in `client/`, run `node tools/site_demo.mjs` from the repo root. It copies the app's modules to `demo/lib/`, saves the server's page with the stand-ins, and fails unless the browser's first render matches the server's. The open ticket's before and after shots come from `tools/hero-art/plates.html` (steps at its top).
- `assets/app-kitchen-*.png` and `assets/app-launch-*.png`: the agents view's start shots, taken from the demo at 1440 by 900. To retake them, serve a copy of `demo/` with `app.html` as `index.html`, then:

  ```sh
  rm -rf /tmp/yc-demo && mkdir /tmp/yc-demo && cp -R site/demo/. /tmp/yc-demo/ && cp site/demo/app.html /tmp/yc-demo/index.html
  python3 -m http.server 8616 --bind 127.0.0.1 --directory /tmp/yc-demo &
  tools/shoot.sh 8616 /tmp/yc-shots kitchen '[{"press":"Escape"},{"press":"v"},{"wait":800},{"press":"Escape"}]'
  tools/shoot.sh 8616 /tmp/yc-shots launch '[{"press":"Meta+k"},{"wait":500},{"fill":"#launch textarea[name=prompt]","text":"Add a CSV export to the payouts table. One button above the table, the rows as filtered."}]'
  ```

  Copy `/tmp/yc-shots/<kitchen|launch>-<dark|light>-1440-open.png` to `assets/app-<kitchen|launch>-<dark|light>.png`, then stop the server.
- `assets/team-s3-invite.png` and `assets/team-s5-join.png`: the Teams mocks from `docs/mocks/team/`. Teams is in design, and the start section says so. `demo/team.html` follows the same brief.
- Every ticket in the demos, its screens, checks and pull request numbers are invented for the page.
