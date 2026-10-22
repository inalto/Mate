# Mate

Mate is a desktop handwriting-notes app built with Tauri 2, React 19 and TypeScript on top of a Rust core. It stores notebooks in a local SQLite database, renders pen input on a canvas, and keeps your notes safe on close: Mate flushes pending writes before the window closes and writes a recovery file if it cannot.

## Prerequisites

- Node.js 24 and npm
- Rust (stable) with the MSVC toolchain on Windows
- Windows: Microsoft C++ Build Tools and the WebView2 runtime (preinstalled on Windows 11)
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev`

## Getting started

```
npm install
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # release build and installers (target/release/bundle/)
```

## Tests and checks

```
npm test                                         # frontend tests (vitest)
npm run typecheck                                # TypeScript
cargo test --workspace                           # Rust tests
cargo clippy --workspace --all-targets -- -D warnings
```

## Repository layout

- `src/` - React frontend (routes, canvas, ink, stores, IPC wrappers)
- `src-tauri/` - Tauri desktop shell and commands
- `crates/mate-core/` - core Rust library (storage, settings, archive)
- `docs/analysis/` - product and architecture analysis
- `docs/superpowers/plans/` - implementation plans
- `.github/workflows/build.yml` - CI: tests and cross-platform bundles
