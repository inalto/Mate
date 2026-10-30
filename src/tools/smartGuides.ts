// Smart-guide geometry (pure): edge/centre alignment snaps and equal-spacing hints for a moving or
// resizing selection against the other elements' bounds (world units). A guide on axis "x" is a
// vertical line at x = `at` spanning y `from`..`to`; on axis "y" a horizontal line at y = `at`
// spanning x `from`..`to`.
import type { Rect } from "./spatialIndex";

export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
  /** Gap length, on equal-spacing guides. */
  label?: string;
}

export interface SnapResult {
  /** Corrections to add to the move delta. */
  dx: number;
  dy: number;
  guides: Guide[];
}

/** Matches closer than this count as the same line (floating-point noise). */
const EPS = 1e-6;

type Axis = "x" | "y";

/** Start, centre and end of `r` along `axis`. */
const stops = (r: Rect, axis: Axis): number[] => {
  const p = axis === "x" ? r.x : r.y;
  const s = axis === "x" ? r.width : r.height;
  return [p, p + s / 2, p + s];
};

/** `r`'s extent on the axis across `axis` (y range for "x", x range for "y"). */
const across = (r: Rect, axis: Axis): [number, number] =>
  axis === "x" ? [r.y, r.y + r.height] : [r.x, r.x + r.width];

/** The smallest correction (|d| ≤ threshold) bringing a stop of `moving` onto a stop of an other, or null. */
function bestDelta(moving: Rect, others: readonly Rect[], axis: Axis, threshold: number): number | null {
  let best: number | null = null;
  const mine = stops(moving, axis);
  for (const o of others)
    for (const t of stops(o, axis))
      for (const m of mine) {
        const d = t - m;
        if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
      }
  return best;
}

/** One guide per matched line of `moving` (already snapped), spanning it and every matching other. */
function alignGuides(moving: Rect, others: readonly Rect[], axis: Axis): Guide[] {
  const byAt = new Map<number, Guide>();
  const mine = stops(moving, axis);
  const [mFrom, mTo] = across(moving, axis);
  for (const o of others) {
    const [oFrom, oTo] = across(o, axis);
    for (const t of stops(o, axis)) {
      const m = mine.find((v) => Math.abs(v - t) <= EPS);
      if (m === undefined) continue;
      const g = byAt.get(m);
      if (g) {
        g.from = Math.min(g.from, oFrom);
        g.to = Math.max(g.to, oTo);
      } else byAt.set(m, { axis, at: m, from: Math.min(mFrom, oFrom), to: Math.max(mTo, oTo) });
    }
  }
  return [...byAt.values()];
}

/**
 * Snap a moving rect: per axis, the nearest match (≤ `threshold`) between its left/centre/right
 * (top/middle/bottom) and those of `others` gives the correction; guides cover every line that
 * matches after the correction.
 */
export function snapMove(moving: Rect, others: readonly Rect[], threshold: number): SnapResult {
  const dx = bestDelta(moving, others, "x", threshold) ?? 0;
  const dy = bestDelta(moving, others, "y", threshold) ?? 0;
  const snapped = { ...moving, x: moving.x + dx, y: moving.y + dy };
  return { dx, dy, guides: [...alignGuides(snapped, others, "x"), ...alignGuides(snapped, others, "y")] };
}

/**
 * Snap one edge being resized (at `edgeAt` along `edgeAxis`) to the nearest stop of `others`
 * within `threshold`; the guide spans the matched elements' extent across the axis.
 */
export function snapResize(
  edgeAxis: "x" | "y",
  edgeAt: number,
  others: readonly Rect[],
  threshold: number,
): { at: number; guide: Guide | null } {
  let best: number | null = null;
  for (const o of others)
    for (const t of stops(o, edgeAxis))
      if (Math.abs(t - edgeAt) <= threshold && (best === null || Math.abs(t - edgeAt) < Math.abs(best - edgeAt))) best = t;
  if (best === null) return { at: edgeAt, guide: null };
  const at = best;
  const guide: Guide = { axis: edgeAxis, at, from: Infinity, to: -Infinity };
  for (const o of others) {
    if (!stops(o, edgeAxis).some((t) => Math.abs(t - at) <= EPS)) continue;
    const [from, to] = across(o, edgeAxis);
    guide.from = Math.min(guide.from, from);
    guide.to = Math.max(guide.to, to);
  }
  return { at, guide };
}

const overlap = (a0: number, a1: number, b0: number, b1: number): [number, number] | null => {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  return lo <= hi ? [lo, hi] : null;
};

const label = (gap: number): string => String(Math.round(gap));

/**
 * Equal-spacing hints: per axis, when `moving` sits between its nearest neighbours on both sides
 * (neighbours overlap it on the other axis) and the two gaps differ by ≤ `threshold`, one guide per
 * gap (drawn across the gap, at the middle of the overlap) labelled with its length.
 */
export function equalSpacing(moving: Rect, others: readonly Rect[], threshold: number): Guide[] {
  const out: Guide[] = [];
  for (const axis of ["x", "y"] as const) {
    const [mStart, , mEnd] = stops(moving, axis);
    const [mFrom, mTo] = across(moving, axis);
    let before: { end: number; band: [number, number] } | null = null;
    let after: { start: number; band: [number, number] } | null = null;
    for (const o of others) {
      const [oStart, , oEnd] = stops(o, axis);
      const [oFrom, oTo] = across(o, axis);
      const band = overlap(mFrom, mTo, oFrom, oTo);
      if (!band) continue;
      if (oEnd <= mStart && (!before || oEnd > before.end)) before = { end: oEnd, band };
      if (oStart >= mEnd && (!after || oStart < after.start)) after = { start: oStart, band };
    }
    if (!before || !after) continue;
    const g1 = mStart - before.end;
    const g2 = after.start - mEnd;
    if (Math.abs(g1 - g2) > threshold) continue;
    // A gap guide runs along `axis`, so it is a line of constant position on the other axis.
    const line: Axis = axis === "x" ? "y" : "x";
    out.push({ axis: line, at: (before.band[0] + before.band[1]) / 2, from: before.end, to: mStart, label: label(g1) });
    out.push({ axis: line, at: (after.band[0] + after.band[1]) / 2, from: mEnd, to: after.start, label: label(g2) });
  }
  return out;
}
