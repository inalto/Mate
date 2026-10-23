// Writes the TS settings defaults to crates/mate-core/tests/fixtures/settings-defaults.json.
// A Rust test (`settings_defaults_match_between_rust_and_ts`) asserts they equal Settings::default().
// Run via `npm run dump:settings-defaults`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { DEFAULT_SETTINGS } = await import(pathToFileURL(resolve(root, "src/model/constants.ts")).href);
const out = resolve(root, "crates/mate-core/tests/fixtures/settings-defaults.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
console.log("wrote", out);
