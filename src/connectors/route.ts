// Connector routing (pure): the polyline a connector follows between its two ends, in page units.
// straight: the two ends; curve: a cubic Bézier leaving each anchor perpendicular to its side,
// flattened to CURVE_SEGMENTS; elbow: axis-aligned segments that leave each anchor perpendicular
// by ELBOW_STUB and avoid the attached elements' bounds padded by ELBOW_PADDING (no general
// obstacle avoidance). Free ends (side null) aim at the other end.
import type { Vec2 } from "../canvas/camera";
import type { ConnectorContent, Side } from "../model/content";
import type { Rect } from "../tools/spatialIndex";

export type ConnectorMode = ConnectorContent["mode"];

export const CONNECTOR_MODES: readonly ConnectorMode[] = ["straight", "curve", "elbow"];
export const CURVE_SEGMENTS = 32;
export const ELBOW_STUB = 24;
export const ELBOW_PADDING = 16;
/** Minimum distance of a curve's control points from their anchor. */
const CURVE_MIN_REACH = 40;
/** Sideways pull of a free-to-free curve's control points, as a fraction of the chord. */
const CURVE_BOW = 0.3;

/** Unit direction leaving an element through `side`. */
export const SIDE_DIR: Readonly<Record<Side, Vec2>> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

function unit(from: Vec2, to: Vec2): Vec2 {
  const d = dist(from, to);
  return d > 0 ? { x: (to.x - from.x) / d, y: (to.y - from.y) / d } : { x: 0, y: 0 };
}

function cubic(a: Vec2, c1: Vec2, c2: Vec2, b: Vec2): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= CURVE_SEGMENTS; i++) {
    const t = i / CURVE_SEGMENTS;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    out.push({ x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x, y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y });
  }
  // Exact ends (no rounding drift), so the route starts and ends at the anchors.
  out[0] = { x: a.x, y: a.y };
  out[CURVE_SEGMENTS] = { x: b.x, y: b.y };
  return out;
}

export type CurveShape = "C" | "U" | "S";

/** Distance a U's curve must pass beyond the farther of its two ends, so it clears both shapes. */
const CURVE_U_MARGIN = 32;
/** Handle length of a quarter-turn arc, as a fraction of the distance it covers along its own direction. */
const CURVE_QUARTER = 0.55;

const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

/** Nearest axis direction (ties go to x): a free end aims along the axis its chord mostly follows. */
function snapAxis(v: Vec2): Vec2 {
  return Math.abs(v.x) >= Math.abs(v.y) ? { x: Math.sign(v.x), y: 0 } : { x: 0, y: Math.sign(v.y) };
}

/** Directions the two control points extend in: the side's outward direction, or (free end) the snapped chord direction. */
function curveDirs(start: Vec2, startSide: Side | null, end: Vec2, endSide: Side | null): [Vec2, Vec2] {
  return [
    startSide ? SIDE_DIR[startSide] : snapAxis(unit(start, end)),
    endSide ? SIDE_DIR[endSide] : snapAxis(unit(end, start)),
  ];
}

/** S: ends leave in opposite directions; U: the same direction; C: at right angles. Two free ends bow as a C. */
export function curveShape(startSide: Side | null, endSide: Side | null, start: Vec2, end: Vec2): CurveShape {
  if (!startSide && !endSide) return "C";
  const [d1, d2] = curveDirs(start, startSide, end, endSide);
  const k = dot(d1, d2);
  return k < -0.5 ? "S" : k > 0.5 ? "U" : "C";
}

/** The two Bézier control points for a curve from `start` to `end` (see `curveShape` for the cases). */
export function curveControls(start: Vec2, startSide: Side | null, end: Vec2, endSide: Side | null): [Vec2, Vec2] {
  const d = dist(start, end);
  const at = (p: Vec2, dir: Vec2, r: number): Vec2 => ({ x: p.x + dir.x * r, y: p.y + dir.y * r });
  if (!startSide && !endSide) {
    // Two free ends have no side to leave by: aiming both control points along the chord would
    // be a straight line, so the curve bows to one side as an arc instead.
    const u = unit(start, end);
    const off = { x: -u.y * CURVE_BOW * d, y: u.x * CURVE_BOW * d };
    return [at({ x: start.x + off.x, y: start.y + off.y }, u, d / 3), at({ x: end.x + off.x, y: end.y + off.y }, u, -d / 3)];
  }
  const [d1, d2] = curveDirs(start, startSide, end, endSide);
  const delta = { x: end.x - start.x, y: end.y - start.y };
  const shape = curveShape(startSide, endSide, start, end);
  if (shape === "S") {
    const ahead = dot(delta, d1);
    // Facing each other: a clean S. Facing away: swing out around both shapes, further the further back the end is.
    const reach = ahead > 0 ? Math.max(CURVE_MIN_REACH, ahead / 2) : CURVE_MIN_REACH + 0.75 * -ahead;
    return [at(start, d1, reach), at(end, d2, reach)];
  }
  if (shape === "U") {
    // Both handles reach the same line beyond the farther end; a cubic peaks at ~3/4 of its handles' reach, plus slack for the nearer end.
    const a1 = dot(start, d1);
    const a2 = dot(end, d1);
    const far = Math.max(a1, a2);
    const across = Math.abs(delta.x * d1.y - delta.y * d1.x);
    const over = Math.max(CURVE_MIN_REACH, (CURVE_U_MARGIN + Math.abs(a1 - a2) / 8) / 0.75 + 0.25 * across);
    return [at(start, d1, far + over - a1), at(end, d1, far + over - a2)];
  }
  return [
    at(start, d1, Math.max(CURVE_MIN_REACH, CURVE_QUARTER * Math.abs(dot(delta, d1)))),
    at(end, d2, Math.max(CURVE_MIN_REACH, CURVE_QUARTER * Math.abs(dot(delta, d2)))),
  ];
}

function curve(start: Vec2, startSide: Side | null, end: Vec2, endSide: Side | null): Vec2[] {
  if (dist(start, end) === 0) return [{ ...start }, { ...end }];
  const [c1, c2] = curveControls(start, startSide, end, endSide);
  return cubic(start, c1, c2, end);
}

const strictlyInside = (p: Vec2, r: Rect): boolean => p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;

/** True when axis-aligned segment ab passes through the interior of `r` (touching the edge is fine). */
function segmentEnters(a: Vec2, b: Vec2, r: Rect): boolean {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return x1 > r.x && x0 < r.x + r.width && y1 > r.y && y0 < r.y + r.height;
}

const pad = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, width: r.width + 2 * p, height: r.height + 2 * p });

/** End of the stub leaving `at` along `side`: ELBOW_STUB out, and at least clear of the padded boxes it starts in. */
function stub(at: Vec2, side: Side | null, boxes: readonly Rect[]): Vec2 {
  if (!side) return { ...at };
  const d = SIDE_DIR[side];
  let len = ELBOW_STUB;
  for (const b of boxes) {
    const p = { x: at.x + d.x * len, y: at.y + d.y * len };
    if (!strictlyInside(p, b)) continue;
    const exit = d.x > 0 ? b.x + b.width - at.x : d.x < 0 ? at.x - b.x : d.y > 0 ? b.y + b.height - at.y : at.y - b.y;
    len = Math.max(len, exit);
  }
  return { x: at.x + d.x * len, y: at.y + d.y * len };
}

const same = (a: Vec2, b: Vec2): boolean => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
const collinear = (a: Vec2, b: Vec2, c: Vec2): boolean =>
  (Math.abs(a.x - b.x) < 1e-9 && Math.abs(b.x - c.x) < 1e-9) || (Math.abs(a.y - b.y) < 1e-9 && Math.abs(b.y - c.y) < 1e-9);

/** Drop repeated points and the middle of straight runs. */
function simplify(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    if (out.length > 0 && same(out[out.length - 1], p)) continue;
    if (out.length >= 2 && collinear(out[out.length - 2], out[out.length - 1], p)) out[out.length - 1] = p;
    else out.push(p);
  }
  if (out.length === 1) out.push({ ...out[0] });
  return out;
}

const pathLength = (pts: readonly Vec2[]): number => {
  let l = 0;
  for (let i = 0; i + 1 < pts.length; i++) l += dist(pts[i], pts[i + 1]);
  return l;
};

const horizontal = (s: Side | null): boolean => s === "left" || s === "right";
const vertical = (s: Side | null): boolean => s === "top" || s === "bottom";

function elbow(start: Vec2, startSide: Side | null, end: Vec2, endSide: Side | null, avoid: readonly Rect[]): Vec2[] {
  const boxes = avoid.map((r) => pad(r, ELBOW_PADDING));
  const s = stub(start, startSide, boxes);
  const e = stub(end, endSide, boxes);
  const hFirst = [s, { x: e.x, y: s.y }, e];
  const vFirst = [s, { x: s.x, y: e.y }, e];
  const viaX = (x: number) => [s, { x, y: s.y }, { x, y: e.y }, e];
  const viaY = (y: number) => [s, { x: s.x, y }, { x: e.x, y }, e];
  const midX = viaX((s.x + e.x) / 2);
  const midY = viaY((s.y + e.y) / 2);
  // Standard candidates, the one matching the stub orientations first.
  let standard: Vec2[][];
  if (horizontal(startSide) && horizontal(endSide)) standard = [midX, hFirst, vFirst, midY];
  else if (vertical(startSide) && vertical(endSide)) standard = [midY, vFirst, hFirst, midX];
  else if (vertical(startSide) || horizontal(endSide)) standard = [vFirst, hFirst, midX, midY];
  else standard = [hFirst, vFirst, midX, midY];
  // Detours along the padded boxes' edges, for ends facing away from each other.
  const detours: Vec2[][] = [];
  for (const b of boxes) {
    detours.push(viaX(b.x), viaX(b.x + b.width), viaY(b.y), viaY(b.y + b.height));
  }
  const full = (mid: Vec2[]) => simplify([start, ...mid, end]);
  const clear = (mid: Vec2[]) => {
    for (let i = 0; i + 1 < mid.length; i++) for (const b of boxes) if (segmentEnters(mid[i], mid[i + 1], b)) return false;
    return true;
  };
  for (const mid of standard) if (clear(mid)) return full(mid);
  const clearDetours = detours.filter(clear);
  const pool = clearDetours.length > 0 ? clearDetours : [...standard, ...detours];
  let best = full(pool[0]);
  for (const mid of pool.slice(1)) {
    const p = full(mid);
    if (pathLength(p) < pathLength(best)) best = p;
  }
  return best;
}

/**
 * The routed polyline from `start` to `end` (first and last points are exactly those). Sides are
 * the attached sides (null for a free end); `avoid` the attached elements' bounds (elbow only).
 * Elbow routes have only axis-aligned segments and at most 6 points.
 */
export function routePath(
  mode: ConnectorMode,
  start: Vec2,
  startSide: Side | null,
  end: Vec2,
  endSide: Side | null,
  avoid: readonly Rect[] = [],
): Vec2[] {
  if (mode === "curve") return curve(start, startSide, end, endSide);
  if (mode === "elbow") return elbow(start, startSide, end, endSide, avoid);
  return [{ x: start.x, y: start.y }, { x: end.x, y: end.y }];
}

/** Point at arc-length fraction `t` (clamped to 0..1) along `route`. */
export function pointAt(route: readonly Vec2[], t: number): Vec2 {
  if (route.length === 0) return { x: 0, y: 0 };
  const total = pathLength(route);
  if (route.length === 1 || total === 0) return { ...route[0] };
  let left = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i + 1 < route.length; i++) {
    const l = dist(route[i], route[i + 1]);
    if (left <= l || i + 2 === route.length) {
      const k = l > 0 ? Math.min(1, left / l) : 0;
      return { x: route[i].x + (route[i + 1].x - route[i].x) * k, y: route[i].y + (route[i + 1].y - route[i].y) * k };
    }
    left -= l;
  }
  return { ...route[route.length - 1] };
}

/** Arc-length fraction (0..1) of the point of `route` nearest `p`. */
export function nearestT(route: readonly Vec2[], p: Vec2): number {
  const total = pathLength(route);
  if (route.length < 2 || total === 0) return 0;
  let best = Infinity;
  let bestAt = 0;
  let walked = 0;
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i];
    const b = route[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const k = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const d2 = (a.x + k * dx - p.x) ** 2 + (a.y + k * dy - p.y) ** 2;
    if (d2 < best) {
      best = d2;
      bestAt = walked + k * Math.sqrt(len2);
    }
    walked += Math.sqrt(len2);
  }
  return bestAt / total;
}
