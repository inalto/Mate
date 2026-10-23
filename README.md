# Mate

**A local-first handwriting & math notes app for Windows, macOS and Linux.**

Write with a pen on an endless canvas or on paged sheets, organise pages into books, sections and shelves, and keep everything on your own machine in a single SQLite file. No account, no cloud, no subscription.

Mate is built with [Tauri 2](https://tauri.app) (Rust shell + a pure-Rust core crate) and a React 19 / TypeScript frontend. The ink pipeline is tuned for low-latency pen input: pressure, tilt, palm rejection, stroke stabilisation and a snapshot-cached Canvas2D renderer.

> Status: **Phase 4 complete** — the foundation, ink editor, rich content (v0.2.0), an optional bring-your-own-key AI tutor (off by default) and importers for GoodNotes, Notability, OneNote, Freenotes and Samsung Notes. Phase 5 (polish) is next. See the [roadmap](https://github.com/inalto/Mate/wiki/Roadmap).

## Features

- **Ink** — pen, highlighter and fountain pen (pressure, tilt, nib flatness), toolbar presets, palettes, recent colours, stroke stabilisation, palm rejection, pen barrel/eraser-end actions
- **Canvas** — infinite canvas or paper mode (A4, Letter, 16:9, 4:3, square; ruled, grid, dot, blank), zoom 0.1×–10×, pinch, wheel, overscroll
- **Editing** — whole/partial eraser, lasso select, move, scale, arrange, duplicate, undo/redo (100 entries / 50 MiB), keyboard shortcuts
- **Organisation** — shelves → books → sections → nestable pages; favourites; recent; trash with retention; thumbnails
- **Workspace** — sidebar (tree or split layout, left- or right-handed), tabs, split view, page settings
- **Export / import** — PNG, SVG, and `.mate` archives (a whole book, round-trippable)
- **Never lose ink** — strokes are written to SQLite 150 ms after you lift the pen; closing the window waits for pending writes and writes a recovery file if it can't; a restart-recovery card reopens the page you were on
- **Themes** — light, dark, sepia, high-contrast

## AI tutor (optional)

The AI tutor reads your handwritten maths, checks it and points out mistakes. It is **off by default** and needs a key from your own AI provider.

- **What it does:** underlines mistakes (and optionally ticks correct work) in each checked group of ink (ink is never changed), offers a hint, then an explanation and next steps on request, and answers questions about a line. It also summarises a page, suggests a title, finds related pages and can generate practice questions from a book.
- **Nothing is sent until you turn it on.** Mate makes no AI call until you tick the permission under Settings → Intelligence *and* save a key. Turning the permission off stops all AI calls straight away.
- **Providers:** Anthropic (default model `claude-opus-5-5`) and OpenAI (default model `gpt-5`; enter any model name you have access to). Choose one under Settings → Intelligence.
- **Keys** are stored in the OS keychain (Windows Credential Manager, macOS Keychain or Linux Secret Service). They are not written to `settings.json`, not logged and never shown again after saving.
- **What is sent:** when a group of ink is checked, a PNG of that group only, plus the recognised text of up to 11 nearby lines. A question about a line sends that line's recognised text, its verdict and your question, and up to 11 nearby recognised lines, without the image. Summaries and titles send recognised page text only. Search, related pages and the graph run on your machine.
- **Turn it off:** untick the permission, switch the Tutor off under Settings → Tutor, or remove the key under Settings → Intelligence.

Details are in the wiki: [AI tutor](https://github.com/inalto/Mate/wiki/AI-Tutor).

## Import

Open **Import notes…** (Library or the top bar), drag a file onto the window, or open a notebook file with Mate. Mate reads these formats, detected from their contents:

- GoodNotes (`.goodnotes`)
- Notability (`.note`, `.nbn`)
- OneNote (`.one` sections and `.onepkg` notebooks)
- Freenotes (`.freenotes`, `.freenotesv2`, `.freebackup`)
- Samsung Notes (`.sdocx`, best effort)

Mate is not affiliated with any of these apps or their makers.

**Imported:** ink (pen, highlighter and pencil strokes, with colour and width), text boxes (plain text), images, and ruled, grid and dot backgrounds. Each source page becomes one Mate page, scaled to Mate's sheet width.

**Not imported:** tables, most shapes (Freenotes' basic shapes are kept as outlines), rich text styling (bold, italic, per-run colours), PDF or image page templates, Samsung Notes typed text, and image rotation.

**Limits:** 2 000 pages and 5 000 elements per page per import; 50 000 points per stroke; file size up to 100 MiB (GoodNotes, Notability, Samsung Notes), 256 MiB (OneNote) or 200 MB (Freenotes); 60 seconds per file. Files over a limit are refused or cut short, and the report says what was left out.

**Re-importing** the same file adds only pages that are not already in the book; pages imported before are counted as already imported.

The full guide, with per-format detail and known gaps, is in the wiki: [Importing](https://github.com/inalto/Mate/wiki/Importing).

**Smoke test (developers):** `cargo run -p mate-core --example import_smoke -- <file> [more files]` parses each file into a temporary store and prints its import report as JSON with timings. Keep real sample files in `docs/import-samples/`, which is gitignored.

**Licence note:** OneNote import uses [`onenote_parser`](https://crates.io/crates/onenote_parser) 2.1, licensed under MPL-2.0. It is used unmodified; the MPL applies to that crate's own files.

## Quick start

Prerequisites: Node.js 24, Rust stable, and per OS —

| Platform | Needs |
|---|---|
| Windows | Visual Studio 2022 Build Tools (Desktop development with C++), WebView2 runtime (preinstalled on Windows 11) |
| macOS | Xcode Command Line Tools (`xcode-select --install`) |
| Linux | `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev` |

```bash
npm install
npm run tauri dev      # desktop app with hot reload
npm run tauri build    # release build; installers under target/release/bundle/
```

## Tests and checks

```bash
npm test                                               # frontend (vitest)
npm run typecheck
npm run build
cargo test --workspace                                 # Rust
cargo clippy --workspace --all-targets -- -D warnings
```

CI (`.github/workflows/build.yml`) runs all of the above and builds installers on Windows, macOS and Ubuntu for every push and pull request.

## Repository layout

```
crates/mate-core/       pure Rust: model, geometry, settings, SQLite storage, .mate archive
src-tauri/              Tauri shell: commands, app state, safe-close gate, config, icons
src/                    React + TypeScript frontend
  canvas/  ink/  tools/ camera & input · stroke geometry & rendering · eraser, lasso, history
  stores/  ipc/  export/ zustand stores · typed invoke wrappers + write-behind queue · PNG/SVG
.github/workflows/      CI build matrix
```

## Documentation

The [project wiki](https://github.com/inalto/Mate/wiki) covers the [architecture](https://github.com/inalto/Mate/wiki/Architecture), [data model](https://github.com/inalto/Mate/wiki/Data-Model), [ink engine](https://github.com/inalto/Mate/wiki/Ink-Engine), [building and testing](https://github.com/inalto/Mate/wiki/Building-and-Testing), the [roadmap](https://github.com/inalto/Mate/wiki/Roadmap) and [contributing](https://github.com/inalto/Mate/wiki/Contributing).

## Acknowledgements

The ink geometry builds on the open-source [perfect-freehand](https://github.com/steveruizok/perfect-freehand) library.
