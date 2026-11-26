// Piecewise functions of x (pure): an expression's pieces, the piece in force at x (the first whose
// interval holds it, ends open or closed), their compiled form, how a window splits into runs of one
// piece, and the curve of a run sampled exactly up to its ends, with a filled dot at a closed finite
// end and a hollow one at an open end. An expression without pieces (or one piece without bounds)
// is a plain function: one run over the whole window and no end dots, as before pieces existed.
import i18n from "../i18n";
import type { GraphExpression, GraphPiece } from "./data";
import { parseExpressionSync, type Evaluator, type ParsedExpr, type ParseResult, type Pending } from "./expressions";
import { sampleCurve, type Point2, type SampleOptions } from "./sample";

/** The pieces of `e`: its own, or its `latex` as the single unbounded piece. */
export const piecesOf = (e: Pick<GraphExpression, "latex" | "pieces">): GraphPiece[] =>
  e.pieces && e.pieces.length > 0 ? e.pieces : [{ latex: e.latex }];

const bounded = (p: GraphPiece): boolean => p.min !== undefined || p.max !== undefined;

/** True when `e` is more than a plain expression: several pieces, or one with a bound. */
export const isPiecewise = (e: Pick<GraphExpression, "pieces">): boolean => !!e.pieces && (e.pieces.length > 1 || e.pieces.some(bounded));

/** `e` with its pieces folded back into `latex` when they say no more than a plain expression. */
export function normalizePieces(e: GraphExpression): GraphExpression {
  if (!e.pieces) return e;
  if (isPiecewise(e)) return { ...e, latex: e.pieces[0].latex };
  const { pieces, ...rest } = e;
  return { ...rest, latex: pieces[0]?.latex ?? e.latex };
}

export interface Interval {
  min?: number;
  max?: number;
  minClosed?: boolean;
  maxClosed?: boolean;
}

/** True when the interval holds x (closed at `min` and open at `max` unless told otherwise). */
export function contains(p: Interval, x: number): boolean {
  if (p.min !== undefined && (x < p.min || (x === p.min && p.minClosed === false))) return false;
  if (p.max !== undefined && (x > p.max || (x === p.max && p.maxClosed !== true))) return false;
  return true;
}

export interface CompiledPiece extends Interval {
  f: Evaluator;
}

/** A function of x, piecewise or not. */
export interface PiecewiseFn {
  pieces: CompiledPiece[];
  /** True when the pieces have bounds (end dots are drawn). */
  piecewise: boolean;
}

/** Index of the piece in force at x, or -1. */
export function pieceAt(fn: PiecewiseFn, x: number): number {
  for (let i = 0; i < fn.pieces.length; i++) if (contains(fn.pieces[i], x)) return i;
  return -1;
}

/** The value of `fn` at x (NaN where no piece holds x). */
export function evaluate(fn: PiecewiseFn, x: number): number {
  const i = pieceAt(fn, x);
  return i < 0 ? NaN : fn.pieces[i].f(x);
}

export type ExprParse = { fn: PiecewiseFn } | { other: ParsedExpr } | { error: string } | Pending;

/**
 * `e` parsed: a function of x (`fn`, piecewise or not), another kind of curve (`other`, never
 * piecewise), an error or pending. Every piece of a piecewise expression must be a function of x.
 */
export function parsePieces(e: Pick<GraphExpression, "latex" | "pieces">, parse: (latex: string) => ParseResult | Pending = parseExpressionSync): ExprParse {
  if (!isPiecewise(e)) {
    const p = parse(e.latex);
    if ("pending" in p || "error" in p) return p;
    return p.kind === "of-x" ? { fn: { pieces: [{ f: p.f }], piecewise: false } } : { other: p };
  }
  const pieces: CompiledPiece[] = [];
  for (const piece of piecesOf(e)) {
    const p = parse(piece.latex);
    if ("pending" in p || "error" in p) return p;
    if (p.kind !== "of-x") return { error: i18n.t("graph.errors.piecesOfX") };
    pieces.push({ f: p.f, min: piece.min, max: piece.max, minClosed: piece.minClosed, maxClosed: piece.maxClosed });
  }
  return { fn: { pieces, piecewise: true } };
}

/** A stretch of the window where one piece is in force (`a` < `b`). */
export interface Run {
  a: number;
  b: number;
  piece: number;
}

/** The finite piece bounds strictly inside (from, to), sorted, without repeats. */
export function cutsOf(fn: PiecewiseFn, from: number, to: number): number[] {
  const set = new Set<number>();
  for (const p of fn.pieces) for (const v of [p.min, p.max]) if (v !== undefined && v > from && v < to) set.add(v);
  return [...set].sort((x, y) => x - y);
}

/**
 * The runs of [from, to]: stretches between piece bounds where one piece is in force, joined
 * when the same piece goes on across a bound that piece also holds. Stretches no piece holds are left out.
 */
export function runsOf(fn: PiecewiseFn, from: number, to: number): Run[] {
  if (!(to > from)) return [];
  const edges = [from, ...cutsOf(fn, from, to), to];
  const runs: Run[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i];
    const b = edges[i + 1];
    const piece = pieceAt(fn, (a + b) / 2);
    if (piece < 0) continue;
    const last = runs[runs.length - 1];
    if (last && last.piece === piece && last.b === a && pieceAt(fn, a) === piece) last.b = b;
    else runs.push({ a, b, piece });
  }
  return runs;
}

/** A piece's end dot (filled when the point belongs to the function's graph). */
export interface PieceEnd extends Point2 {
  filled: boolean;
}

/**
 * The end dots of the runs inside (from, to): a run ends filled where its own piece is in force at
 * the bound, hollow otherwise; a point held by a third piece gets its own filled dot. Where two
 * runs meet at the same height and one of them holds the point, the graph is continuous: no dots.
 */
export function pieceEnds(fn: PiecewiseFn, runs: Run[], from: number, to: number, yTolerance: number): PieceEnd[] {
  if (!fn.piecewise) return [];
  const out: PieceEnd[] = [];
  const value = (piece: number, x: number): number => {
    const v = fn.pieces[piece].f(x);
    return Number.isFinite(v) ? v : NaN;
  };
  for (const c of new Set(runs.flatMap((r) => [r.a, r.b]))) {
    if (c <= from || c >= to) continue;
    const left = runs.find((r) => r.b === c);
    const right = runs.find((r) => r.a === c);
    const at = pieceAt(fn, c);
    const ly = left ? value(left.piece, c) : NaN;
    const ry = right ? value(right.piece, c) : NaN;
    const joined = left && right && Number.isFinite(ly) && Number.isFinite(ry) && Math.abs(ly - ry) <= yTolerance;
    if (joined && (at === left.piece || at === right.piece)) continue;
    if (left && Number.isFinite(ly)) out.push({ x: c, y: ly, filled: at === left.piece });
    // Two runs meeting in one hole share a single hollow dot.
    if (right && Number.isFinite(ry) && !joined) out.push({ x: c, y: ry, filled: at === right.piece });
    if (at >= 0 && at !== left?.piece && at !== right?.piece) {
      const y = value(at, c);
      if (Number.isFinite(y)) out.push({ x: c, y, filled: true });
    }
  }
  return out;
}

/**
 * Branches of y = fn(x) over [from, to]: each run sampled on its own (so no line joins two pieces),
 * from exactly its start to exactly its end. The sample budget is shared in proportion to length.
 */
export function samplePieces(fn: PiecewiseFn, runs: Run[], from: number, to: number, opts: SampleOptions): Point2[][] {
  const span = to - from;
  const initial = opts.initial ?? 256;
  const max = opts.max ?? 2048;
  const out: Point2[][] = [];
  for (const r of runs) {
    const share = runs.length === 1 ? 1 : (r.b - r.a) / span;
    const sub = { ...opts, initial: Math.max(16, Math.round(initial * share)), max: Math.max(64, Math.round(max * share)), xRange: opts.xRange ?? span };
    out.push(...sampleCurve(fn.pieces[r.piece].f, r.a, r.b, sub));
  }
  return out;
}
