// Ink-to-shape recognition (pure). A finished or held ink stroke is matched against the shape
// tool's types: closed strokes (end within 15 % of the path length from the start) are ranked by
// how well each candidate outline fits — polygon candidates come from corner detection (RDP at
// 2 %, 4 %, 6 % of the arc length, 3–12 corners), circle and ellipse are always tried; open strokes
// are a line (straightness) or an arrow (a straight shaft plus a two-winged chevron at one end).
// The result uses the shape tool's geometry: `rect` and `rotation` as `shapeOutline` reads them.
import type { Vec2 } from "../canvas/camera";
import { simplifyPolylineXY } from "../ink/resample";
import type { Point, ShapeType } from "../model/types";
import { shapeOutline, type ShapeRect } from "./geometry";

export interface RecognizedShape {
  type: ShapeType;
  /** Fit quality, 0..1; only results above SNAP_MIN_SCORE are returned. */
  score: number;
  /** Closed types: the unrotated box. Line/arrow: signed start (x, y) → end (x + width, y + height). */
  rect: ShapeRect;
  /** Radians about the rect centre (closed types only). */
  rotation: number;
}

/** A stroke converts only when its best candidate scores above this. */
export const SNAP_MIN_SCORE = 0.55;
const MIN_POINTS = 4;
/** Preconditions (world units). */
const MIN_PATH_LENGTH = 10;
const MIN_DIAGONAL = 24;
/** Closed when the end is within this fraction of the path length from the start. */
const CLOSED_GAP = 0.15;
const RDP_FRACTIONS = [0.02, 0.04, 0.06];
const MIN_CORNERS = 3;
const MAX_CORNERS = 12;
/** A vertex turning less than this is not a corner (it sits on a straight run). */
const MIN_CORNER_TURN = (30 * Math.PI) / 180;
/** Fit error (mean distance / bbox diagonal) at which a candidate scores 0. */
const FIT_ERROR_AT_ZERO = 0.08;
const SAMPLES = 96;
/** Rotations this close to axis-aligned are snapped to 0. */
const ROTATION_SNAP = (6 * Math.PI) / 180;
/** Small preferences that break near-ties: circle over ellipse, unrotated over rotated. */
const CIRCLE_BONUS = 0.02;
const ROTATION_PENALTY = 0.02;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(pts: readonly Vec2[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

function bbox(pts: readonly Vec2[]): ShapeRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** `n` points evenly spaced by arc length along a polyline (first and last kept). */
function resample(pts: readonly Vec2[], n: number): Vec2[] {
  const total = pathLength(pts);
  if (pts.length < 2 || total === 0) return pts.map((p) => ({ x: p.x, y: p.y }));
  const step = total / (n - 1);
  const out: Vec2[] = [{ x: pts[0].x, y: pts[0].y }];
  let carried = 0;
  for (let i = 1; i < pts.length && out.length < n; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = dist(a, b);
    let t = step - carried;
    while (t <= seg && out.length < n - 1) {
      out.push({ x: a.x + ((b.x - a.x) * t) / seg, y: a.y + ((b.y - a.y) * t) / seg });
      t += step;
    }
    carried = seg - (t - step);
  }
  const last = pts[pts.length - 1];
  out.push({ x: last.x, y: last.y });
  return out;
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2) : 0;
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

function polylineDist(p: Vec2, poly: readonly Vec2[]): number {
  if (poly.length === 1) return dist(p, poly[0]);
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) best = Math.min(best, segDist(p, poly[i], poly[i + 1]));
  return best;
}

const asPoints = (pts: readonly Vec2[]): Point[] => pts.map((p, i) => ({ x: p.x, y: p.y, pressure: 0.5, timestamp: i }));

/** Turning angle at `b` on the path a → b → c (0 = straight on, π = reversal). */
function turnAt(a: Vec2, b: Vec2, c: Vec2): number {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const vx = c.x - b.x;
  const vy = c.y - b.y;
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu === 0 || lv === 0) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
}

/**
 * Corners of a closed stroke: RDP at `eps`, the coincident start/end merged, then vertices that
 * barely turn dropped (the start usually lies mid-edge).
 */
export function closedCorners(samples: readonly Vec2[], eps: number): Vec2[] {
  const kept: Vec2[] = simplifyPolylineXY(asPoints(samples), eps).map((p) => ({ x: p.x, y: p.y }));
  if (kept.length > 2 && dist(kept[0], kept[kept.length - 1]) <= Math.max(eps * 2, 1e-9)) kept.pop();
  let changed = true;
  while (changed && kept.length > 2) {
    changed = false;
    let weakest = -1;
    let weakestTurn = MIN_CORNER_TURN;
    for (let i = 0; i < kept.length; i++) {
      const t = turnAt(kept[(i - 1 + kept.length) % kept.length], kept[i], kept[(i + 1) % kept.length]);
      if (t < weakestTurn) {
        weakestTurn = t;
        weakest = i;
      }
    }
    if (weakest >= 0) {
      kept.splice(weakest, 1);
      changed = true;
    }
  }
  return kept;
}

/** Shape types worth trying for a corner count. */
function typesForCorners(k: number): ShapeType[] {
  if (k === 3) return ["triangle"];
  if (k === 4) return ["rectangle", "diamond"];
  if (k === 5) return ["pentagon"];
  if (k === 6) return ["hexagon"];
  if (k >= 7 && k <= MAX_CORNERS) return ["star", "hexagon"];
  return [];
}

const rotateAbout = (p: Vec2, c: Vec2, rad: number): Vec2 => {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const x = p.x - c.x;
  const y = p.y - c.y;
  return { x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos };
};

/** The unrotated box that holds `pts` once turned by `-rotation` about their bbox centre. */
function boxAt(pts: readonly Vec2[], rotation: number): ShapeRect {
  if (!rotation) return bbox(pts);
  const b0 = bbox(pts);
  const c0 = { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 };
  const local = bbox(pts.map((p) => rotateAbout(p, c0, -rotation)));
  // The local box centre, turned back into the world, is the shape's centre.
  const c = rotateAbout({ x: local.x + local.width / 2, y: local.y + local.height / 2 }, c0, rotation);
  return { x: c.x - local.width / 2, y: c.y - local.height / 2, width: local.width, height: local.height };
}

/** Length-weighted mean edge direction modulo 90°, in (-π/4, π/4]. */
function quarterTurnAngle(poly: readonly Vec2[]): number {
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = dist(a, b);
    const th = Math.atan2(b.y - a.y, b.x - a.x) * 4;
    sx += len * Math.cos(th);
    sy += len * Math.sin(th);
  }
  return sx === 0 && sy === 0 ? 0 : Math.atan2(sy, sx) / 4;
}

/** Principal-axis angle of the points, in (-π/4, π/4] (0 when nearly isotropic). */
function principalAngle(pts: readonly Vec2[]): number {
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const tr = sxx + syy;
  const det = Math.sqrt((sxx - syy) ** 2 + 4 * sxy * sxy);
  if (tr === 0 || det / tr < 0.1) return 0;
  let a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // A box turned by a quarter turn is the same box with its sides swapped.
  while (a > Math.PI / 4) a -= Math.PI / 2;
  while (a <= -Math.PI / 4) a += Math.PI / 2;
  return a;
}

/** Rotational symmetry of the regular types (first vertex at the top when unrotated). */
const FOLD: Partial<Record<ShapeType, number>> = { triangle: 3, pentagon: 5, hexagon: 6, star: 5 };

/** Rotation of an n-fold vertex set about its centroid (0 = a vertex straight up). */
function foldAngle(corners: readonly Vec2[], n: number): number {
  let cx = 0;
  let cy = 0;
  for (const p of corners) {
    cx += p.x;
    cy += p.y;
  }
  cx /= corners.length;
  cy /= corners.length;
  let sx = 0;
  let sy = 0;
  for (const p of corners) {
    const phi = (Math.atan2(p.y - cy, p.x - cx) + Math.PI / 2) * n;
    sx += Math.cos(phi);
    sy += Math.sin(phi);
  }
  return Math.atan2(sy, sx) / n;
}

/** The star's points: the corners farther than the median from the centroid. */
function outerCorners(corners: readonly Vec2[]): Vec2[] {
  let cx = 0;
  let cy = 0;
  for (const p of corners) {
    cx += p.x;
    cy += p.y;
  }
  cx /= corners.length;
  cy /= corners.length;
  const d = corners.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const median = [...d].sort((a, b) => a - b)[Math.floor(d.length / 2)];
  return corners.filter((_, i) => d[i] >= median);
}

const snapRotation = (r: number) => (Math.abs(r) < ROTATION_SNAP ? 0 : r);

/** Symmetric mean distance between the stroke samples and a candidate outline. */
function fitError(samples: readonly Vec2[], outline: Vec2[][]): number {
  const outlinePts = outline.flatMap((poly) => resample(poly, Math.min(SAMPLES, Math.max(2, poly.length * 4))));
  let a = 0;
  for (const p of samples) {
    let best = Infinity;
    for (const poly of outline) best = Math.min(best, polylineDist(p, poly));
    a += best;
  }
  let b = 0;
  for (const q of outlinePts) b += polylineDist(q, samples);
  return (a / samples.length + b / outlinePts.length) / 2;
}

interface Candidate {
  type: ShapeType;
  rect: ShapeRect;
  rotation: number;
}

function recognizeClosed(samples: Vec2[], length: number, diag: number): RecognizedShape | null {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const f of RDP_FRACTIONS) {
    const corners = closedCorners(samples, f * length);
    const k = corners.length;
    if (k < MIN_CORNERS || k > MAX_CORNERS) continue;
    for (const type of typesForCorners(k)) {
      const fold = FOLD[type];
      const rotations =
        type === "rectangle"
          ? [snapRotation(quarterTurnAngle(corners))]
          : type === "triangle"
            ? [0, Math.PI / 2, Math.PI, -Math.PI / 2]
            : type === "pentagon" || type === "star"
              ? [0, Math.PI]
              : type === "hexagon"
                ? [0, Math.PI / 2]
                : [0];
      if (fold) rotations.push(snapRotation(foldAngle(type === "star" ? outerCorners(corners) : corners, fold)));
      for (const rotation of rotations) {
        const key = `${type}:${rotation.toFixed(4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ type, rotation, rect: boxAt(samples, rotation) });
      }
    }
  }
  const ellipseRot = snapRotation(principalAngle(samples));
  candidates.push({ type: "ellipse", rotation: ellipseRot, rect: boxAt(samples, ellipseRot) });
  const b = bbox(samples);
  const side = (b.width + b.height) / 2;
  candidates.push({
    type: "circle",
    rotation: 0,
    rect: { x: b.x + b.width / 2 - side / 2, y: b.y + b.height / 2 - side / 2, width: side, height: side },
  });

  let best: RecognizedShape | null = null;
  let bestRank = -Infinity;
  for (const c of candidates) {
    const small = Math.min(c.rect.width, c.rect.height);
    const large = Math.max(c.rect.width, c.rect.height);
    if (small < 8 || small < 0.08 * large) continue; // a back-and-forth line is not a flat shape
    const err = fitError(samples, shapeOutline(c.type, c.rect, c.rotation));
    const score = clamp01(1 - err / diag / FIT_ERROR_AT_ZERO);
    // Quarter turns of triangles/hexagons etc. are legitimate orientations; only free angles pay.
    const free = c.rotation !== 0 && Math.abs(Math.abs(c.rotation) % (Math.PI / 2)) > 1e-6;
    const rank = score + (c.type === "circle" ? CIRCLE_BONUS : 0) - (free ? (ROTATION_PENALTY * Math.abs(c.rotation)) / (Math.PI / 4) : 0);
    if (rank > bestRank) {
      bestRank = rank;
      best = { type: c.type, score, rect: c.rect, rotation: c.rotation };
    }
  }
  return best;
}

/** Arrow: the longest RDP run is the shaft; the stroke beyond one end must be a two-winged chevron. */
function recognizeArrow(samples: Vec2[], length: number): RecognizedShape | null {
  const v: Vec2[] = simplifyPolylineXY(asPoints(samples), 0.04 * length).map((p) => ({ x: p.x, y: p.y }));
  if (v.length < 3) return null;
  let shaft = 0;
  for (let i = 1; i + 1 < v.length; i++) if (dist(v[i], v[i + 1]) > dist(v[shaft], v[shaft + 1])) shaft = i;
  const shaftLen = dist(v[shaft], v[shaft + 1]);
  if (shaftLen < 0.4 * length) return null;
  const before = pathLength(v.slice(0, shaft + 1));
  const after = pathLength(v.slice(shaft + 1));
  const negligible = 0.1 * shaftLen;
  let tip: Vec2;
  let tail: Vec2;
  let head: Vec2[];
  if (after > negligible && before <= negligible) {
    tail = v[shaft];
    tip = v[shaft + 1];
    head = resample(v.slice(shaft + 1), 32);
  } else if (before > negligible && after <= negligible) {
    tail = v[shaft + 1];
    tip = v[shaft];
    head = resample(v.slice(0, shaft + 1), 32);
  } else return null;
  const ux = (tip.x - tail.x) / shaftLen;
  const uy = (tip.y - tail.y) / shaftLen;
  let minA = 0;
  let maxA = 0;
  let left = 0;
  let right = 0;
  for (const q of head) {
    const dx = q.x - tip.x;
    const dy = q.y - tip.y;
    if (Math.hypot(dx, dy) > 0.5 * shaftLen) return null;
    const a = dx * ux + dy * uy;
    const n = -dx * uy + dy * ux;
    minA = Math.min(minA, a);
    maxA = Math.max(maxA, a);
    left = Math.max(left, n);
    right = Math.max(right, -n);
  }
  const wing = 0.05 * shaftLen;
  if (left < wing || right < wing || minA > -wing || maxA > 0.1 * shaftLen) return null;
  const score = 0.6 + 0.4 * (Math.min(left, right) / Math.max(left, right));
  return { type: "arrow", score, rect: { x: tail.x, y: tail.y, width: tip.x - tail.x, height: tip.y - tail.y }, rotation: 0 };
}

function recognizeLine(samples: Vec2[]): RecognizedShape | null {
  const start = samples[0];
  const end = samples[samples.length - 1];
  const chord = dist(start, end);
  if (chord === 0) return null;
  let dev = 0;
  for (const p of samples) dev += segDist(p, start, end);
  dev /= samples.length;
  const simplified = simplifyPolylineXY(asPoints(samples), 0.02 * pathLength(samples));
  const straightness = chord / pathLength(simplified);
  const score = Math.min(clamp01(1 - dev / (0.05 * chord)), clamp01((straightness - 0.85) / 0.15));
  // Ends projected onto the least-squares line through the samples (drops end-point wobble).
  let mx = 0;
  let my = 0;
  for (const p of samples) {
    mx += p.x;
    my += p.y;
  }
  mx /= samples.length;
  my /= samples.length;
  const ux = (end.x - start.x) / chord;
  const uy = (end.y - start.y) / chord;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of samples) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let dx = Math.cos(th);
  let dy = Math.sin(th);
  if (dx * ux + dy * uy < 0) {
    dx = -dx;
    dy = -dy;
  }
  const project = (p: Vec2): Vec2 => {
    const t = (p.x - mx) * dx + (p.y - my) * dy;
    return { x: mx + t * dx, y: my + t * dy };
  };
  const a = project(start);
  const z = project(end);
  return { type: "line", score, rect: { x: a.x, y: a.y, width: z.x - a.x, height: z.y - a.y }, rotation: 0 };
}

/** Best matching shape for an ink stroke, or null when nothing fits well enough to convert. */
export function recognizeShape(points: readonly Vec2[]): RecognizedShape | null {
  if (points.length < MIN_POINTS) return null;
  const length = pathLength(points);
  if (length < MIN_PATH_LENGTH) return null;
  const b = bbox(points);
  const diag = Math.hypot(b.width, b.height);
  if (diag < MIN_DIAGONAL) return null;
  const samples = resample(points, SAMPLES);
  const closed = dist(points[0], points[points.length - 1]) <= CLOSED_GAP * length;
  const r = closed ? recognizeClosed(samples, length, diag) : (recognizeArrow(samples, length) ?? recognizeLine(samples));
  return r && r.score > SNAP_MIN_SCORE ? r : null;
}
