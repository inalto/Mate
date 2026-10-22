import type { Point } from "./types";

// Self-contained ink resampler: Catmull-Rom → cubic Bézier fit, adaptive subdivision, RDP (spec 03 §1).

const TANGENT_CLAMP = 1.26; // max tangent length as a multiple of the segment chord
const CORNER_TURN = Math.PI / 3; // turn above which a point is a corner (flat tangents)
const MAX_STEP_ANGLE = (6 * Math.PI) / 180; // max tangent rotation per emitted step
const MAX_DEPTH = 5; // 2^5 = 32 subdivisions per segment
const MAX_POINTS = 200_000;

type Vec = [number, number];

function lerpPoint(a: Point, b: Point, t: number, x: number, y: number): Point {
  const out: Point = {
    x,
    y,
    pressure: a.pressure + (b.pressure - a.pressure) * t,
    timestamp: a.timestamp + (b.timestamp - a.timestamp) * t,
  };
  if (a.tiltX !== undefined && b.tiltX !== undefined) out.tiltX = a.tiltX + (b.tiltX - a.tiltX) * t;
  if (a.tiltY !== undefined && b.tiltY !== undefined) out.tiltY = a.tiltY + (b.tiltY - a.tiltY) * t;
  if (a.width !== undefined && b.width !== undefined) out.width = a.width + (b.width - a.width) * t;
  return out;
}

function clampLen(v: Vec, max: number): Vec {
  const len = Math.hypot(v[0], v[1]);
  if (len <= max || len === 0) return v;
  const k = max / len;
  return [v[0] * k, v[1] * k];
}

function angleBetween(a: Vec, b: Vec): number {
  const la = Math.hypot(a[0], a[1]);
  const lb = Math.hypot(b[0], b[1]);
  if (la === 0 || lb === 0) return 0;
  const cos = (a[0] * b[0] + a[1] * b[1]) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, cos)));
}

/** Remove consecutive duplicate positions, keeping the final sample of the stroke. */
function dedupe(points: Point[]): Point[] {
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const last = out[out.length - 1];
    if (p.x === last.x && p.y === last.y) {
      if (i === points.length - 1 && out.length > 1) out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/**
 * Catmull-Rom → cubic Bézier resampling. Tangents are clamped to 1.26·|chord|; points turning by
 * more than π/3 are corners with flat (zero) tangents. Each segment is adaptively subdivided until
 * the midpoint deviation is ≤ `tol` and the tangent rotates ≤ 6° per step (≤ 32 steps per segment,
 * ≤ 200k points total). Attributes are interpolated linearly along each segment.
 */
export function resampleInkPoints(points: Point[], tol = 0.08): Point[] {
  if (points.length < 2) return points.slice();
  const pts = dedupe(points);
  const n = pts.length;
  if (n < 2) return pts;

  const tangents: Vec[] = new Array(n);
  tangents[0] = [pts[1].x - pts[0].x, pts[1].y - pts[0].y];
  tangents[n - 1] = [pts[n - 1].x - pts[n - 2].x, pts[n - 1].y - pts[n - 2].y];
  for (let i = 1; i < n - 1; i++) {
    const inV: Vec = [pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y];
    const outV: Vec = [pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y];
    tangents[i] =
      angleBetween(inV, outV) > CORNER_TURN
        ? [0, 0]
        : [(pts[i + 1].x - pts[i - 1].x) / 2, (pts[i + 1].y - pts[i - 1].y) / 2];
  }

  const out: Point[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    out.push(a);
    if (out.length >= MAX_POINTS) continue;

    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    const t0 = clampLen(tangents[i], TANGENT_CLAMP * chord);
    const t1 = clampLen(tangents[i + 1], TANGENT_CLAMP * chord);
    const b0: Vec = [a.x, a.y];
    const b1: Vec = [a.x + t0[0] / 3, a.y + t0[1] / 3];
    const b2: Vec = [b.x - t1[0] / 3, b.y - t1[1] / 3];
    const b3: Vec = [b.x, b.y];

    const at = (t: number): Vec => {
      const s = 1 - t;
      const c0 = s * s * s;
      const c1 = 3 * s * s * t;
      const c2 = 3 * s * t * t;
      const c3 = t * t * t;
      return [
        c0 * b0[0] + c1 * b1[0] + c2 * b2[0] + c3 * b3[0],
        c0 * b0[1] + c1 * b1[1] + c2 * b2[1] + c3 * b3[1],
      ];
    };
    const deriv = (t: number): Vec => {
      const s = 1 - t;
      return [
        3 * (s * s * (b1[0] - b0[0]) + 2 * s * t * (b2[0] - b1[0]) + t * t * (b3[0] - b2[0])),
        3 * (s * s * (b1[1] - b0[1]) + 2 * s * t * (b2[1] - b1[1]) + t * t * (b3[1] - b2[1])),
      ];
    };
    const dirAt = (t: number, fallback: Vec): Vec => {
      const d = deriv(t);
      return Math.hypot(d[0], d[1]) > 1e-12 ? d : fallback;
    };

    // Depth-first subdivision emitting interior samples in increasing t.
    const subdivide = (ta: number, pa: Vec, tb: number, pb: Vec, depth: number) => {
      const tm = (ta + tb) / 2;
      const pm = at(tm);
      if (depth < MAX_DEPTH && out.length < MAX_POINTS) {
        const dev = Math.hypot(pm[0] - (pa[0] + pb[0]) / 2, pm[1] - (pa[1] + pb[1]) / 2);
        const chordDir: Vec = [pb[0] - pa[0], pb[1] - pa[1]];
        const turn = angleBetween(dirAt(ta, chordDir), dirAt(tb, chordDir));
        if (dev > tol || turn > MAX_STEP_ANGLE) {
          subdivide(ta, pa, tm, pm, depth + 1);
          out.push(lerpPoint(a, b, tm, pm[0], pm[1]));
          subdivide(tm, pm, tb, pb, depth + 1);
        }
      }
    };
    subdivide(0, b0, 1, b3, 0);
  }
  out.push(pts[n - 1]);
  return out;
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Ramer–Douglas–Peucker on x/y; kept points retain all their attributes. */
export function simplifyPolylineXY(points: Point[], eps: number): Point[] {
  const n = points.length;
  if (n <= 2 || !(eps > 0)) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const hi = stack.pop()!;
    const lo = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = segDist(points[i], points[lo], points[hi]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > eps) {
      keep[idx] = 1;
      stack.push(lo, idx, idx, hi);
    }
  }
  const out: Point[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** RDP epsilon for a zoom level: 0.25 / zoomBucket, zoomBucket = 2^ceil(log2(zoom)) clamped to 2^±8. */
export function simplifyEpsForZoom(zoom: number): number {
  const e = zoom > 0 ? Math.ceil(Math.log2(zoom)) : -8;
  const exp = Math.max(-8, Math.min(8, e));
  return 0.25 / 2 ** exp;
}
