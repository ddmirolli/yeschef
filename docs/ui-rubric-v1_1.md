# Yes Chef grading rubric v1.1 (locked by Dan, 2026-11-07)

Every council member and hill-climb round scores Yes Chef with this rubric. A score must follow from the criteria below, with evidence. A score that does not follow from them does not count.

## How to score

1. Score every criterion from 0 to 10 in half points, using its anchors. A criterion between two anchors takes the score between them.
2. Cite evidence for each criterion: a screenshot name, a `file:line`, or a reproduced step. A criterion without evidence is "not checked": leave it out of the sums and list it.
3. An axis score is the weighted mean of its criteria.
4. Apply the caps (below) after the mean.
5. Overall = UX 40% + UI 30% + Design 30%. UX weighs most because Dan's goal is working the pass fast and well.
6. For every criterion under 9, name the change that would raise it and by how much.
7. Start from the round's verified findings list (the thread owner checks every cap-level finding in the code and gives the same list to every member). Apply every cap on that list. A new cap-level finding counts once the thread owner verifies it; until then, report it and do not apply it.
8. Score only what the round's captures and code show. Do not raise a criterion for a fix that is described but not captured.

## What the numbers mean (all criteria)

| Score | Meaning |
|---|---|
| 10 | Best in class. Matches Linear or Superhuman side by side; nothing to change. |
| 9 | Ship-ready. A reviewer can name only polish. |
| 8 | Good. One or two gaps a careful user notices. |
| 7 | Solid, with one structural problem a user meets in normal use. |
| 6 | Works, with several visible problems. |
| 5 | Prototype quality. |
| 4 or less | Broken or misleading in normal use. |

A 9 on an axis needs every criterion in it at 8 or higher and no cap applied.

## Caps

- A bug that loses or sends Dan's input wrongly (an early send, a lost draft, a wrong answer): UX at most 6 if it happens in normal use, at most 7.5 if only in an edge case (reload, project switch).
- Data shown as current when it is not checked: UX at most 6.
- Text under 4.5:1 contrast, or controls under 3:1, in normal use: UI at most 7.
- Any of Dan's settled decisions not honored: Design at most 7.
- One finding sets one cap, on the axis it names. A bug that caps UX does not also cap Design, even when it breaks a settled decision.
- Required views not captured (1440, 1280x720, light, phone, a question ticket): the score is provisional; say which.

## UI: visual craft (30%)

| # | Criterion | Weight | 10 | 8 | 6 | 4 |
|---|---|---|---|---|---|---|
| U1 | Layout and spacing | 20% | Every gap and edge sits on a 4 px grid; columns align across panels; no orphan rows or dead zones | One or two misaligned edges or a visible empty zone | Uneven gaps between like items; a dead zone over 150 px | Overlaps or clipping |
| U2 | Typography | 15% | At most 5 sizes with clear roles; lines 60 to 80 characters; one headline per screen | One redundant size or a competing headline | Sizes chosen per screen; long lines | Text clipped or unreadable |
| U3 | Color and contrast | 20% | Every color is a token with one meaning (one color per state, everywhere); AA contrast in light and dark | One state with two colors, or one weak contrast pair | Colors that mean nothing; light and dark differ in quality | Fails AA in normal use |
| U4 | Surfaces and depth | 20% | At most 3 surface levels; one radius scale; selection shown by connection, not fill (Dan, 2026-11-07) | One extra level or an off-scale radius | Mixed fills and borders compete | Surfaces unreadable as layers |
| U5 | Media and attachments | 10% | Screenshots pinned at the top of the ticket at one standard size, paired and labelled; missing files have a sized placeholder (Dan, 2026-11-07) | Standard size but placement or labels vary | Sized by the message | Images break the layout |
| U6 | Responsive fit | 15% | 1440, 1280x720 and 390 each look designed; no clipped titles, no lone wrapped buttons | One width with a cramped area | Content fragments at one width | Unusable at one width |

## UX: flow and behaviour (40%)

| # | Criterion | Weight | 10 | 8 | 6 | 4 |
|---|---|---|---|---|---|---|
| X1 | Speed to decision | 25% | A typical question takes open, read, one key; the next ticket is already open; no wait over 100 ms | One extra step or pause | Several steps; must leave the reader to judge | Acting needs another app |
| X2 | Keyboard | 15% | Every action has a key, shown where it applies; no conflicts; focus never lost on refresh | One action without a key, or one hidden key | Keys exist but must be memorised | Keyboard traps or lost focus |
| X3 | Information order | 20% | Each ticket reads question, evidence, explanation, answer; the relevant PR first; nothing said twice | One item out of order or repeated | The decision is hunted for | The question is missing or wrong |
| X4 | State honesty and feedback | 15% | Every state (loading, not checked, error, sent, undone) is named; nothing guessed is shown as current | One state unclear | Silent waits or vague errors | Misleading state |
| X5 | Error prevention and recovery | 15% | The 4 s Undo always holds; drafts survive refresh and navigation; no double send; retry is safe | One edge case cuts Undo or drops a draft | Recovery needs T3 Code | Input lost |
| X6 | Motion and responsiveness | 10% | Frequent actions animate in 300 ms or less and never block input; reduced motion honoured; the logo turn is Dan's named exception | One slow or blocking transition | Motion gets in the way | Motion breaks the layout |

## Design: one considered product (30%)

| # | Criterion | Weight | 10 | 8 | 6 | 4 |
|---|---|---|---|---|---|---|
| D1 | Coherence | 30% | A ticket, button or chip looks and acts the same in the pass, the kitchen and the sheet | One component differs between views | Each view has its own style | Views feel like different apps |
| D2 | Hierarchy and calm | 25% | One focal point per screen; chrome under a fifth of the window; one primary action | One competing element | Several things shout | No clear focus |
| D3 | Concept fidelity | 20% | The kitchen words and Dan's settled decisions are carried through every screen | One screen drifts | The metaphor is decoration | Contradicts Dan's decisions |
| D4 | Reference calibre | 25% | Side by side with Linear and Superhuman, it looks at home: none of the prototype tells below | One tell | Three or more tells | Clearly unfinished |

Prototype tells (D4): a native form control (radio, checkbox, select) left unstyled; a textarea resize grip; the browser's own disclosure triangle; an empty band of chrome; a clipped or ellipsised title in a normal view; a button wrapped alone onto its own row; an image sized by its file; a dead zone over 150 px.

## Report format

```
UI     7.1  (U1 7, U2 8, U3 7.5, U4 6, U5 6, U6 8)            caps: none
UX     7.5  (X1 8, X2 8.5, X3 7, X4 8, X5 6.5, X6 7)  mean 7.55,  caps: Undo cut short on project switch (edge case) -> 7.5
Design 7.1  (D1 7.5, D2 7, D3 8, D4 6)                     caps: none
Overall 7.3  (0.4 x 7.5 + 0.3 x 7.1 + 0.3 x 7.1)
Not checked: T3 question card (no capture)
```

Then one line per criterion under 9: evidence, the change, the expected gain.
