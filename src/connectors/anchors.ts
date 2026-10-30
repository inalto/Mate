// Connector anchors (pure): where a connector end attaches on an element. Each element has four,
// one per side of its rotated bounds: the side midpoint, except on closed shapes, where the ray from
// the centre towards that midpoint meets the outline (the outermost crossing), and on line/arrow
// shapes, whose endpoints are "left"/"right" (the leftmost first) and whose midpoint is "top"/"bottom".
import type { Vec2 } from "../canvas/camera";
import type { Side } from "../model/content";
import type { Element } from "../model/types";
import { isClosedShape, shapeBounds, shapeElementOutline } from "../shapes/geometry";
import { contentMeta, elementBounds, rotatedBox, type Rect } from "../tools/spatialIndex";

export const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

/** Rotated (axis-aligned) bounds an element's anchors sit on. */
export function attachBounds(el: Element): Rect {
  if (el.type === "shape") return rotatedBox(shapeBounds(el), contentMeta(el).rotation ?? 0);
  return elementBounds(el);
}

const midpoints = (b: Rect): Record<Side, Vec2> => ({
  top: { x: b.x + b.width / 2, y: b.y },
  right: { x: b.x + b.width, y: b.y + b.height / 2 },
  bottom: { x: b.x + b.width / 2, y: b.y + b.height },
  left: { x: b.x, y: b.y + b.height / 2 },
});

/** Largest k ≥ 0 with c + k·d on segment ab, or -1 when the ray misses it. */
function rayHit(c: Vec2, d: Vec2, a: Vec2, b: Vec2): number {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const den = d.x * ey - d.y * ex;
  if (Math.abs(den) < 1e-12) return -1;
  const wx = a.x - c.x;
  const wy = a.y - c.y;
  const k = (wx * ey - wy * ex) / den;
  const s = (wx * d.y - wy * d.x) / den;
  return k >= 0 && s >= -1e-9 && s <= 1 + 1e-9 ? k : -1;
}

/** The outermost point where the ray from `c` through `m` crosses `poly`, else `m`. */
function onOutline(c: Vec2, m: Vec2, poly: readonly Vec2[]): Vec2 {
  const d = { x: m.x - c.x, y: m.y - c.y };
  let best = -1;
  for (let i = 0; i + 1 < poly.length; i++) best = Math.max(best, rayHit(c, d, poly[i], poly[i + 1]));
  return best >= 0 ? { x: c.x + d.x * best, y: c.y + d.y * best } : m;
}

/** The four anchors of `el` (see the module comment). */
export function anchors(el: Element): Record<Side, Vec2> {
  const b = attachBounds(el);
  const mid = midpoints(b);
  if (el.type !== "shape") return mid;
  const [main] = shapeElementOutline(el);
  if (!main || main.length < 2) return mid;
  if (!isClosedShape(el.shapeType ?? "rectangle")) {
    const [p, q] = main;
    const [left, right] = p.x < q.x || (p.x === q.x && p.y <= q.y) ? [p, q] : [q, p];
    const centre = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    return { top: centre, right: { ...right }, bottom: { ...centre }, left: { ...left } };
  }
  const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  return {
    top: onOutline(c, mid.top, main),
    right: onOutline(c, mid.right, main),
    bottom: onOutline(c, mid.bottom, main),
    left: onOutline(c, mid.left, main),
  };
}

export const anchorPoint = (el: Element, side: Side): Vec2 => anchors(el)[side];

/** The side whose anchor is nearest `towards` (ties go to the first in SIDES order). */
export function resolveSide(el: Element, towards: Vec2): Side {
  const a = anchors(el);
  let best: Side = "top";
  let bestD = Infinity;
  for (const s of SIDES) {
    const d = Math.hypot(a[s].x - towards.x, a[s].y - towards.y);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** The anchor nearest `p` within `maxDist` (page units), else null. */
export function nearestAnchor(el: Element, p: Vec2, maxDist: number): { side: Side; point: Vec2 } | null {
  const a = anchors(el);
  let out: { side: Side; point: Vec2 } | null = null;
  let bestD = maxDist;
  for (const s of SIDES) {
    const d = Math.hypot(a[s].x - p.x, a[s].y - p.y);
    if (d <= bestD) {
      bestD = d;
      out = { side: s, point: a[s] };
    }
  }
  return out;
}
