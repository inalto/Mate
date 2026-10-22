// Lasso selection and selection transforms (pure).
import type { Element, Point } from "../model/types";
import type { Vec2 } from "../canvas/camera";
import { boxRect, contentMeta, elementBounds, isBoxed, withMeta, type Rect, type SpatialIndex } from "./spatialIndex";

/** Even-odd ray-casting point-in-polygon test. */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function polygonBounds(poly: readonly Vec2[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Ids of elements whose bbox centre is inside `polygon` or with ≥ 50 % of their points inside. */
export function lassoSelect(
  elements: ReadonlyMap<string, Element>,
  index: SpatialIndex,
  polygon: readonly Vec2[],
): string[] {
  if (polygon.length < 3) return [];
  const out: string[] = [];
  for (const id of index.query(polygonBounds(polygon))) {
    const el = elements.get(id);
    if (!el || el.points.length === 0) continue;
    const b = elementBounds(el);
    if (pointInPolygon({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, polygon)) {
      out.push(id);
      continue;
    }
    let n = 0;
    for (const p of el.points) if (pointInPolygon(p, polygon)) n++;
    if (n * 2 >= el.points.length) out.push(id);
  }
  return out;
}

/** Union of the bounds of `ids` (missing ids ignored); null when none exist. */
export function selectionBounds(elements: ReadonlyMap<string, Element>, ids: Iterable<string>): Rect | null {
  let r: Rect | null = null;
  for (const id of ids) {
    const el = elements.get(id);
    if (!el) continue;
    const b = elementBounds(el);
    if (!r) r = b;
    else {
      const x = Math.min(r.x, b.x);
      const y = Math.min(r.y, b.y);
      r = {
        x,
        y,
        width: Math.max(r.x + r.width, b.x + b.width) - x,
        height: Math.max(r.y + r.height, b.y + b.height) - y,
      };
    }
  }
  return r;
}

const mapPoints = (el: Element, fn: (p: Point) => Vec2): Element => ({
  ...el,
  points: el.points.map((p) => ({ ...p, ...fn(p) })),
});

export function translateElements(els: readonly Element[], dx: number, dy: number): Element[] {
  return els.map((el) => mapPoints(el, (p) => ({ x: p.x + dx, y: p.y + dy })));
}

/**
 * Scale about `origin`. Strokes and shapes: points map, width scales by the geometric mean. Boxed
 * elements: the box maps (normalised, so a mirrored drag keeps a top-left anchor); images keep
 * their aspect (geometric-mean factor) with the corner nearest `origin` fixed.
 */
export function scaleElements(els: readonly Element[], origin: Vec2, sx: number, sy: number): Element[] {
  const k = Math.sqrt(Math.abs(sx * sy));
  const mx = (x: number) => origin.x + (x - origin.x) * sx;
  const my = (y: number) => origin.y + (y - origin.y) * sy;
  return els.map((el) => {
    if (isBoxed(el)) return scaleBox(el, mx, my, origin, k);
    const out = mapPoints(el, (p) => ({ x: mx(p.x), y: my(p.y) }));
    out.width = el.width * k;
    return out;
  });
}

function scaleBox(el: Element, mx: (x: number) => number, my: (y: number) => number, origin: Vec2, k: number): Element {
  const b = boxRect(el);
  const x0 = Math.min(mx(b.x), mx(b.x + b.width));
  const x1 = Math.max(mx(b.x), mx(b.x + b.width));
  const y0 = Math.min(my(b.y), my(b.y + b.height));
  const y1 = Math.max(my(b.y), my(b.y + b.height));
  let r: Rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  if (el.type === "image") {
    const w = b.width * k;
    const h = b.height * k;
    const right = Math.abs(origin.x - x1) < Math.abs(origin.x - x0);
    const bottom = Math.abs(origin.y - y1) < Math.abs(origin.y - y0);
    r = { x: right ? x1 - w : x0, y: bottom ? y1 - h : y0, width: w, height: h };
  }
  return withBoxRect(el, r);
}

/** `el` with its box moved/resized to `r` (other points follow the anchor's translation). */
export function withBoxRect(el: Element, r: Rect): Element {
  const a = el.points[0] ?? { x: 0, y: 0 };
  const dx = r.x - a.x;
  const dy = r.y - a.y;
  const out = mapPoints(el, (p) => ({ x: p.x + dx, y: p.y + dy }));
  if (out.points.length === 0) out.points = [{ x: r.x, y: r.y, pressure: 0.5, timestamp: 0 }];
  if (el.type === "image") {
    out.width = r.width;
    out.height = r.height;
  } else {
    out.boxWidth = r.width;
    out.boxHeight = r.height;
  }
  return out;
}

/** Rotate points about `centre`; boxed elements also accumulate `content.rotation`. */
export function rotateElements(els: readonly Element[], centre: Vec2, rad: number): Element[] {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return els.map((el) => {
    const out = mapPoints(el, (p) => {
      const x = p.x - centre.x;
      const y = p.y - centre.y;
      return { x: centre.x + x * cos - y * sin, y: centre.y + x * sin + y * cos };
    });
    return isBoxed(el) ? withMeta(out, { rotation: (contentMeta(el).rotation ?? 0) + rad }) : out;
  });
}
