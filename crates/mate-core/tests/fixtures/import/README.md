# Import fixtures (Phase 4)

The importer tests do not ship binary sample files. Each test builds its fixture in memory with a small encoder that lives next to the test (`tests/import_<format>.rs`), so the bytes are reproducible and reviewable. This directory only documents what each encoder must produce and what the parser must return. The format rules (field numbers, keys, byte offsets) and their sources are in the local research notes `docs/analysis/05-import-formats.md` (not committed).

Shared content, unless a format cannot express it:

- one section with three pages; pages 1 and 2 each hold two pen strokes, one highlighter stroke, one text and one image; page 3 is empty
- stroke A (pen, `#0000ff`, width 2), stroke B (pen, `#ff0000`, width 3), stroke C (highlighter, `#ffff00`, width 12), each a horizontal line starting at x = 10 (y = 20, 40, 60 on page 1; page 2 adds 100 to y)
- text "Hello" at (50, 100) with width 200 (page 2: "World" at (50, 200))
- image: a 1x1 PNG at (50, 300), size 100 x 50 (page 2: y = 400)
- coordinates are in source units; Mate's placer scales by `s = 1080 / page width`, so the expected values below are after scaling

| Fixture (built by) | Task | Source page width, s | Sections / pages | Strokes per page (p1, p2, p3) | Highlighters | Texts | Images | Notes |
|---|---|---|---|---|---|---|---|---|
| `goodnotes_basic` (`goodnotes_fixture::build`) | 4 | 540, s = 2 | 1 / 3 | 3, 3, 0 | 1 per stroked page (alpha 0.5 < 0.6) | 1, 1, 0 | 1, 1, 0 | stroke A has 3 points after quadratic flattening; widths 4 / 6 / 24 after scaling; one stroke uses an LZ4 `bv41` block, the others `bv4-` raw |
| `goodnotes_tombstone` | 4 | 540, s = 2 | 1 / 1 | 2 | 0 | 0 | 0 | a deletion record hides one of three strokes |
| `goodnotes_truncated` | 4 | – | – | – | – | – | – | `goodnotes_basic` cut at 50 offsets: `Corrupt` error, never a panic |
| `goodnotes_oversize` | 4 | – | – | – | – | – | – | over 100 MiB: `Limit` error |
| `notability_basic` (`notability_fixture::build`) | 5 | 540, s = 2 | 1 / **1** (Notability is one canvas) | 3 | 1 (alpha 128 < 200) | 1 | 1 | page height 700; stroke B per-point widths 3, 4, 5, 6, stroke width 9 after scaling |
| `notability_empty` | 5 | 540, s = 2 | 1 / 1 | 0 | 0 | 0 | 0 | curves dictionary with empty data: a page, not an error |
| `notability_nocurves` | 5 | – | – | – | – | – | – | no curves dictionary: `Corrupt` |
| `notability_cycle` | 5 | – | – | – | – | – | – | self-referencing UID: `Corrupt`, no hang |
| `notability_truncated` | 5 | – | – | – | – | – | – | cut at 50 offsets: `Corrupt`, never a panic |
| `freenotes_basic` (`freenotes_fixture::build`) | 7 | 540, s = 2 | 1 / 3 | 3, 3, 0 | 1 per stroked page (ink type 2) | 1, 1, 0 | 1, 1, 0 | z order follows `drawOrder` (layer, at, id): strokes, then text, then image |
| `freenotes_pencil` | 7 | 540, s = 2 | 1 / 1 | 1 | 0 | 0 | 0 | pencil ink (type 3): pencil pen style, opacity 0.39 |
| `freenotes_encrypted` | 7 | – | – | – | – | – | – | zip entry with the encryption flag: `Encrypted` |
| `freenotes_backup` | 7 | 540, s = 2 | **2** / 1 each | 1 | 0 | 0 | 0 | `.freebackup` with two `*.frnote/` notes |
| `freenotes_truncated` | 7 | – | – | – | – | – | – | cut at 50 offsets: `Corrupt`, never a panic |
| `samsung_basic` (`samsung_fixture::build`) | 8 | 720, s = 1.5 | 1 / 3 | 3, 3, 0 | 1 per stroked page | 0 | 1, 0, 0 (best effort) | stroke A points (15, 30), (22.5, 30), (30, 30), (37.5, 30), pressures 0.125 to 0.5; widths 3 / 4.5 / 18 |
| `samsung_truncated` | 8 | – | – | – | – | – | – | cut at 50 offsets: `Corrupt` or fewer strokes, never a panic |
| OneNote (no encoder) | 6 | page width 1080, s = 1 | – | – | – | – | – | unit and colour tests only: 2540 HIMETRIC = 96 px, BGR 0x00FF0000 = `#0000ff`, transparency below 128 = highlighter, half-inch 2.0 = 96 px; `.one` and `MSCF` magic; a parse test against a local sample stays `#[ignore]` |

Colours in every format are emitted as lower-case `#rrggbb`. Opacity is 1 for pens unless the source stores alpha (GoodNotes 0.5, Notability 128/255, Freenotes 0x80/255 for stroke C).
