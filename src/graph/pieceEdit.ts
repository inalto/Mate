// Edits of an expression's pieces (pure), as the editor makes them: the expression's `latex` always
// follows its first piece. An expression shows its interval inputs once it has `pieces` (even a
// single unbounded one, after "Restrict domain"); `normalizePieces` folds that back on commit.
import type { GraphExpression, GraphPiece } from "./data";
import { piecesOf } from "./pieces";

const withPieces = (e: GraphExpression, pieces: GraphPiece[]): GraphExpression => ({ ...e, pieces, latex: pieces[0]?.latex ?? "" });

/** `e` with the k-th piece's expression set. */
export function setPieceLatex(e: GraphExpression, k: number, latex: string): GraphExpression {
  if (!e.pieces) return k === 0 ? { ...e, latex } : e;
  return withPieces(
    e,
    e.pieces.map((p, i) => (i === k ? { ...p, latex } : p)),
  );
}

/** `e` with the k-th piece's bounds changed (`undefined` removes a bound). */
export function setPieceBounds(e: GraphExpression, k: number, patch: Partial<Omit<GraphPiece, "latex">>): GraphExpression {
  const pieces = piecesOf(e).map((p, i) => {
    if (i !== k) return p;
    const next: GraphPiece = { ...p, ...patch };
    for (const key of ["min", "max", "minClosed", "maxClosed"] as const) if (next[key] === undefined) delete next[key];
    return next;
  });
  return withPieces(e, pieces);
}

/** `e` with its interval inputs shown: its expression as a single piece, unbounded until edited. */
export const restrictDomain = (e: GraphExpression): GraphExpression => (e.pieces ? e : withPieces(e, [{ latex: e.latex }]));

/**
 * `e` with a new, empty piece after the last. The new piece starts where the last one ends (the
 * other side of that bound); a last piece without bounds first ends at 0, so x < 0 and x ≥ 0 follow.
 */
export function addPiece(e: GraphExpression): GraphExpression {
  const pieces = [...piecesOf(e)];
  const last = pieces[pieces.length - 1];
  if (last.min === undefined && last.max === undefined) {
    pieces[pieces.length - 1] = { ...last, max: 0 };
    pieces.push({ latex: "", min: 0 });
  } else if (last.max !== undefined) {
    pieces.push({ latex: "", min: last.max, ...(last.maxClosed ? { minClosed: false } : {}) });
  } else {
    pieces.push({ latex: "" });
  }
  return withPieces(e, pieces);
}

/** `e` without its k-th piece; a lone unbounded piece left over is folded back into `latex`. */
export function removePiece(e: GraphExpression, k: number): GraphExpression {
  const pieces = piecesOf(e).filter((_, i) => i !== k);
  if (pieces.length === 0) {
    const { pieces: _drop, ...rest } = e;
    return { ...rest, latex: "" };
  }
  const only = pieces.length === 1 ? pieces[0] : null;
  if (only && only.min === undefined && only.max === undefined) {
    const { pieces: _drop, ...rest } = e;
    return { ...rest, latex: only.latex };
  }
  return withPieces(e, pieces);
}

/** Pieces whose bounds were typed in the wrong order, swapped (stored pieces need min ≤ max). */
export function orderBounds(e: GraphExpression): GraphExpression {
  if (!e.pieces?.some((p) => p.min !== undefined && p.max !== undefined && p.min > p.max)) return e;
  return withPieces(
    e,
    e.pieces.map((p) =>
      p.min !== undefined && p.max !== undefined && p.min > p.max ? { ...p, min: p.max, max: p.min, minClosed: p.maxClosed ?? false, maxClosed: p.minClosed ?? true } : p,
    ),
  );
}

const NAMES = ["f", "g", "h", "p", "q", "u", "v", "w"];

/** The name of the `index`-th expression: its own, else f, g, h… then f₂, g₂… */
export function functionName(e: Pick<GraphExpression, "name">, index: number): string {
  if (e.name) return e.name;
  const base = NAMES[index % NAMES.length];
  const round = Math.floor(index / NAMES.length);
  return round === 0 ? base : `${base}${String(round + 1).replace(/\d/g, (d) => "₀₁₂₃₄₅₆₇₈₉"[Number(d)])}`;
}

/** A name no other expression uses, for a new one. */
export function freshName(exprs: GraphExpression[]): string {
  const used = new Set(exprs.map((e, i) => functionName(e, i)));
  for (let i = 0; ; i++) {
    const n = functionName({}, i);
    if (!used.has(n)) return n;
  }
}
