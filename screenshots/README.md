# Screenshots

The README and the wiki Home page show the images listed below. Capture them from the app on Windows at 1280×800 (the default window size), light theme, English unless noted, and save them here as PNG with these exact names. Run the app against an empty profile so no personal notes appear:

```
set MATE_DATA_DIR=%TEMP%\mate-shots
npm run tauri dev
```

| File | What to show |
|---|---|
| `welcome.png` | The first welcome step (logo, "Welcome to Mate"). |
| `library.png` | The Library with two or three books on a shelf. |
| `editor-ink.png` | A page with a few lines of handwritten maths and the toolbar. |
| `tutor-card.png` | A tutor card open on a checked line (hint shown, "Check locally" visible). |
| `ai-providers.png` | Settings → Intelligence with the provider cards and the "What Mate needs from an AI" table open. |
| `share-dialog.png` | The Share dialog for a book with at least one synced folder detected. |
| `compute-menu.png` | A typed equation selected with the Compute menu open. |
| `italian.png` | Settings → General in Italian (Language set to Italiano). |

After saving them, the README's screenshot block (between `<!-- screenshots:start -->` and `<!-- screenshots:end -->`) already references these paths; copy the same images into the wiki checkout's `images/` folder for the Home page.

## Captures still to take

These are not referenced by the README yet. Take them on a build of v1.0.0 and add them next to the others:

- `dock-positions.png`: the editor with the toolbar docked at the top, and again at the left (one image each, or a side-by-side montage).
- `media-player.png`: a page with an audio player and a video player.
- `dictate-button.png`: the toolbar with the Dictate button recording (elapsed time visible).
