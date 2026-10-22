// katex.min.css as text, for the foreignObject `<style>` of canvas/export rendering. Its font URLs
// point at the copies shipped in public/katex-fonts (woff2 only; the woff/ttf fallbacks are dropped).
import raw from "katex/dist/katex.min.css?raw";

export const KATEX_FONT_DIR = "/katex-fonts/";

export const KATEX_CSS: string = raw
  .replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\)\s*format\("[^"]+"\)/g, "")
  .replace(/url\(fonts\//g, `url(${KATEX_FONT_DIR}`);
