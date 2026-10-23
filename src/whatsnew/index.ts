// Release notes bundled with the app: `src/whatsnew/<version>.md`, imported as raw text.
const files = import.meta.glob("./*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** The notes for `version`, or null when there are none. */
export function whatsNewFor(version: string): string | null {
  return files[`./${version}.md`] ?? null;
}
