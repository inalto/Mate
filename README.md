# Mate

**A local-first handwriting & math notes app for Windows, macOS and Linux.**

Write with a pen on an endless canvas or on paged sheets, organise pages into books, sections and shelves, and keep everything on your own machine in a single SQLite file. No account, no cloud, no subscription.

Mate is built with [Tauri 2](https://tauri.app) (Rust shell + a pure-Rust core crate) and a React 19 / TypeScript frontend. The ink pipeline is tuned for low-latency pen input: pressure, tilt, palm rejection, stroke stabilisation and a snapshot-cached Canvas2D renderer.

> Status: **Phase 1 complete** — the foundation and ink editor. Rich content (text, shapes, images, PDF, math, graphs), an optional bring-your-own-key AI tutor, and importers for GoodNotes / Notability / OneNote are planned. See the [roadmap](https://github.com/inalto/Mate/wiki/Roadmap).

## Features

- **Ink** — pen, highlighter and fountain pen (pressure, tilt, nib flatness), toolbar presets, palettes, recent colours, stroke stabilisation, palm rejection, pen barrel/eraser-end actions
- **Canvas** — infinite canvas or paper mode (A4, Letter, 16:9, 4:3, square; ruled, grid, dot, blank), zoom 0.1×–10×, pinch, wheel, overscroll
- **Editing** — whole/partial eraser, lasso select, move, scale, arrange, duplicate, undo/redo (100 entries / 50 MiB), keyboard shortcuts
- **Organisation** — shelves → books → sections → nestable pages; favourites; recent; trash with retention; thumbnails
- **Workspace** — sidebar (tree or split layout, left- or right-handed), tabs, split view, page settings
- **Export / import** — PNG, SVG, and `.mate` archives (a whole book, round-trippable)
- **Never lose ink** — strokes are written to SQLite 150 ms after you lift the pen; closing the window waits for pending writes and writes a recovery file if it can't; a restart-recovery card reopens the page you were on
- **Themes** — light, dark, sepia, high-contrast

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
