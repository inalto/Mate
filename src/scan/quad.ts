// Quad helpers for the scan screen: ordering whatever four points detection or the user produce,
// validating them, and sizing the rectified output.
import type { Point, Quad } from "./types";

export const MAX_OUTPUT_SIDE = 2400;
export const MIN_OUTPUT_SIDE = 16;

/** Any four points to [TL, TR, BR, BL]: sort around the centroid, start at the smallest x + y. */
export function orderQuad(points: readonly Point[]): Quad {
  if (points.length !== 4) throw new Error("orderQuad needs exactly 4 points");
  const cx = points.reduce((s, p) => s + p.x, 0) / 4;
  const cy = points.reduce((s, p) => s + p.y, 0) / 4;
  // y grows downwards, so increasing atan2 runs clockwise on screen: TL -> TR -> BR -> BL.
  const sorted = [...points].sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]) as Quad;
}

/** Strictly convex with non-zero area: all four edge turns have the same, non-zero sign. */
export function isConvexQuad(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (!(Math.abs(cross) > 1e-9)) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Shoelace area, absolute. */
export function quadArea(q: Quad): number {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Mean opposite-edge lengths, long side capped at maxLongSide, never upscaled, at least 16 px. */
export function outputSize(q: Quad, maxLongSide = MAX_OUTPUT_SIDE): { width: number; height: number } {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  const k = Math.min(1, maxLongSide / Math.max(w, h, 1e-9));
  return {
    width: Math.max(MIN_OUTPUT_SIDE, Math.round(w * k)),
    height: Math.max(MIN_OUTPUT_SIDE, Math.round(h * k)),
  };
}

/** The default quad when nothing is detected: the frame pulled in by `fraction` on every side. */
export function insetQuad(width: number, height: number, fraction = 0.1): Quad {
  const x0 = width * fraction;
  const y0 = height * fraction;
  const x1 = width - x0;
  const y1 = height - y0;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}
