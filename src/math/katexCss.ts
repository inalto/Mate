// katex.min.css as text for the foreignObject `<style>` of bitmap/export rendering.
//
// Fonts: in-app rendering (the DOM editor, the overlay) uses the GLOBAL katex.min.css imported in
// main.tsx, whose fonts are ordinary file URLs. Canvas bitmaps, PNG/thumbnails and standalone SVG
// exports render the box as an SVG image, which cannot load external resources, so the inlined CSS
// embeds the woff2 files as data URIs instead (woff/ttf fallbacks dropped).
import raw from "katex/dist/katex.min.css?raw";

const FONT_DATA = import.meta.glob<string>("/node_modules/katex/dist/fonts/*.woff2", { query: "?inline", import: "default", eager: true });

let embedded: string | null = null;

/** katex.css with every font as a `data:font/woff2;base64,...` URI (built once, on first use). */
export function getEmbeddedKatexCss(): string {
  if (embedded !== null) return embedded;
  const byName = new Map(Object.entries(FONT_DATA).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url]));
  embedded = raw
    .replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\)\s*format\("[^"]+"\)/g, "")
    .replace(/url\(fonts\/([^)]+\.woff2)\)/g, (m, name: string) => {
      const url = byName.get(name);
      return url ? `url(${url})` : m;
    });
  return embedded;
}
