# The pass, Opus entry

The pass as a kitchen rail. Dishes ride left to right across seven gate trays, and every open call lands at the head of the pass on the far right, one tap or one key from a ruling.

## Design idea

1. Seven gate trays run left to right as recessed wells. Each dish is a raised tile on its tray, and a chevron between trays carries the eye toward the pass.
2. The head of the pass is the one elevated, lamp-lit card on the far right. It holds every dish with an open call, oldest first, with the question, thumbnails, and the expo's recommendation on the tile. A dish that waits there leaves a dashed ghost in its own tray, so the flow stays honest.
3. A plate opens as a sheet. The call, its context, and large images sit on the left. The decision panel sits beside them on a Mac and pins to the bottom edge on an iPhone. One confirm step comes before every send, and after a send a "Next call" button takes focus.

## HIG principles applied

- **Depth for hierarchy.** Trays are wells, tiles sit one level up, the head is the only card with a large shadow and a warm glow, and a plate is a modal sheet over a dimmed, blurred board.
- **Clarity.** Each tray header names its gate and what it means ("PR open", "On staging"). Each tile shows its project, title, id, and its worst component note in color.
- **Deference.** One translucent toolbar with a blur material. Color carries meaning only. Orange waits on Dan, red failed or was not checked, green is done, blue acts.
- **System type and color.** The `-apple-system` stack, the system mono for ids only. Apple system colors, darkened or lightened where needed to pass AA. Grouped backgrounds `#F2F2F7` light and `#1C1C1E` dark, cards `#FFFFFF` and `#2C2C2E`, raised `#3A3A3C`. No pure black and no neon.
- **Consistent geometry.** Corner radii on one ramp (10, 12, 16, 20, 22 px). Spacing on an 8 px grid.
- **Default and cancel.** Send is the only filled button in a plate. Cancel is gray. Escape takes back a pick before it closes anything.
- **Feedback in place.** The picked option gets a ring, a confirm card names the option, the Send button reads "Sending...", and the server's own result text shows in the panel. The tile on the board gets an "Answered" tag.
- **Reachability on iPhone.** The head comes first. The decision panel pins to the bottom edge. Targets are at least 44 px. A segmented gate bar shows the whole rail at once and scrolls the trays. Once the head scrolls away, an "Open the oldest call" capsule appears at the bottom.
- **Accessibility.** Real buttons, native `dialog` with focus return to the tile, a visible focus ring, an `aria-live` result, and `prefers-reduced-motion` honored. I computed WCAG contrast for every text and tint pair the page uses, and each passes 4.5:1.

## Shortcuts

| Where | Key | Does |
|---|---|---|
| Board | Arrow keys | Move to the nearest plate in that direction |
| Board | H | Go to the oldest call at the head of the pass |
| Board | Return or Space | Open the focused plate |
| Anywhere | ? | Show every shortcut |
| Plate | 1 to 9 | Pick an option (opens the confirm card, focus moves to Send) |
| Plate | Return | Send the picked option |
| Plate | N | Write a note |
| Plate | Cmd+Return | Send from inside the note |
| Plate | Return after a send | Open the next call |
| Plate | Esc | Take back the pick, then close the plate |

The page shows the hints the way macOS menus do. Option buttons carry their number, Send carries the Return glyph, Cancel and Close carry esc, the head has a key row, and the toolbar has "Shortcuts ?". The phone hides them.

## Truth and scope

- A failed source shows in a strip with its time and error, and its toolbar lamp turns red. A dish whose gate was not checked sits in a red "Gate not checked" group off the rail. A missing Linear issue shows a red "Linear not checked" chip in the plate, and the tile falls back to the board's outcome text.
- The board refreshes in place every minute. It never refreshes while a plate is open or a note is half written. If a refresh fails, a notice says so and gives the age of the board on screen.
- `answer()`, `component_gate`, `dish_gate`, `cached`, and every other fetch and check function are byte-identical to the seed. I checked this by comparing function sources with `ast`.
- One server change. `/answer` returns its status and text as plain text when the request carries `X-Pass-Fetch: 1`, so the page can show the result in place. The form fields (`key`, `option`, `note`) are unchanged. A plain form post still gets the 303 redirect.
- Tests: three rendering assertions now match the new markup and prove the same behavior. Three tests are new: an answered call leaves the head, a script post gets the result in place, and a plain post still redirects. `python3 -m unittest test_pass.py` runs 30 tests, all OK.

## Shoot command

```
python3 pass.py --demo 8611
tools/shoot.sh 8611 /tmp/ab-shots/opus opus '[{"click":"[data-dish=REV-905]"},{"wait":800}]'
```

Extra checks, all in `/tmp/ab-shots/opus-check`, each with a clean demo log unless noted:

- `keys`: `[{"press":"h"},{"press":"ArrowDown"},{"press":"Enter"},{"wait":600},{"press":"1"},{"wait":300}]`. Keyboard to the confirm card.
- `esc`: open REV-905, press 1, press Escape. The pick is taken back and the plate stays open.
- `help`: press `?`. The shortcut sheet.
- `end`: open REV-905, press End. Stations and PR descriptions.
- `send`: open REV-905, press 1, press Enter. The first view shows the result in place. The later views load with the call answered, the dish back in its Taste tray marked "Ruled", and the head down to two calls.
- `next` and `chain`: send on REV-911, then Return opens REV-905 through "Next call".
- `pill`: press End at 390. The "Open the oldest call" capsule appears.
- `refresh`: press h, wait 62 s. At 1440 light the toolbar went from "Updated 16:15 ET" to "Updated 16:16 ET", focus stayed on REV-911, and no stale notice showed. I stopped this run after the 1440 views, so the 390 views of this check are missing.

## Known gaps

- Browserbase runs Linux Chrome, so the shots show a fallback sans and DejaVu Sans Mono. Dan's devices show SF Pro and SF Mono.
- Full-page shots at 390 come out 375 px wide while the page lays out at 390, so the right edge looks tight. The seed baseline shots have the same clip. The 390 viewport shots are correct.
- Shots verify the success path, the answered state, Escape, the next-call chain, and the shortcut sheet. The "already answered" (409), refused (403), and network failure paths are covered by the route test and by reading the code, not by a shot.
- The demo has no dish with two calls, no long head that has to scroll, and no empty board. The code handles each. I did not shoot them.
- I shot only at 1440 and 390. Between 761 and 1100 px the rail scrolls sideways and the head is 340 px wide. I did not shoot that range.
- Contrast is computed by formula for the colors in the CSS. I did not run an automated audit tool such as axe.
- Spatial arrow navigation is verified for H then Down. Moves across trays follow the same code, but I did not shoot them.
