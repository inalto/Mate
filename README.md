# Mate

**A local-first handwriting & math notes app for Windows, macOS and Linux.**

Write with a pen on an endless canvas or on paged sheets, organise pages into books, sections and shelves, and keep everything on your own machine in a single SQLite file. No account, no cloud, no subscription.

Mate is built with [Tauri 2](https://tauri.app) (Rust shell + a pure-Rust core crate) and a React 19 / TypeScript frontend. The ink pipeline is tuned for low-latency pen input: pressure, tilt, palm rejection, stroke stabilisation and a snapshot-cached Canvas2D renderer.

> Status: **Phase 5 complete (v0.5.0)** — the foundation, ink editor, rich content (v0.2.0), an optional bring-your-own-key AI tutor (off by default), importers for GoodNotes, Notability, OneNote, Freenotes and Samsung Notes, and the polish release: a full settings pane, rebindable shortcuts, multi-window pages, a welcome flow, an in-app updater and Windows pen haptics. See the [roadmap](https://github.com/inalto/Mate/wiki/Roadmap) and the [release notes](src/whatsnew/0.5.0.md).

## Features

- **Ink** — pen, highlighter and fountain pen (pressure, tilt, nib flatness), toolbar presets, palettes, recent colours, stroke stabilisation, palm rejection, pen barrel/eraser-end actions
- **Canvas** — infinite canvas or paper mode (A4, Letter, 16:9, 4:3, square; ruled, grid, dot, blank), zoom 0.1×–10×, pinch, wheel, overscroll
- **Editing** — whole/partial eraser, lasso select, move, scale, arrange, duplicate, undo/redo (100 entries / 50 MiB), keyboard shortcuts
- **Organisation** — shelves → books → sections → nestable pages; favourites; recent; trash with retention; thumbnails
- **Workspace** — sidebar (tree or split layout, left- or right-handed), tabs, split view, page settings
- **Export / import** — PNG, SVG, and `.mate` archives (a whole book, round-trippable)
- **Never lose ink** — strokes are written to SQLite 150 ms after you lift the pen; closing the window waits for pending writes and writes a recovery file if it can't; a restart-recovery card reopens the page you were on
- **Themes** — light, dark, sepia, high-contrast

## Settings

Open **Settings** from the More menu in the top bar. The pane has a list of sections on the left (General, Appearance, Writing, Intelligence, System) and a search box that jumps to a setting and briefly highlights it. Every setting has a default; the full list of keys and defaults is in the wiki: [Settings](https://github.com/inalto/Mate/wiki/Settings).

- **Appearance:** theme, invert images in dark mode, paper and layout defaults (page mode, background, page size, orientation, snap to grid).
- **Writing:** pen, highlighter, text, shape and eraser defaults; ink to shape and scribble to erase; pen barrel and eraser-end buttons; palm rejection, drawing with a finger, pinch and wheel behaviour; Pen haptics (Windows only; not yet verified on haptic pen hardware).
- **Intelligence:** the AI provider, key and tutor options (see below).
- **System:** keyboard shortcuts, trash retention, **Download backup** (one zip holding a `.mate` archive per book; to restore, unzip it and import each `.mate` file) and **Reset local data**, which writes a recovery zip first and then restarts. API keys in the system keychain are kept. Updates and About (version, Show welcome again) are here too.

## Keyboard shortcuts

Press **?** for the shortcut list, or **Ctrl+K** to search pages and run actions. Change any shortcut under Settings, Keyboard shortcuts: **Change** the keys, **Unbind**, or **Reset**; **Reset all** restores every default. A combination already used by another action is refused with that action's name. Escape, Tab and Enter cannot be bound, nor can any combination with Space (pan is held on Space), nor a bare letter or digit or a Shift-only letter. Preset slots (Alt+1 to 9), pan and clear selection are fixed. Shortcut hints on toolbar buttons follow your keys and can be always on, shown until learned, or off.

The full default table is in the wiki: [Keyboard shortcuts](https://github.com/inalto/Mate/wiki/Shortcuts).

## Windows

- **Open in new window:** from the sidebar page menu, or **Ctrl+Shift+N**. A page opens in a window of its own, without the sidebar and tabs. Opening a page that already has a window brings that window forward.
- A page window closes itself if its page is moved to the trash, and its title follows renames.
- Closing the main window closes every page window first; each one flushes its ink before it goes. If a window cannot save, the close stops and says so.

## Welcome and What's new

On first launch Mate shows a short welcome (AI setup is optional and can be skipped), with a **Playground** page to try the pen. Every step can be skipped. Show the welcome again from Settings, About. After an update, **What's new** shows that version's release notes once; they live in `src/whatsnew/<version>.md`.

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
- Notability (`.note`)
- OneNote (`.one` sections and `.onepkg` notebooks)
- Freenotes (`.freenotes`, `.freenotesv2`, `.freebackup`)
- Samsung Notes (`.sdocx`, best effort)

Mate is not affiliated with any of these apps or their makers.

**Imported:** ink (pen, highlighter and pencil strokes, with colour and width), text boxes (plain text), images, and ruled, grid and dot backgrounds. Each source page becomes one Mate page, scaled to Mate's sheet width.

**Not imported:** tables, most shapes (Freenotes' basic shapes are kept as outlines), rich text styling (bold, italic, per-run colours), PDF or image page templates, Samsung Notes typed text, and image rotation.

**Limits:** 2 000 pages and 5 000 elements per page per import; 20 000 000 ink points and 2 000 000 elements per file; 50 000 points per stroke; file size up to 100 MiB (GoodNotes, Notability, Samsung Notes), 256 MiB (OneNote) or 200 MB (Freenotes); 60 seconds to read a file and 60 more to place its pages. Files over a limit are refused or cut short, and the report says what was left out.

**Re-importing:** only a byte-identical file is skipped, and its pages are counted as already imported. A changed or grown file is imported again in full, alongside the earlier pages.

The full guide, with per-format detail and known gaps, is in the wiki: [Importing](https://github.com/inalto/Mate/wiki/Importing).

**Smoke test (developers):** `cargo run -p mate-core --example import_smoke -- <file> [more files]` parses each file into a temporary store and prints its import report as JSON with timings. Keep real sample files in `docs/import-samples/`, which is gitignored.

**Licence note:** OneNote import uses [`onenote_parser`](https://crates.io/crates/onenote_parser) 2.1 and its companion crate [`onenote_parser-macros`](https://crates.io/crates/onenote_parser-macros), both licensed under MPL-2.0. They are used unmodified; the MPL applies to those crates' own files.

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

## Updates

Mate can check GitHub Releases for a newer build, download it and restart into it (Settings, Updates). Every download is verified against a minisign public key baked into the app, so only builds signed with your private key are ever installed.

### One-time setup

1. Generate a key pair (keep the private key out of the repository):

   ```
   npm run tauri signer generate -- -w ~/.tauri/mate.key
   ```

   This writes `~/.tauri/mate.key` (private) and `~/.tauri/mate.key.pub` (public). Losing the private key or its password means existing installs can never be updated again.
2. Replace the placeholder public key. Paste the contents of `mate.key.pub` into **both** `src-tauri/updater.pub` and `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` (Tauri cannot read the key from a file, so a unit test checks that the two are identical). Commit both.
3. Add GitHub repository secrets (Settings, Secrets and variables, Actions): `TAURI_SIGNING_PRIVATE_KEY` (the contents of `mate.key`) and, if you set one, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Push a tag such as `v0.5.0`. The release workflow builds the installers, signs the updater bundles and uploads `latest.json` (version, notes, per-platform URL and signature) to the release.

The app looks at `https://github.com/inalto/Mate/releases/latest/download/latest.json`, which always points at the newest release.

### Without a key

Until step 2 is done the committed key is a throwaway placeholder whose private half does not exist. Such a build shows "Updates are not configured for this build." and never installs anything. A missing manifest (for example a release built without the signing secret) or an unreachable server is reported as "could not check" and can be retried. CI still builds installers without the secret: the workflow switches `bundle.createUpdaterArtifacts` off, so those builds are unsigned and cannot be updated to or from.

For a local `npm run tauri build` without the private key, pass `--config '{"bundle":{"createUpdaterArtifacts":false}}'`, or set `TAURI_SIGNING_PRIVATE_KEY` in your shell.

### Settings

Settings, Updates has "Check for updates on startup" (on by default; a failed or offline check is silent, only an available update shows a notice), "Check for updates", download progress and "Restart to update".

PowerShell (Windows) equivalents: the key directory is `$HOME\.tauri`, so generate with `npm run tauri signer generate -- -w "$HOME\.tauri\mate.key"`, and copy a key for pasting with `Get-Content "$HOME\.tauri\mate.key.pub" -Raw | Set-Clipboard` (same for `mate.key` when creating the secret). For a local build without the private key, set it for the session with `$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content "$HOME\.tauri\mate.key" -Raw)`, or use `npm run tauri build -- --config '{\"bundle\":{\"createUpdaterArtifacts\":false}}'`.

### What happens on install

Before downloading, Mate saves every window and aborts the update (with a message) if any note could not be saved. On Windows the installer then restarts Mate by itself; on macOS and Linux "Restart to update" appears once the download is installed. The updater does not read system proxy settings (that plugin feature is switched off in this build).

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
