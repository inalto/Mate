// Guard: user-visible English must come from the catalogue. Scans every component file for JSX
// text of two or more words starting with a capital letter, and for such text in the attributes
// people read (title, aria-label, placeholder, alt, and the label/hint props of settings rows).
import ts from "typescript";
import { describe, expect, it } from "vitest";
import allowlist from "../allowlist.txt?raw";

/** Component sources, keyed "/src/components/Shell.tsx". */
const sources = import.meta.glob(["/src/**/*.tsx", "!/src/**/__tests__/**", "!/src/whatsnew/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const ATTRS = new Set(["title", "aria-label", "placeholder", "alt", "label", "hint"]);
/** Two or more words, the first capitalised: "Open book", "Not now". */
const SENTENCE = /^[A-Z][\p{L}'’]*[\s ]+\S/u;

/** Exact `path:line-text` entries (as a failure prints them) that may stay literal. */
const allowed = new Set(
  allowlist
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#")),
);

function findings([path, text]: [string, string]): string[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rel = path.replace(/^\/src\//, "");
  const out: string[] = [];
  const report = (node: ts.Node, value: string) => {
    const s = value.replace(/\s+/g, " ").trim();
    if (!SENTENCE.test(s)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const entry = `${rel}:${line}-${s}`;
    if (!allowed.has(entry)) out.push(entry);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) report(node, node.text);
    else if (ts.isJsxAttribute(node) && ATTRS.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) report(init, init.text);
      else if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)) {
        report(init, init.expression.text);
      }
    } else if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteralLike(node.expression)) {
      if (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) report(node, node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("no hard-coded interface text", () => {
  it("scans the components", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });

  it("every sentence in a component comes from the catalogue", () => {
    const hits = Object.entries(sources).flatMap(findings);
    expect(hits, "translate these with t(…), or (rarely) add the exact line to src/i18n/allowlist.txt").toEqual([]);
  });

  it("keeps the allow-list small", () => {
    expect(allowed.size).toBeLessThan(10);
  });
});
