// Local computer algebra on the Compute Engine (pure, offline): the five Compute menu operations
// on a LaTeX string, an offline equivalence check of the sides of an equation (or equality chain),
// and a plain ASCII form of LaTeX for remote engines. Never throws: problems come back as
// `{ error }` strings with a short plain message.
//
// The engine chunk is loaded through ../graph/engine, but the CAS works on its own engine
// instance: parsing declares unknown symbols in the engine's scope, and that must not leak into
// the graph plotter's parsing (or the other way round).
import type { ComputeEngine } from "@cortex-js/compute-engine";
import { engineSync, loadEngine, type Engine } from "../graph/engine";
import { firstError } from "../graph/expressions";
import i18n from "../i18n";
import { normalizeLatex } from "./normalizeLatex";

export type Op = "evaluate" | "simplify" | "expand" | "solve" | "numeric";
export type ComputeResult = { latex: string } | { error: string };
export type LocalCheckResult =
  | { kind: "agree" }
  | { kind: "differ"; at: Record<string, number> }
  /** True exactly for these real values (LaTeX `x=2` each). */
  | { kind: "holds"; solutions: string[] }
  /** True for no real value. */
  | { kind: "never" }
  | { kind: "undecided"; reason: string }
  | { kind: "notApplicable" };

type Expr = NonNullable<ReturnType<ComputeEngine["parse"]>>;

/** Significant digits of a numeric value. */
export const NUMERIC_DIGITS = 6;
/** Sample points per pair of sides, drawn in [-SAMPLE_RANGE, SAMPLE_RANGE] for every variable. */
export const SAMPLES = 12;
export const SAMPLE_RANGE = 5;
/** Relative tolerance of a numeric comparison (absolute below 1). */
export const TOLERANCE = 1e-9;
/** Draws allowed to find SAMPLES points where both sides are real numbers. */
const MAX_DRAWS = SAMPLES * 4;
/** Fewest real-valued samples for "agree" to mean something. */
const MIN_SAMPLES = 3;

let cas: Promise<Engine> | null = null;

/** The CAS's own engine (created once, after the shared chunk loaded) and the engine module. */
function engine(): Promise<Engine> {
  cas ??= loadEngine()
    .then(() => {
      const mod = engineSync()?.mod;
      if (!mod) throw new Error("engine missing");
      return { ce: new mod.ComputeEngine(), mod };
    })
    .catch((err: unknown) => {
      cas = null; // allow a retry
      throw err;
    });
  return cas;
}

const unreadable = () => i18n.t("math.errors.unreadable");

/** Compute Engine LaTeX that KaTeX does not know, rewritten. */
function katexSafe(latex: string): string {
  return latex
    .replace(/\\imaginaryI\b/g, "\\mathrm{i}")
    .replace(/\\exponentialE\b/g, "\\mathrm{e}")
    .replace(/\\differentialD\b/g, "\\mathrm{d}")
    .replace(/\\top\b/g, "\\text{true}")
    .replace(/\\bot\b/g, "\\text{false}");
}

/** The parse error of `e` as a readable message, or null when it is valid. */
function parseProblem(e: Expr): string | null {
  if (e.isValid) return null;
  const msg = firstError(e.json);
  return msg ? i18n.t("math.errors.unreadableDetail", { detail: `${msg.charAt(0).toLowerCase()}${msg.slice(1)}` }) : unreadable();
}

/** The sides of an equation or equality chain (`a = b = c`), or null when `e` is not one. */
function sidesOf(eng: Engine, e: Expr): Expr[] | null {
  if (e.operator !== "Equal") return null;
  const out: Expr[] = [];
  const walk = (x: Expr) => {
    if (x.operator === "Equal" && eng.mod.isFunction(x)) x.ops.forEach(walk);
    else out.push(x);
  };
  walk(e);
  return out.length >= 2 ? out : null;
}

const hasError = (json: unknown): boolean =>
  json === "Error" || (Array.isArray(json) && (json[0] === "Error" || json.some(hasError)));

function serialise(e: Expr, op: Op): string {
  return op === "numeric" ? e.toLatex({ digits: { significant: NUMERIC_DIGITS }, digitGroupSeparator: "" }) : e.latex;
}

function apply(ce: ComputeEngine, e: Expr, op: Exclude<Op, "solve">): Expr {
  switch (op) {
    case "evaluate":
      return e.evaluate();
    case "simplify":
      return e.simplify();
    case "expand":
      return ce.box(["Expand", e]).evaluate();
    case "numeric":
      return e.N();
  }
}

function solve(eng: Engine, e: Expr): ComputeResult {
  const sides = sidesOf(eng, e);
  if (sides && sides.length > 2) return { error: i18n.t("math.errors.oneEquation") };
  if (!sides && e.operator && e.operator !== "Equal" && /^(Less|Greater|NotEqual)/.test(e.operator)) {
    return { error: i18n.t("math.errors.inequality") };
  }
  const unknowns = e.unknowns;
  if (unknowns.length === 0) return { error: i18n.t("math.errors.noUnknown") };
  const v = unknowns.length === 1 ? unknowns[0] : unknowns.includes("x") ? "x" : null;
  if (!v) return { error: i18n.t("math.errors.severalUnknowns", { unknowns: unknowns.join(", ") }) };
  const roots = e.solve(v);
  if (roots === null) return { error: i18n.t("math.errors.unsolved") };
  if (!Array.isArray(roots)) return { error: i18n.t("math.errors.unsolved") };
  const list = (roots as ReadonlyArray<unknown>).filter((r): r is Expr => eng.mod.isExpression(r));
  if (list.length !== roots.length) return { error: i18n.t("math.errors.unsolved") };
  if (list.length === 0) return { error: i18n.t("math.errors.noSolution") };
  if (list.some((r) => hasError(r.json))) return { error: i18n.t("math.errors.unsolved") };
  const name = eng.ce.box(v).latex;
  return { latex: katexSafe(list.map((r) => `${name}=${r.latex}`).join(",\\quad ")) };
}

/**
 * Run `op` on `latex`: evaluate, simplify, expand, solve (for the single unknown, or `x` when
 * there are several) or numeric value (6 significant digits). On an equation (or chain) the
 * operation is applied to each side, except solve.
 */
export async function compute(latex: string, op: Op): Promise<ComputeResult> {
  if (latex.trim() === "") return { error: i18n.t("math.errors.empty") };
  let eng: Engine;
  try {
    eng = await engine();
  } catch {
    return { error: i18n.t("math.errors.engine") };
  }
  try {
    const e = eng.ce.parse(normalizeLatex(latex));
    const problem = parseProblem(e);
    if (problem) return { error: problem };
    if (op === "solve") return solve(eng, e);
    const sides = sidesOf(eng, e);
    const parts = (sides ?? [e]).map((s) => apply(eng.ce, s, op));
    if (parts.some((p) => hasError(p.json))) return { error: i18n.t("math.errors.failed") };
    return { latex: katexSafe(parts.map((p) => serialise(p, op)).join("=")) };
  } catch {
    return { error: i18n.t("math.errors.failed") };
  }
}

/** True when `latex` has an equals sign, the cheap test for showing "Check locally". */
export function looksLikeEquation(latex: string): boolean {
  return /(^|[^\\])=/.test(latex) && !/\\(neq|ne|leq|geq|le|ge)(?![a-zA-Z])/.test(latex.replace(/=/g, ""));
}

/** The real value of `e` at `env`, or NaN when it has none (outside the domain, complex, symbolic). */
function realAt(e: Expr, env: Record<string, number>): number {
  try {
    const v = e.subs(env).N();
    // A symbolic result has a NaN real part.
    return v.im === 0 && Number.isFinite(v.re) ? v.re : NaN;
  } catch {
    return NaN;
  }
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));

/** A sample in [-SAMPLE_RANGE, SAMPLE_RANGE] with two decimals (readable in "They differ at …"). */
const draw = (rand: () => number): number => Math.round((rand() * 2 - 1) * SAMPLE_RANGE * 100) / 100;

type PairResult = Exclude<LocalCheckResult, { kind: "notApplicable" }>;

/** The complex value of `e` at `v = root`, or null when it has none. */
function complexAt(e: Expr, v: string, root: Expr): { re: number; im: number } | null {
  try {
    const n = e.subs({ [v]: root }).N();
    return Number.isFinite(n.re) && Number.isFinite(n.im) ? { re: n.re, im: n.im } : null;
  } catch {
    return null;
  }
}

/** Looser tolerance for checking a solution (the engine may round roots it found numerically). */
const ROOT_TOLERANCE = 1e-7;
const nearly = (a: number, b: number): boolean => Math.abs(a - b) <= ROOT_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));

/** LaTeX of a real root: exact when the engine found it exactly, else NUMERIC_DIGITS significant digits. */
function rootLatex(r: Expr, re: number): string {
  if (/\d\.\d|\\,/.test(r.latex)) return String(Number(re.toPrecision(NUMERIC_DIGITS)));
  return r.latex;
}

/**
 * Solve `a = b` for its single unknown `v`. `never` when there is no real solution, `holds` with
 * the real solutions (each checked by substitution), null when the engine cannot tell (no answer,
 * or only answers that do not satisfy the equation).
 */
function solvePair(eng: Engine, a: Expr, b: Expr, v: string): PairResult | null {
  let roots: unknown;
  try {
    roots = eng.ce.box(["Equal", a, b]).solve(v);
  } catch {
    return null;
  }
  if (!Array.isArray(roots)) return null;
  if (roots.length === 0) return { kind: "never" };
  const name = eng.ce.box(v).latex;
  const real: string[] = [];
  let complex = 0;
  for (const r of roots as ReadonlyArray<unknown>) {
    if (!eng.mod.isExpression(r) || r.unknowns.length > 0 || hasError(r.json)) continue;
    const va = complexAt(a, v, r);
    const vb = complexAt(b, v, r);
    if (!va || !vb || !nearly(va.re, vb.re) || !nearly(va.im, vb.im)) continue; // not a solution
    const value = r.N();
    if (!Number.isFinite(value.re) || !Number.isFinite(value.im)) continue;
    if (Math.abs(value.im) > ROOT_TOLERANCE * Math.max(1, Math.abs(value.re))) {
      complex++;
      continue;
    }
    const latex = katexSafe(`${name}=${rootLatex(r, value.re)}`);
    if (!real.includes(latex)) real.push(latex);
  }
  if (real.length > 0) return { kind: "holds", solutions: real };
  return complex > 0 ? { kind: "never" } : null;
}

function checkPair(eng: Engine, a: Expr, b: Expr, rand: () => number): PairResult {
  const ce = eng.ce;
  if (a.isSame(b)) return { kind: "agree" };
  const vars = [...new Set([...a.unknowns, ...b.unknowns])].sort();
  if (vars.length === 0) {
    const eq = a.isEqual(b);
    if (eq === true) return { kind: "agree" };
    if (eq === false) return { kind: "differ", at: {} };
    const va = realAt(a, {});
    const vb = realAt(b, {});
    if (Number.isNaN(va) || Number.isNaN(vb)) return { kind: "undecided", reason: i18n.t("math.check.reasons.noNumeric") };
    return close(va, vb) ? { kind: "agree" } : { kind: "differ", at: {} };
  }
  try {
    if (ce.box(["Subtract", a, b]).simplify().isSame(0)) return { kind: "agree" };
  } catch {
    /* not an identity the engine recognises */
  }
  if (vars.length === 1) {
    const solved = solvePair(eng, a, b, vars[0]);
    if (solved) return solved;
  }
  let valid = 0;
  for (let i = 0; i < MAX_DRAWS && valid < SAMPLES; i++) {
    const env: Record<string, number> = {};
    for (const v of vars) env[v] = draw(rand);
    const va = realAt(a, env);
    const vb = realAt(b, env);
    if (Number.isNaN(va) || Number.isNaN(vb)) continue;
    valid++;
    if (!close(va, vb)) return { kind: "differ", at: env };
  }
  if (valid < MIN_SAMPLES) return { kind: "undecided", reason: i18n.t("math.check.reasons.noReal") };
  return { kind: "agree" };
}

/**
 * Check of the sides of an equation or equality chain (every adjacent pair). A pair the engine
 * simplifies to the same thing agrees; otherwise, with one unknown, it is solved: `holds` for its
 * real solutions, `never` when there is none. When that is not possible (several unknowns, no
 * answer from the engine), 12 random samples in [-5, 5] for every free variable decide (relative
 * tolerance 1e-9). Without unknowns the two sides are compared as numbers. The first pair that is
 * not an identity gives the result. Not an equation → `notApplicable`. `rand` is for tests.
 */
export async function localCheck(latex: string, rand: () => number = Math.random): Promise<LocalCheckResult> {
  if (!looksLikeEquation(latex)) return { kind: "notApplicable" };
  let eng: Engine;
  try {
    eng = await engine();
  } catch {
    return { kind: "undecided", reason: i18n.t("math.check.reasons.engine") };
  }
  try {
    const e = eng.ce.parse(normalizeLatex(latex));
    const problem = parseProblem(e);
    if (problem) return { kind: "undecided", reason: problem.charAt(0).toLowerCase() + problem.slice(1) };
    const sides = sidesOf(eng, e);
    if (!sides) return { kind: "notApplicable" };
    let undecided: PairResult | null = null;
    for (let i = 0; i + 1 < sides.length; i++) {
      const r = checkPair(eng, sides[i], sides[i + 1], rand);
      if (r.kind === "undecided") undecided ??= r;
      else if (r.kind !== "agree") return r;
    }
    return undecided ?? { kind: "agree" };
  } catch {
    return { kind: "undecided", reason: i18n.t("math.check.reasons.failed") };
  }
}

/** The one-line message of a local check. */
export function localCheckMessage(r: LocalCheckResult): string {
  switch (r.kind) {
    case "agree":
      return i18n.t("math.check.agree");
    case "differ": {
      const at = Object.entries(r.at).map(([v, n]) => `${v} = ${n}`);
      return at.length > 0 ? i18n.t("math.check.differAt", { at: at.join(", ") }) : i18n.t("math.check.differ");
    }
    case "holds":
      return i18n.t("math.check.holds", { solutions: orList(r.solutions.map(readableLatex)) });
    case "never":
      return i18n.t("math.check.never");
    case "undecided":
      return i18n.t("math.check.undecided", { reason: r.reason });
    case "notApplicable":
      return i18n.t("math.check.notEquation");
  }
}

/** "a or b or c" in the interface language. */
function orList(items: string[]): string {
  try {
    return new Intl.ListFormat(i18n.language || "en", { type: "disjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}

/** A short solution like `x=-\frac{3}{2}` as readable text (`x = −3/2`). */
export function readableLatex(latex: string): string {
  let s = latex;
  for (let i = 0; i < 4; i++) s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, n: string, d: string) => `${wrap(n)}/${wrap(d)}`);
  for (let i = 0; i < 4; i++) s = s.replace(/\\sqrt\{([^{}]*)\}/g, (_, a: string) => `√${wrap(a)}`);
  s = s
    .replace(/\\mathrm\{([^{}]*)\}/g, "$1")
    .replace(/\\pi\b/g, "π")
    .replace(/\\(cdot|times)\b/g, "·")
    .replace(/\\left|\\right/g, "")
    .replace(/\\,/g, "")
    .replace(/[{}]/g, "")
    .replace(/\\/g, "")
    .replace(/-/g, "−")
    .replace(/\s*=\s*/g, " = ");
  return s.trim();
}

/** Parentheses around a compound fraction part or root argument. */
const wrap = (s: string): string => (/^[\w.√π]+$/.test(s) ? s : `(${s})`);

/** Plain ASCII form of `latex` (e.g. `1/2 * x^2 + sqrt(3)`), for remote engines; the LaTeX itself when unreadable. */
export async function latexToPlain(latex: string): Promise<string> {
  try {
    const { ce } = await engine();
    const e = ce.parse(normalizeLatex(latex));
    if (!e.isValid) return latex.trim();
    return e.toString().replace(/ == /g, " = ");
  } catch {
    return latex.trim();
  }
}
