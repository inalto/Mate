import { describe, expect, it } from "vitest";
import en from "../../locales/en/translation.json";

type Tree = { [key: string]: string | boolean | Tree };

const catalogues = import.meta.glob<Tree>("../../locales/*/translation.json", { eager: true, import: "default" });
const byLang = Object.fromEntries(
  Object.entries(catalogues).map(([path, tree]) => [path.split("/").at(-2) ?? path, tree] as const),
);
const others = Object.keys(byLang).filter((l) => l !== "en");

const PLURAL = /_(zero|one|two|few|many|other)$/;

/** Every leaf as `dotted.key → value`; `meta.*` keys describe the file, not the interface. */
function flatten(tree: Tree, prefix = "", out = new Map<string, unknown>()): Map<string, unknown> {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (key === "meta" || key.startsWith("meta.")) continue;
    if (v !== null && typeof v === "object") flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

/** Keys grouped by their plural base: `pages_one`/`pages_other` → `pages` with both suffixes. */
function group(flat: Map<string, unknown>) {
  const out = new Map<string, { suffixes: Set<string>; values: string[] }>();
  for (const [key, value] of flat) {
    const m = PLURAL.exec(key);
    const base = m ? key.slice(0, -m[0].length) : key;
    const g = out.get(base) ?? { suffixes: new Set<string>(), values: [] };
    if (m) g.suffixes.add(m[1]);
    g.values.push(String(value));
    out.set(base, g);
  }
  return out;
}

const placeholders = (values: string[]) =>
  [...new Set(values.flatMap((v) => [...v.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1])))].sort();

const english = group(flatten(en as Tree));

describe("English catalogue", () => {
  it("has only non-empty string values", () => {
    for (const [key, value] of flatten(en as Tree)) {
      expect(typeof value, key).toBe("string");
      expect(String(value).trim(), key).not.toBe("");
    }
  });

  it("uses _one/_other for every plural", () => {
    for (const [base, g] of english) {
      if (g.suffixes.size === 0) continue;
      expect([...g.suffixes].sort(), base).toEqual(["one", "other"]);
    }
  });
});

describe.skipIf(others.length === 0)("translated catalogues", () => {
  it.each(others)("%s has exactly the English keys", (lang) => {
    const theirs = group(flatten(byLang[lang]));
    const missing = [...english.keys()].filter((k) => !theirs.has(k));
    const extra = [...theirs.keys()].filter((k) => !english.has(k));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it.each(others)("%s uses its own plural categories where English has plurals", (lang) => {
    const theirs = group(flatten(byLang[lang]));
    const categories = new Set<string>(new Intl.PluralRules(lang).resolvedOptions().pluralCategories);
    for (const [base, g] of english) {
      const t = theirs.get(base);
      if (!t) continue;
      if (g.suffixes.size === 0) {
        expect(t.suffixes.size, `${lang}: ${base} is not a plural`).toBe(0);
        continue;
      }
      expect(t.suffixes.has("other"), `${lang}: ${base}_other`).toBe(true);
      for (const s of t.suffixes) expect(categories.has(s), `${lang}: ${base}_${s}`).toBe(true);
    }
  });

  it.each(others)("%s keeps every {{placeholder}}", (lang) => {
    const theirs = group(flatten(byLang[lang]));
    for (const [base, g] of english) {
      const t = theirs.get(base);
      if (!t) continue;
      expect(placeholders(t.values), `${lang}: ${base}`).toEqual(placeholders(g.values));
    }
  });
});
