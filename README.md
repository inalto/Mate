# Mate

Desktop notes app built with Tauri 2, Vite, React and TypeScript, with a Rust workspace.

## Layout

- `src/` - React frontend
- `src-tauri/` - Tauri desktop shell
- `crates/mate-core/` - core Rust library

## Scripts

- `npm run dev` - Vite dev server
- `npm run tauri dev` - run the desktop app
- `npm run build` - typecheck and build the frontend
- `npm run typecheck` - TypeScript check
- `npm test` - frontend tests (vitest)
- `cargo test --workspace` - Rust tests
