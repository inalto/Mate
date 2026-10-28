# Mate logo

- `mate-logo.af` is the master (Affinity source). `mate-logo.svg` is its export.
- `mate-logo-square.svg` is the same artwork centred in a 620x620 square, transparent background.
- `mate-logo-square-bg.svg` adds a white rounded tile (rx 110), used for OS icons.
- `public/logo.svg` is a copy of `mate-logo.svg` used by the app UI.

- `mate-logo-android-foreground.svg` is the square artwork scaled to 60% and centred (transparent), so the adaptive icon keeps it inside the 66% safe zone.

Regenerate the app icons (writes into `src-tauri/icons`) from the repo root:

    npm run tauri icon -- logo/mate-logo-square-bg.svg

Then replace only the adaptive-icon foregrounds from the safe-zone artwork: generate into a temp dir with

    npm run tauri icon -- logo/mate-logo-android-foreground.svg -o <temp dir>

and copy `<temp dir>/android/mipmap-*/ic_launcher_foreground.png` over the same files in `src-tauri/icons/android/` (the legacy `ic_launcher.png` and `ic_launcher_round.png` stay from the first set, they are not masked). Finally copy the Android icons into the generated project (replacing the Tauri template icon):

    npm run icons:android
