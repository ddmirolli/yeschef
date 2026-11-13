# Yes Chef marketing site

Astro and strict TypeScript, built as static HTML, CSS, and browser modules. Node.js 24 runs the build and tests. The deployed site needs no server runtime.

Dan chose Astro and TypeScript on 2026-11-10 and asked to preserve the existing design and style. This migration keeps the page copy, CSS, assets, solo/team views, downloads, and embedded demos. The application's TypeScript refactor is separate.

## Develop and verify

Run from the repository root:

```sh
vp install
npm run dev --prefix site -- --port 8615
```

`site/` is in the pnpm workspace, so `vp install` at the root installs it with the rest. The tests inspect the generated HTML, so `npm test` builds first:

```sh
npm test --prefix site
node tools/public-tree.ts check
```

The build runs strict TypeScript and Astro checks before it writes `site/dist/`. `.github/workflows/site.yml` runs the same checks on site pull requests, and `vp run -r test` at the root includes them. To check Cloudflare's redirects and static routing locally:

```sh
site/node_modules/.bin/wrangler dev --config deploy/yeschef/wrangler.jsonc --ip 127.0.0.1 --port 8615 --local
```

Browser checks use Browserbase. `site/scripts/verify-browser.ts` compares a served copy of the previous site with the rebuilt site, takes screenshots, and tests view switching, responsive layout, demo actions, and downloads. Supply `BROWSERBASE_API_KEY` through the existing service-account wrapper used by `tools/shoot.sh`. The child process must receive no `OP_*` variables. Run `npm run test:browser --prefix site -- BEFORE_PORT AFTER_PORT OUTPUT_DIR` with that wrapper. The two ports must serve the previous site and the built site respectively. The output folder stays outside the repository.

## Deploy

The existing Cloudflare Worker is `yeschef-site`, at https://yeschef.codes. `deploy/yeschef/wrangler.jsonc` serves only `site/dist/`. Source files, tests, dependencies, and documentation stay outside the deployed assets. Cloudflare keeps the extensionless `/download` route and redirects `/download.html` to it. The embedded demos retain `/demo/app.html` and `/demo/team.html` as working addresses.

After Dan's send-it-out, run `npm run deploy --prefix site` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` supplied at run time by the RW service account. This builds before it deploys. The existing deployment keeps serving until that step. No DNS, domain, relay, or desktop-release setting changes.

## Source and behavior

- `src/pages/`: Astro pages for the home, download, and two demos.
- `src/layouts/SiteLayout.astro`, `src/components/`: the shared head, navigation, and footer.
- `src/styles/`: the original global CSS. Fonts keep the same public URLs.
- `src/scripts/`: typed home interactions, first-paint view selection, download controls, and release lookup.
- `src/demo/`: typed demo state, controls, bootstrap, and browser-only Node stand-ins.
- `public/`: the original images, marks, and fonts, at their existing URLs.
- `demo/app.html`, `demo/team.html` and `demo/lib/*.ts`: generated snapshots of the application, consumed by the Astro demo pages and their bundled bootstrap. `demo/lib/` holds unchanged copies of the app's TypeScript modules, so the typed site checks against the app's own types. They belong to the application, rather than a second handwritten site implementation.

The home page opens on team unless `?view=solo` is explicit. Switching views updates the URL and both controls without saving a preference. The first-paint script is built from checked TypeScript and runs inline in the head.

Every home Download button starts at `/download`. The typed release lookup asks GitHub's public API for the latest Stable arm64 DMG and caches the answer for the tab. The download page also supports `?channel=nightly`, using the latest 30 releases. A full page without a Nightly links the Nightly list rather than claiming none exists. A missing release disables the download; an unavailable API links GitHub Releases. The page shows no version, size, or requirements. A desktop release needs no site deploy.

## Refresh the demos

`npm run demo:generate --prefix site -- PORT` refreshes both app snapshots after an application UI change. Pick an unused port, or omit it to use 8690. The generator runs a temporary copy of `client/` against the made-up kitchen and checks its rendered board against the browser kitchen. It never signs in to T3 Code. It copies the app modules to `demo/lib/` and demo pictures to `public/demo/`. It also draws the team demo's Too big PR (`client/demo-diff.ts`) through the app's diff pipe (`client/diffs.ts`) into `public/demo/diff/`, where `src/demo/shim.ts` answers the page's `/diff` asks. Rebuild the site after generating.

Keep changes to the app's generated snapshot separate from a site-only migration. When the application refactor changes the generator's inputs, update `scripts/generate-demo.ts`, then run the generator and browser checks. The app's own source stays in `client/` and `desktop/`.

The demos contain only made-up products, people, tickets, checks, and pull request numbers. Nothing leaves either pass without the visitor's action.

## The team demo

On 2026-11-12 Dan asked for a made-up team, so the site shows the app's current UI from the solo, Open kitchen and French Brigade sides, collapsed and expanded. The hand-made Teams mock (`src/demo/team.ts`, `src/styles/team.css`) is gone.

- `client/demo-team.ts` is the team: Dana leads 14 people three tiers deep, on the solo demo's projects. Each person's summary has the shape a Mac sends (`client/team-summaries.ts`), and its times follow the clock, so the calls never age. `client/demo-team.test.ts` pins the seven calls it is written for (Main broken, Overlap, two Failing, Too big, Stuck, Waiting) and one person not reporting.
- `demo/team.html` is the solo page with the app body drawn by the browser kitchen with that team (`createKitchen({ team: 'open' })`): the app server has no team until the team connection lands. `src/pages/demo/team.astro` opens it on Your team.
- The app has no mode switch of its own. The Run the demo buttons in the home page's modes section call `__demoMode` in the frame (`src/demo/boot.ts`).

## The modes section

Dan, 2026-11-12, 1C: the devs view's modes section is one frame with an Open kitchen | French Brigade toggle (the I run toggle's look), each mode's text beside a picture of its expanded view. A click on the picture opens it larger (`dialog.zoom`); on a phone it opens at 960 px and pans. The title spans the section with no lede, the toggle heads the text column, and the mode's name shows only on the toggle (Dan, 2026-11-12). Its lines describe only what the app draws today.

- `src/assets/mode-open-{light,dark}.png` and `mode-brigade-{light,dark}.png` are the built team demo (`dist/demo/team.html`), expanded, at 1440x900, shot at 2x on Browserbase. Serve the page as `/` (it opens expanded, in French Brigade; set `data-team="open"` for Open kitchen), then run `SHOOT_SCALE=2 SHOOT_VIEWS=light:1440:900,dark:1440:900 zsh tools/shoot.sh <port> <out> <label>` and copy each `-board.png`. Retake them when either expanded view changes.
- Team actions answer as the app does today: "Not sent: Yes Chef does not have the team connection yet."

Language (Dan, 2026-11-12, "1. A"): strict TypeScript on Node 24, inside the existing pieces. The team is a typed `client/` module built on the summary types, the generator writes the page, and Astro serves it.

Order after the showcase (Dan, 2026-11-12, "2. A"): the step 4 readers (Failing, Stuck, Waiting, Too big, Not reporting) after a mock round; real team data through the relay; the Linear tracker read; deploy and flag readers; Duplicate and Diverging, then Rules.

## Origin

Dan picked Fable's bakeoff entry as the base on 2026-11-06 and asked for:

- no logo lockup above the headline; the station labels stay on the hero marks;
- Opus's "Run the pass" demo in place of Fable's service demo, with its glitches fixed;
- any ticket opens full screen with its visuals, so visitors can compare before and after;
- a cookbook display face for headings (Fraunces) and a plain sans for body (Figtree).

Later on 2026-11-06 Dan added: the cloche badge centred above the headline and the nav lockup in Fraunces; a calmer demo (fixed line under The Pass, a slower Last call); developer-plain brigade copy built on the Chef staying at the pass; the problem (our own story) and the fix as two cards; no footer licence line or Credits page (the MIT notice stays in `src/scripts/site.ts`, `CREDITS.md` stays in the repo).

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

- The hero shows a demo you can click for each view, never the same picture in both: the app itself in the agents view, the Teams mock in the devs view. Nothing leaves a demo's pass on its own: every ticket there waits for the visitor's call (the old demo closed tickets by itself). New work may still arrive while they watch. The old "Try it" section and its simulated service are gone; the service's plate drawing moved to `tools/hero-art/`. Both demos open expanded, the team in French Brigade, and each frame holds the app at 1440x900, scaled to the frame's width, so the app lays out as it does on a Mac (Dan, 2026-11-13). The solo kitchen holds a week's work, about 85 threads over six projects (`src/demo/kitchen.ts`, `WEEK`).
- Section order: the demo; the modes (Open kitchen and French Brigade for a lead, Kitchen rules for a dev on their own); the problem; French Brigade and what it does for you; speed, tokens and the bar; how you run the Pass; how to start. The babysitting section is cut.
- The agents view's modes slot shows Kitchen rules, which the app has today (ruling 1A). Open kitchen and French Brigade for a dev on their own need a merge-mode setting in the app first; switch the slot only once it ships.
- Every picture shows the current app or the current Teams mocks. No older renders.
- Tokens stay "modeled, not measured", and the page gives no number for time saved until it is measured.

Later on 2026-11-09 Dan renamed the toggle's segments from [agents][devs] to [solo][team], the same words as `?view=solo` and `?view=team`.

## Phone screenshots

The app has no phone build (Dan, 2026-11-11). Under 1024 px (phones, tablets in portrait, narrow windows) the hero shows a screenshot of the app for each view, as t3.codes does, in place of the live demo: the app needs a 960 px frame, the Mac app's minimum window. The four PNGs in `src/assets/` (`app-solo-light`, `app-solo-dark`, `app-team-light`, `app-team-dark`) are the built demo pages (`dist/demo/app.html` and `dist/demo/team.html`) as they open, expanded (the team in French Brigade), at 1440x900, shot at 2x on Browserbase: serve each page as `/` and run `SHOOT_AT=2026-11-12T15:45:00Z SHOOT_SCALE=2 SHOOT_VIEWS=light:1440:900,dark:1440:900 zsh tools/shoot.sh <port> <out> <label>`, then copy each `-board.png`. `SHOOT_AT` stops the page's clock mid-afternoon: the demo's times count back from now, so a shot taken early in the day shows a team day only a few hours long. Astro turns them into webp at 800, 1200 and 1600 px wide. Retake them when the app's look changes.
