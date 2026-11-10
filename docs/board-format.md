# Board format

The board file is the brigade's state. The pass reads it; the expo writes it, only through `board.py` (see the README). `python3 board.py check` validates a board against this page.

This page follows the brigade spec, section 8 (`docs/agent-brigade-spec-v1_0.md`), and adds the fields Agent Brigade has gained since. A change here that alters what the spec states needs the same edit there.

```json
{
  "repo": "owner/name (optional: the default GitHub repo for every dish)",
  "service": { "opened": "time", "expoThread": "T3 thread id", "closed": null },
  "dishes": [
    {
      "id": "REV-123",
      "outcome": "One-line scene of the plated dish",
      "close": "carry | 86 | blocked | null",
      "repo": "owner/name (optional)",
      "components": [
        { "station": "website", "thread": "T3 thread id", "pr": 0, "base": "main", "prep": "repo path or null", "repo": "owner/name (optional)" }
      ],
      "calls": [
        { "question": "text", "options": ["a. ...", "b. ..."], "recommend": "a", "thread": "T3 thread id", "asked": "time",
          "context": "plain text; blank lines split paragraphs; lines that start with '- ' are bullets",
          "visual": false,
          "images": [{ "path": "<date>/<topic>/<file>.png (under ~/rw-artifacts)", "caption": "after, dark, 390" }],
          "links": [{ "label": "text", "url": "https://..." }] }
      ],
      "context": "optional dish notes", "images": [], "links": [],
      "plating": { "at": "time" },
      "plated": { "receipt": "URL or path", "at": "time" }
    }
  ]
}
```

## Fields

- **Areas** (the `station` field; the name stays so live boards stay valid): website, funnels, app-ui, backend, data, words, design.
- **Times:** `2026-11-05T13:40` is local (ET). A time with `Z` or an offset (`2026-11-05T18:40:00Z`, `2026-11-05T13:40:00-05:00`) is converted to ET. `board.py` writes local time with its offset.
- **Stages** (`docs/pass-definitions-v1_0.md`, developer words since 2026-11-10): Backlog, Planned, In progress, In review, Ready to merge, Merged. The pass derives In progress, In review, and Merged from GitHub; the file does not store any stage, so a board from before the rename reads the same. A merge into the PR's base branch is Merged.
- **`plating` (optional):** the dish waits for Dan's look. The pass shows Ready to merge only while every PR is in review, so a change request (a PR back in progress) wins over the mark. The field keeps its old name. Set it with `board.py plating DISH`, clear it with `board.py plating DISH off`. `plate` clears it.
- **`plated`:** the receipt. The dish goes on the spike and counts as done. The name predates the stage words; it keeps its meaning so live boards stay valid.
- **`close`:** `blocked` and `86` move a dish to On hold (the pass shows "86" as Canceled). `carry` keeps the dish in its stage.
- **Calls:** every call has `context`, a `thread`, an `asked` time, at least two options, and one `recommend` that matches an option. Dan rules from the pass alone (ruling 2026-11-05).
- **`visual` (optional, per call):** whether the call needs images.
  - Not set: the dish rule applies. A call on a dish with a website, funnels, app-ui, or design component needs images.
  - `false`: the call has nothing to show (a publish rule, a storage choice, a permission check), so the pass does not flag it.
  - `true`: the call needs images even on a dish without a visual station.
  - A call that needs images and has none shows the red "no visuals attached" flag. Only a real `true` or `false` counts; `board.py` refuses any other value.
- **Images:** an https URL, or an image file under `~/rw-artifacts/`, given relative to that folder or as a full path. The pass serves only that folder.
