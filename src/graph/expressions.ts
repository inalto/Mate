// Graph expressions (pure): LaTeX parsed by the Compute Engine, classified as a function of x
// (`y = f(x)` or a bare `f(x)`), of y (`x = f(y)`), polar (`r = f(\theta)`) or parametric
// (`(x(t), y(t))` or `x = …, y = …`), and compiled to fast real evaluators (non-real values are
// NaN). Only compiled code is plotted (an expression that does not compile is an error), and
// expressions too costly to evaluate (unbounded or long sums, products, integrals, limits, or
// nested ones) are refused. Never throws: problems come back as `{ error }` strings for the editor.
// The engine is lazy (./engine): `parseExpressionSync` answers `{ pending: true }` until it loaded.
import type { ComputeEngine } from "@cortex-js/compute-engine";
import { engineSync, loadEngine, type Engine } from "./engine";

export type Evaluator = (v: number) => number;

export type ParsedExpr =
  | { kind: "of-x"; f: Evaluator }
  | { kind: "of-y"; f: Evaluator }
  | { kind: "polar"; r: Evaluator }
  | { kind: "parametric"; x: Evaluator; y: Evaluator };

export type ParseResult = ParsedExpr | { error: string };
export type Pending = { pending: true };

type Expr = NonNullable<ReturnType<ComputeEngine["parse"]>>;

const THETA = "theta";
export const TOO_EXPENSIVE = "Expression too expensive to plot";
/** Compiling threw an EvalError: the webview's CSP lacks 'unsafe-eval' (see src-tauri/tauri.conf.json). */
export const EVAL_BLOCKED = "Plotting is blocked by the app's security policy";
/** Most iterations a plotted sum or product may run per evaluation. */
export const MAX_ITERATIONS = 1000;

class ExprError extends Error {}

/** The first parse error of `json` (MathJSON) as a readable message, or null. */
export function firstError(json: unknown): string | null {
  if (!Array.isArray(json)) return null;
  if (json[0] === "Error") {
    const code = Array.isArray(json[1]) ? json[1][1] : json[1];
    const raw = typeof code === "string" ? code.replace(/^'|'$/g, "") : "invalid";
    const messages: Record<string, string> = {
      missing: "Something is missing",
      "expected-closing-delimiter": "Missing closing bracket",
      "expected-open-delimiter": "Missing opening bracket",
      "unexpected-closing-delimiter": "Unexpected closing bracket",
      "incompatible-type": "Incompatible types",
      "unexpected-command": "Unknown command",
      "unexpected-token": "Unexpected symbol",
    };
    return messages[raw] ?? raw.replace(/-/g, " ");
  }
  for (const part of json) {
    const e = firstError(part);
    if (e) return e;
  }
  return null;
}

const ITERATED = new Set(["Sum", "Product"]);
const COSTLY = new Set(["Sum", "Product", "Integrate", "Limit"]);
const INFINITIES = new Set(["PositiveInfinity", "NegativeInfinity", "ComplexInfinity", "Infinity"]);

const mentionsInfinity = (json: unknown): boolean =>
  typeof json === "string" ? INFINITIES.has(json) : Array.isArray(json) && json.some(mentionsInfinity);

/**
 * True when `json` (MathJSON) is too costly to evaluate a few thousand times: a Sum/Product whose
 * bounds are not plain numbers or span more than MAX_ITERATIONS, an Integrate/Limit at infinity,
 * or any of these nested in another.
 */
export function tooExpensive(json: unknown, inside = false): boolean {
  if (!Array.isArray(json)) return false;
  const head = json[0];
  if (typeof head === "string" && COSTLY.has(head)) {
    if (inside) return true;
    const [, body, ...rest] = json;
    if (ITERATED.has(head)) {
      if (rest.length === 0) return true; // no bounds: an unbounded or collection sum
      for (const lim of rest) {
        if (!Array.isArray(lim)) return true;
        const [lo, hi] = lim.slice(2);
        if (typeof lo !== "number" || typeof hi !== "number" || !Number.isFinite(lo) || !Number.isFinite(hi)) return true;
        if (Math.abs(hi - lo) + 1 > MAX_ITERATIONS) return true;
      }
    } else if (rest.some(mentionsInfinity)) {
      return true;
    }
    return tooExpensive(body, true) || rest.some((r) => tooExpensive(r, true));
  }
  return json.some((part) => tooExpensive(part, inside));
}

/** Evaluator of `e` in `variable` (compiled code only); throws ExprError when it cannot be plotted. */
function evaluator(eng: Engine, e: Expr, variable: string): Evaluator {
  const unknowns = e.unknowns.filter((s) => s !== variable);
  if (unknowns.length > 0) {
    const shown = unknowns.map((s) => (s === THETA ? "θ" : s)).join(", ");
    throw new ExprError(`Unknown symbol${unknowns.length > 1 ? "s" : ""}: ${shown}`);
  }
  let run: ((vars: Record<string, number>) => unknown) | null = null;
  try {
    // `fallback: false`: no interpreted fallback (slow, and it logs); a decline throws instead.
    const compiled = eng.mod.compile(e, { mode: "strict", fallback: false });
    if (compiled.success && typeof compiled.run === "function") run = compiled.run as (vars: Record<string, number>) => unknown;
  } catch (err) {
    // Compiled code is built with `new Function`: a CSP without 'unsafe-eval' refuses it.
    if (err instanceof EvalError) throw new ExprError(EVAL_BLOCKED);
    run = null;
  }
  if (!run) throw new ExprError("This expression cannot be plotted");
  const fn = run;
  const vars: Record<string, number> = {};
  return (v) => {
    vars[variable] = v;
    try {
      const r = fn(vars);
      return typeof r === "number" ? r : NaN;
    } catch {
      return NaN;
    }
  };
}

function classify(eng: Engine, e: Expr): ParsedExpr {
  const { isFunction, isSymbol } = eng.mod;
  const symbolOf = (x: Expr): string | null => (isSymbol(x) ? x.symbol : null);
  const opsOf = (x: Expr): readonly Expr[] => (isFunction(x) ? x.ops : []);
  const onlyUses = (x: Expr, allowed: string[]): boolean => x.unknowns.every((s) => allowed.includes(s));
  const ev = (x: Expr, v: string) => evaluator(eng, x, v);

  const equation = (lhs: Expr, rhs: Expr): ParsedExpr => {
    let name = symbolOf(lhs);
    let body = rhs;
    if (name === null || !["x", "y", "r"].includes(name)) {
      const other = symbolOf(rhs);
      if (other !== null && ["x", "y", "r"].includes(other)) {
        name = other;
        body = lhs;
      }
    }
    if (name === "y" && onlyUses(body, ["x"])) return { kind: "of-x", f: ev(body, "x") };
    if (name === "x" && onlyUses(body, ["y"])) return { kind: "of-y", f: ev(body, "y") };
    if (name === "r" && onlyUses(body, [THETA])) return { kind: "polar", r: ev(body, THETA) };
    if (name === "y" || name === "x" || name === "r") {
      if (body.unknowns.includes(name)) throw new ExprError("Implicit equations are not supported");
      return { kind: "of-x", f: ev(body, name === "y" ? "x" : name === "x" ? "y" : THETA) }; // reports the unknown symbols
    }
    throw new ExprError("Write y = …, x = … or r = …");
  };

  const tuple = (ops: readonly Expr[]): ParsedExpr => {
    if (ops.length !== 2) throw new ExprError("A parametric curve needs two parts: (x(t), y(t))");
    const [a, b] = ops;
    if (a.operator === "Equal" && b.operator === "Equal") {
      const pairs = [a, b].map((eq) => ({ name: symbolOf(opsOf(eq)[0]), body: opsOf(eq)[1] }));
      const xs = pairs.find((p) => p.name === "x");
      const ys = pairs.find((p) => p.name === "y");
      if (!xs || !ys) throw new ExprError("Write x = …, y = … in terms of t");
      return { kind: "parametric", x: ev(xs.body, "t"), y: ev(ys.body, "t") };
    }
    return { kind: "parametric", x: ev(a, "t"), y: ev(b, "t") };
  };

  const go = (x: Expr): ParsedExpr => {
    if (x.operator === "Equal") {
      const ops = opsOf(x);
      if (ops.length !== 2) throw new ExprError("Use a single equals sign");
      return equation(ops[0], ops[1]);
    }
    if (x.operator === "Tuple" || x.operator === "Pair" || x.operator === "Delimiter" || x.operator === "Sequence") {
      const ops = opsOf(x);
      return ops.length === 1 ? go(ops[0]) : tuple(ops);
    }
    if (onlyUses(x, ["x"])) return { kind: "of-x", f: ev(x, "x") };
    if (onlyUses(x, [THETA])) return { kind: "polar", r: ev(x, THETA) };
    if (onlyUses(x, ["t"])) throw new ExprError("Write a parametric curve as (x(t), y(t))");
    return { kind: "of-x", f: ev(x, "x") }; // reports the unknown symbols
  };
  return go(e);
}

function parseUncached(eng: Engine, latex: string): ParseResult {
  try {
    const e = eng.ce.parse(latex);
    if (!e) return { error: "Empty expression" };
    const json = e.json;
    const err = firstError(json);
    if (err) return { error: err };
    if (!e.isValid) return { error: "Invalid expression" };
    if (eng.mod.isSymbol(e, "Nothing")) return { error: "Empty expression" };
    if (tooExpensive(json)) return { error: TOO_EXPENSIVE };
    return classify(eng, e);
  } catch (err) {
    return { error: err instanceof ExprError ? err.message : "Could not read this expression" };
  }
}

const CACHE_SIZE = 256;
const cache = new Map<string, ParseResult>();

/**
 * `latex` parsed and classified (cached by source); `{ pending: true }` while the engine has not
 * loaded (the call starts loading it). Never throws.
 */
export function parseExpressionSync(latex: string): ParseResult | Pending {
  if (latex.trim() === "") return { error: "Empty expression" };
  const hit = cache.get(latex);
  if (hit) return hit;
  const eng = engineSync();
  if (!eng) {
    void loadEngine().catch(() => {});
    return { pending: true };
  }
  const r = parseUncached(eng, latex);
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  cache.set(latex, r);
  return r;
}

/** `latex` parsed and classified once the engine has loaded. Never rejects. */
export async function parseExpression(latex: string): Promise<ParseResult> {
  try {
    await loadEngine();
  } catch {
    return { error: "The math engine could not be loaded" };
  }
  const r = parseExpressionSync(latex);
  return "pending" in r ? { error: "The math engine could not be loaded" } : r;
}

/** The error message of `latex`, or null when it parses, is blank or the engine is still loading. */
export function expressionError(latex: string): string | null {
  if (latex.trim() === "") return null;
  const r = parseExpressionSync(latex);
  return "error" in r ? r.error : null;
}
