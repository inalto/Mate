// Copy the Pyodide core runtime and standard library (no packages) from node_modules/pyodide into
// public/pyodide/, served by Vite in dev and bundled into dist/ on build; the Python worker
// (src/code/pyWorker.ts) loads it from /pyodide/ on the first Python run. Run by the predev /
// prebuild npm scripts; the copy is git-ignored and always matches the installed version.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pyodide");
const dest = join(root, "public", "pyodide");
// Pyodide only runs in module workers: the ESM loader and its ESM Emscripten glue.
const FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];

if (!existsSync(src)) {
  console.error("copy-pyodide-assets: node_modules/pyodide not found (run npm install)");
  process.exit(1);
}
const missing = FILES.filter((f) => !existsSync(join(src, f)));
if (missing.length > 0) {
  console.error(`copy-pyodide-assets: missing from node_modules/pyodide: ${missing.join(", ")}`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const f of FILES) copyFileSync(join(src, f), join(dest, f));
console.log(`copy-pyodide-assets: copied ${FILES.join(", ")} to public/pyodide/`);
