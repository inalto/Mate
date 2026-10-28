# Mate logo

- `mate-logo.af` is the master (Affinity source). `mate-logo.svg` is its export.
- `mate-logo-square.svg` is the same artwork centred in a 620x620 square, transparent background.
- `mate-logo-square-bg.svg` adds a white rounded tile (rx 110), used for OS icons.
- `public/logo.svg` is a copy of `mate-logo.svg` used by the app UI.

Regenerate the app icons (writes into `src-tauri/icons`) from the repo root:

    npm run tauri icon -- logo/mate-logo-square-bg.svg

Then copy the Android launcher icons into the generated Android project (replacing the Tauri template icon):

    npm run icons:android
