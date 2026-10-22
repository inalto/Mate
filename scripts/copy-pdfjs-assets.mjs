// Copy the pdf.js resources the viewer loads at runtime (cMaps, standard fonts, wasm decoders) from
// pdfjs-dist into public/pdfjs/, served by Vite in dev and bundled into dist/ on build. Run by the
// predev / prebuild npm scripts; the copy is git-ignored and always matches the installed version.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const dest = join(root, "public", "pdfjs");

if (!existsSync(src)) {
  console.error("copy-pdfjs-assets: node_modules/pdfjs-dist not found (run npm install)");
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
  cpSync(join(src, dir), join(dest, dir), { recursive: true });
}
console.log("copy-pdfjs-assets: copied cmaps, standard_fonts and wasm to public/pdfjs/");
