// Graph expressions (pure): LaTeX parsed by the Compute Engine, classified as a function of x
// (`y = f(x)` or a bare `f(x)`), of y (`x = f(y)`), polar (`r = f(\theta)`) or parametric
// (`(x(t), y(t))` or `x = …, y = …`), and compiled to fast real evaluators (non-real values are
// NaN). `parseExpression` never throws: problems come back as `{ error }` strings for the editor.
import { compile, ComputeEngine, isFunction, isSymbol } from "@cortex-js/compute-engine";

export type Evaluator = (v: number) => number;

export type ParsedExpr =
  | { kind: "of-x"; f: Evaluator }
  | { kind: "of-y"; f: Evaluator }
  | { kind: "polar"; r: Evaluator }
  | { kind: "parametric"; x: Evaluator; y: Evaluator };

export type ParseResult = ParsedExpr | { error: string };

type Expr = NonNullable<ReturnType<ComputeEngine["parse"]>>;

let engine: ComputeEngine | null = null;
const ce = (): ComputeEngine => (engine ??= new ComputeEngine());

const THETA = "theta";

class ExprError extends Error {}

/** The first parse error of `json` (MathJSON) as a readable message, or null. */
function firstError(json: unknown): string | null {
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

const symbolOf = (e: Expr): string | null => (isSymbol(e) ? e.symbol : null);
const opsOf = (e: Expr): readonly Expr[] => (isFunction(e) ? e.ops : []);

/** Evaluator of `e` in `variable`; throws ExprError on unknown symbols. */
function evaluator(e: Expr, variable: string): Evaluator {
  const unknowns = e.unknowns.filter((s) => s !== variable);
  if (unknowns.length > 0) {
    const shown = unknowns.map((s) => (s === THETA ? "θ" : s)).join(", ");
    throw new ExprError(`Unknown symbol${unknowns.length > 1 ? "s" : ""}: ${shown}`);
  }
  try {
    const compiled = compile(e, { mode: "strict" });
    if (compiled.success && typeof compiled.run === "function") {
      const run = compiled.run as (vars: Record<string, number>) => unknown;
      const vars: Record<string, number> = {};
      return (v) => {
        vars[variable] = v;
        try {
          const r = run(vars);
          return typeof r === "number" ? r : NaN;
        } catch {
          return NaN;
        }
      };
    }
  } catch {
    // Fall back to numeric evaluation below.
  }
  return (v) => {
    try {
      const r = e.subs({ [variable]: ce().number(v) }).N();
      const re = r.re;
      return typeof re === "number" && (r.im === 0 || r.im === undefined) ? re : NaN;
    } catch {
      return NaN;
    }
  };
}

const onlyUses = (e: Expr, allowed: string[]): boolean => e.unknowns.every((s) => allowed.includes(s));

function classifyEquation(lhs: Expr, rhs: Expr): ParsedExpr {
  let name = symbolOf(lhs);
  let body = rhs;
  if (name === null || !["x", "y", "r"].includes(name)) {
    const other = symbolOf(rhs);
    if (other !== null && ["x", "y", "r"].includes(other)) {
      name = other;
      body = lhs;
    }
  }
  if (name === "y" && onlyUses(body, ["x"])) return { kind: "of-x", f: evaluator(body, "x") };
  if (name === "x" && onlyUses(body, ["y"])) return { kind: "of-y", f: evaluator(body, "y") };
  if (name === "r" && onlyUses(body, [THETA])) return { kind: "polar", r: evaluator(body, THETA) };
  if (name === "y" || name === "x" || name === "r") {
    if (body.unknowns.includes(name)) throw new ExprError("Implicit equations are not supported");
    const want = name === "y" ? "x" : name === "x" ? "y" : "θ";
    return { kind: "of-x", f: evaluator(body, want === "θ" ? THETA : want) }; // reports the unknown symbols
  }
  throw new ExprError("Write y = …, x = … or r = …");
}

function classifyTuple(ops: readonly Expr[]): ParsedExpr {
  if (ops.length !== 2) throw new ExprError("A parametric curve needs two parts: (x(t), y(t))");
  const [a, b] = ops;
  if (a.operator === "Equal" && b.operator === "Equal") {
    const pairs = [a, b].map((eq) => ({ name: symbolOf(opsOf(eq)[0]), body: opsOf(eq)[1] }));
    const xs = pairs.find((p) => p.name === "x");
    const ys = pairs.find((p) => p.name === "y");
    if (!xs || !ys) throw new ExprError("Write x = …, y = … in terms of t");
    return { kind: "parametric", x: evaluator(xs.body, "t"), y: evaluator(ys.body, "t") };
  }
  return { kind: "parametric", x: evaluator(a, "t"), y: evaluator(b, "t") };
}

function classify(e: Expr): ParsedExpr {
  if (e.operator === "Equal") {
    const ops = opsOf(e);
    if (ops.length !== 2) throw new ExprError("Use a single equals sign");
    return classifyEquation(ops[0], ops[1]);
  }
  if (e.operator === "Tuple" || e.operator === "Pair" || e.operator === "Delimiter" || e.operator === "Sequence") {
    const ops = opsOf(e);
    if (ops.length === 1) return classify(ops[0]);
    return classifyTuple(ops);
  }
  if (onlyUses(e, ["x"])) return { kind: "of-x", f: evaluator(e, "x") };
  if (onlyUses(e, [THETA])) return { kind: "polar", r: evaluator(e, THETA) };
  if (onlyUses(e, ["t"])) throw new ExprError("Write a parametric curve as (x(t), y(t))");
  return { kind: "of-x", f: evaluator(e, "x") }; // reports the unknown symbols
}

function parseUncached(latex: string): ParseResult {
  if (latex.trim() === "") return { error: "Empty expression" };
  try {
    const e = ce().parse(latex);
    if (!e) return { error: "Empty expression" };
    const err = firstError(e.json);
    if (err) return { error: err };
    if (!e.isValid) return { error: "Invalid expression" };
    if (isSymbol(e, "Nothing")) return { error: "Empty expression" };
    return classify(e);
  } catch (err) {
    return { error: err instanceof ExprError ? err.message : "Could not read this expression" };
  }
}

const CACHE_SIZE = 256;
const cache = new Map<string, ParseResult>();

/** `latex` parsed and classified (cached by source). Never throws. */
export function parseExpression(latex: string): ParseResult {
  const hit = cache.get(latex);
  if (hit) return hit;
  const r = parseUncached(latex);
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  cache.set(latex, r);
  return r;
}

/** The error message of `latex`, or null when it parses (blank input is not an error). */
export function expressionError(latex: string): string | null {
  if (latex.trim() === "") return null;
  const r = parseExpression(latex);
  return "error" in r ? r.error : null;
}
