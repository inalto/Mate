// Symbolic derivative of a function of x for display (pure once the engine is loaded): the body of
// `y = …`, `f(x) = …` or a bare expression, differentiated by the Compute Engine (`D`), simplified
// and written back as KaTeX-safe LaTeX. On its own engine instance, like the CAS (../math/cas), so
// nothing declared here leaks into the plotter's parsing. Null when the engine is not loaded yet or
// the result is not a closed formula (an unevaluated derivative). Cached by source; never throws.
import type { ComputeEngine } from "@cortex-js/compute-engine";
import { normalizeLatex } from "../math/normalizeLatex";
import { engineSync } from "./engine";
import { toLatex } from "./plain";

type Expr = NonNullable<ReturnType<ComputeEngine["parse"]>>;

let own: ComputeEngine | null = null;
const cache = new Map<string, string | null>();
const CACHE_SIZE = 64;

/** Compute Engine LaTeX that KaTeX does not know, rewritten. */
const katexSafe = (latex: string): string =>
  latex
    .replace(/\\exponentialE\b/g, "\\mathrm{e}")
    .replace(/\\imaginaryI\b/g, "\\mathrm{i}")
    .replace(/\\differentialD\b/g, "\\mathrm{d}");

const mentions = (json: unknown, heads: Set<string>): boolean => Array.isArray(json) && ((typeof json[0] === "string" && heads.has(json[0])) || json.some((j) => mentions(j, heads)));
const UNEVALUATED = new Set(["D", "Derivative", "ND", "Error"]);

/** The `order`-th derivative of the function of x written in `source` (editor text), as LaTeX; or null. */
export function derivativeLatex(source: string, order: 1 | 2): string | null {
  const key = `${order}|${source}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const eng = engineSync();
  if (!eng) return null;
  let out: string | null = null;
  try {
    own ??= new eng.mod.ComputeEngine();
    const ce = own;
    const e = ce.parse(normalizeLatex(toLatex(source)));
    let body: Expr | null = e;
    if (e.operator === "Equal" && eng.mod.isFunction(e)) {
      const [lhs, rhs] = e.ops;
      const named = (x: Expr) => (eng.mod.isSymbol(x) && x.symbol === "y") || (eng.mod.isFunction(x) && /^[a-z]$/.test(x.operator) && x.ops.length === 1);
      body = named(lhs) ? rhs : named(rhs) ? lhs : null;
    }
    if (body && body.isValid && body.unknowns.every((s) => s === "x")) {
      let d: Expr = body;
      for (let i = 0; i < order; i++) d = ce.box(["D", d, "x"]).evaluate().simplify();
      if (!mentions(d.json, UNEVALUATED)) out = katexSafe(d.latex);
    }
  } catch {
    out = null;
  }
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}
