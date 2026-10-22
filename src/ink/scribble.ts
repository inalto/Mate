// Scribble-to-erase (pure). A fast, confined back-and-forth pen gesture over ink erases what it
// covers instead of being committed. Detection works in screen px (world × zoom) so it behaves the
// same at every zoom: gates (point count, duration, size, speed, confinement), then the path is
// resampled every 6 px (≤ 80 samples) and judged by reversals, self-crossings and a sawtooth test.
import { shapeElementOutline } from "../shapes/geometry";
import type { Vec2 } from "../canvas/camera";
import type { Element, Point } from "../model/types";
import { elementBounds, rectsOverlap, type Rect, type SpatialIndex } from "../tools/spatialIndex";

export type ScribbleSensitivity = "less" | "standard" | "more";

interface Profile {
  minAvgScreenSpeedPxPerMs: number;
  sawtoothMinScreenSpeedPxPerMs: number;
}

export const SCRIBBLE_PROFILES: Record<ScribbleSensitivity, Profile> = {
  less: { minAvgScreenSpeedPxPerMs: 0.4, sawtoothMinScreenSpeedPxPerMs: 0.6 },
  standard: { minAvgScreenSpeedPxPerMs: 0.3, sawtoothMinScreenSpeedPxPerMs: 0.5 },
  more: { minAvgScreenSpeedPxPerMs: 0.3, sawtoothMinScreenSpeedPxPerMs: 0.5 },
};

const MIN_POINTS = 10;
const MIN_DURATION_MS = 30;
const MAX_DURATION_MS = 3000;
const MIN_AREA_PX2 = 40;
const MIN_CONFINEMENT = 1.5;
const RESAMPLE_PX = 6;
const MAX_SAMPLES = 80;
/** cos 150°: consecutive segments this opposed are a reversal. */
const REVERSAL_DOT = -0.866;
/** |cos| below this: the crossing segments are not near-parallel. */
const DENSE_COS = 0.866;
const MIN_REVERSALS = 4;
const MIN_DENSE_CROSSINGS = 3;
const DENSE_CONFINEMENT = 8;
const SAW_MIN_DRIFT_PX = 24;
const SAW_MIN_TEETH = 4;
const SAW_MIN_STEEPNESS = 2;
const SAW_MIN_DUTY = 0.87;
const SAW_MIN_APEX_TURN = (125 * Math.PI) / 180;
/** Apex positions may step back this much against the drift (screen px). */
const SAW_DRIFT_SLACK_PX = 2;
/** Erase reach beyond a stroke's half width (screen px). */
const HIT_SLOP_PX = 6;

export interface ScribbleResult {
  scribble: boolean;
  /** World bounds of the gesture. */
  bbox: Rect;
}

function bboxOf(pts: readonly Vec2[]): Rect {
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
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : { x: 0, y: 0, width: 0, height: 0 };
}

function pathLength(pts: readonly Vec2[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

/** Points every `step` along the path (first kept, last appended). */
function resampleEvery(pts: readonly Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [{ ...pts[0] }];
  let carried = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg === 0) continue;
    let t = step - carried;
    while (t <= seg) {
      out.push({ x: a.x + ((b.x - a.x) * t) / seg, y: a.y + ((b.y - a.y) * t) / seg });
      t += step;
    }
    carried = seg - (t - step);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > step * 0.25) out.push({ ...last });
  return out;
}

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

/** True when segments ab and cd properly intersect. */
function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
  const d2 = cross(b.x - a.x, b.y - a.y, d.x - a.x, d.y - a.y);
  const d3 = cross(d.x - c.x, d.y - c.y, a.x - c.x, a.y - c.y);
  const d4 = cross(d.x - c.x, d.y - c.y, b.x - c.x, b.y - c.y);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

interface Seg {
  dx: number;
  dy: number;
  len: number;
}

const unitDot = (a: Seg, b: Seg) => (a.dx * b.dx + a.dy * b.dy) / (a.len * b.len);

/** Direction reversals: consecutive resampled segments pointing (nearly) opposite ways. */
function countReversals(segs: readonly Seg[]): number {
  let n = 0;
  for (let i = 0; i + 1 < segs.length; i++) if (unitDot(segs[i], segs[i + 1]) < REVERSAL_DOT) n++;
  return n;
}

function countCrossings(q: readonly Vec2[]): { crossings: number; dense: number } {
  let crossings = 0;
  let dense = 0;
  for (let i = 0; i + 1 < q.length; i++) {
    for (let j = i + 2; j + 1 < q.length; j++) {
      if (!segmentsCross(q[i], q[i + 1], q[j], q[j + 1])) continue;
      crossings++;
      const ax = q[i + 1].x - q[i].x;
      const ay = q[i + 1].y - q[i].y;
      const bx = q[j + 1].x - q[j].x;
      const by = q[j + 1].y - q[j].y;
      const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
      if (Math.abs(cos) < DENSE_COS) dense++;
    }
  }
  return { crossings, dense };
}

/**
 * Sawtooth: steep strokes back and forth along a stroke axis `u` while the apexes drift
 * monotonically across it (`d`), e.g. a fast zigzag along a line of text.
 */
function isSawtooth(q: readonly Vec2[], segs: readonly Seg[]): boolean {
  // Stroke axis: length-weighted mean segment orientation (angles doubled: direction-free).
  let sx = 0;
  let sy = 0;
  for (const s of segs) {
    const th = 2 * Math.atan2(s.dy, s.dx);
    sx += s.len * Math.cos(th);
    sy += s.len * Math.sin(th);
  }
  const th = Math.atan2(sy, sx) / 2;
  const u = { x: Math.cos(th), y: Math.sin(th) };
  const U = q.map((p) => p.x * u.x + p.y * u.y);
  const D = q.map((p) => -p.x * u.y + p.y * u.x);

  // Runs of constant direction along u; their ends are the apexes.
  const apex: number[] = [0];
  let sign = 0;
  for (let i = 0; i + 1 < q.length; i++) {
    const du = U[i + 1] - U[i];
    if (Math.abs(du) < 0.5) continue;
    const sg = Math.sign(du);
    if (sign !== 0 && sg !== sign) apex.push(i);
    sign = sg;
  }
  apex.push(q.length - 1);
  const runs = apex.length - 1;
  if (Math.floor(runs / 2) < SAW_MIN_TEETH) return false;

  // Monotonic drift of the apexes across the stroke axis.
  const drift = D[apex[apex.length - 1]] - D[apex[0]];
  if (Math.abs(drift) < SAW_MIN_DRIFT_PX) return false;
  const dir = Math.sign(drift);
  for (let k = 1; k < apex.length; k++) if ((D[apex[k]] - D[apex[k - 1]]) * dir < -SAW_DRIFT_SLACK_PX) return false;

  // Duty: share of the path spent on steep flanks.
  let total = 0;
  let steep = 0;
  for (let k = 0; k < runs; k++) {
    let len = 0;
    for (let i = apex[k]; i < apex[k + 1]; i++) len += segs[i].len;
    total += len;
    const du = Math.abs(U[apex[k + 1]] - U[apex[k]]);
    const dd = Math.abs(D[apex[k + 1]] - D[apex[k]]);
    if (du >= SAW_MIN_STEEPNESS * dd) steep += len;
  }
  if (total === 0 || steep / total < SAW_MIN_DUTY) return false;

  // Sharp apexes: the path turns hard right at each apex (two samples each side), so round arches
  // ("mmm") are handwriting, not a saw.
  for (let k = 1; k + 1 < apex.length; k++) {
    const i = apex[k];
    const a = q[Math.max(0, i - 2)];
    const b = q[i];
    const c = q[Math.min(q.length - 1, i + 2)];
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const vx = c.x - b.x;
    const vy = c.y - b.y;
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu === 0 || lv === 0) return false;
    const turn = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
    if (turn < SAW_MIN_APEX_TURN) return false;
  }
  return true;
}

const profileOf = (sensitivity: string): Profile =>
  SCRIBBLE_PROFILES[(sensitivity in SCRIBBLE_PROFILES ? sensitivity : "standard") as ScribbleSensitivity];

/** Whether the (stabilised, uncommitted) stroke points form a scribble-to-erase gesture. */
export function isScribbleGesture(points: readonly Point[], zoom: number, sensitivity: string): ScribbleResult {
  const bbox = bboxOf(points);
  const no = { scribble: false, bbox };
  if (points.length < MIN_POINTS || !(zoom > 0)) return no;
  const duration = points[points.length - 1].timestamp - points[0].timestamp;
  if (duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) return no;
  const profile = profileOf(sensitivity);

  const screen = points.map((p) => ({ x: p.x * zoom, y: p.y * zoom }));
  const area = bbox.width * zoom * (bbox.height * zoom);
  if (area < MIN_AREA_PX2) return no;
  const length = pathLength(screen);
  const speed = length / duration;
  if (speed < profile.minAvgScreenSpeedPxPerMs) return no;
  const confinement = length / Math.sqrt(area);
  if (confinement < MIN_CONFINEMENT) return no;

  const q = resampleEvery(screen, Math.max(RESAMPLE_PX, length / (MAX_SAMPLES - 1)));
  const segs: Seg[] = [];
  const kept: Vec2[] = [q[0]];
  for (let i = 1; i < q.length; i++) {
    const dx = q[i].x - kept[kept.length - 1].x;
    const dy = q[i].y - kept[kept.length - 1].y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    segs.push({ dx, dy, len });
    kept.push(q[i]);
  }
  if (segs.length < 3) return no;

  const reversals = countReversals(segs);
  const { crossings, dense } = countCrossings(kept);
  const sawtooth = speed >= profile.sawtoothMinScreenSpeedPxPerMs && isSawtooth(kept, segs);
  const scribble =
    (reversals >= MIN_REVERSALS && crossings >= 1) || (dense >= MIN_DENSE_CROSSINGS && confinement >= DENSE_CONFINEMENT) || sawtooth;
  return { scribble, bbox };
}

function segDist2(a: Vec2, b: Vec2, c: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2)) : 0;
  return (a.x + t * dx - c.x) ** 2 + (a.y + t * dy - c.y) ** 2;
}

/** True when any scribble point lies within `r` of a segment of `poly`. */
function touches(scribble: readonly Vec2[], poly: readonly Vec2[], r: number): boolean {
  const r2 = r * r;
  for (const p of scribble) {
    if (poly.length === 1) {
      if (segDist2(poly[0], poly[0], p) <= r2) return true;
      continue;
    }
    for (let i = 0; i + 1 < poly.length; i++) if (segDist2(poly[i], poly[i + 1], p) <= r2) return true;
  }
  return false;
}

/**
 * Ids of the strokes and shapes a scribble erases: bounds overlap the gesture and a scribble point
 * comes within half the element's width + 6 screen px of one of its segments. Text boxes, tables,
 * images and other boxed content are never erased by a scribble.
 */
export function scribbleHits(
  elements: ReadonlyMap<string, Element>,
  index: SpatialIndex,
  points: readonly Point[],
  zoom: number,
): string[] {
  if (points.length === 0) return [];
  const box = bboxOf(points);
  const slop = HIT_SLOP_PX / zoom;
  const out: string[] = [];
  for (const id of index.query(box)) {
    const el = elements.get(id);
    if (!el || (el.type !== "stroke" && el.type !== "shape")) continue;
    if (!rectsOverlap(elementBounds(el), box)) continue;
    const reach = el.width / 2 + slop;
    const hit = el.type === "stroke" ? touches(points, el.points, reach) : shapeElementOutline(el).some((poly) => touches(points, poly, reach));
    if (hit) out.push(id);
  }
  return out;
}
