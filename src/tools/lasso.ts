// Lasso selection and selection transforms (pure). The loop's direction picks the rule: drawn
// clockwise (as seen on screen) it selects what it encloses ("inside"); anticlockwise it selects
// everything it touches ("touch").
import { isPdfPlacement } from "../model/content";
import type { Element, Point } from "../model/types";
import type { Vec2 } from "../canvas/camera";
import { fillOpacityOf, hasFill, isClosedShape, normalizeShape, shapeElementOutline, shapeRectOf } from "../shapes/geometry";
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

export type LassoMode = "inside" | "touch";

/**
 * Winding of a lasso loop as seen on screen (y-down): "cw" or "ccw", from the shoelace signed area
 * (positive = clockwise in y-down coordinates). Null for fewer than 3 points or a loop whose area is
 * negligible against its perimeter (|area| < 0.0005·P²: a scribble, a back-and-forth line, a
 * balanced figure-eight). A long thin loop around one line of text (1200×30) still counts.
 */
export function lassoDirection(polygon: readonly Vec2[]): "cw" | "ccw" | null {
  const n = polygon.length;
  if (n < 3) return null;
  let twice = 0;
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    twice += a.x * b.y - b.x * a.y;
    perimeter += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const area = twice / 2;
  if (perimeter === 0 || Math.abs(area) < 0.0005 * perimeter * perimeter) return null;
  return area > 0 ? "cw" : "ccw";
}

/** Clockwise (or undecided) loops select what they enclose; anticlockwise ones what they touch. */
export const lassoMode = (polygon: readonly Vec2[]): LassoMode => (lassoDirection(polygon) === "ccw" ? "touch" : "inside");

const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y)
  );
}

/** True when segments ab and cd share a point (collinear overlaps included). */
export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (
    (d1 === 0 && onSegment(c, d, a)) ||
    (d2 === 0 && onSegment(c, d, b)) ||
    (d3 === 0 && onSegment(a, b, c)) ||
    (d4 === 0 && onSegment(a, b, d))
  );
}

/** Corners of a boxed element's rect (closed, rotated by `content.rotation` about its centre). */
function boxPolyline(el: Element): Vec2[] {
  const r = boxRect(el);
  const rad = contentMeta(el).rotation ?? 0;
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
  const pts = rad ? rotatePoints(corners, { x: r.x + r.width / 2, y: r.y + r.height / 2 }, rad) : corners;
  return [...pts, pts[0]];
}

function rotatePoints(pts: readonly Vec2[], c: Vec2, rad: number): Vec2[] {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return pts.map((p) => {
    const x = p.x - c.x;
    const y = p.y - c.y;
    return { x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos };
  });
}

/** The polylines a "touch" lasso tests against: stroke points, shape outlines, box edges. */
function touchPolylines(el: Element): readonly (readonly Vec2[])[] {
  if (isBoxed(el)) return [boxPolyline(el)];
  if (el.type === "shape") return shapeElementOutline(el);
  return [el.points];
}

/** A closed shape painted with a visible fill (as the renderer would fill it). */
const isFilledShape = (el: Element): boolean =>
  el.type === "shape" && isClosedShape(el.shapeType ?? "rectangle") && hasFill(el.fillColor) && fillOpacityOf(el) > 0;

/** Bounds of a polyline segment miss `r` (cheap rejection before the exact crossing test). */
const segmentMisses = (a: Vec2, b: Vec2, r: Rect): boolean =>
  Math.max(a.x, b.x) < r.x ||
  Math.min(a.x, b.x) > r.x + r.width ||
  Math.max(a.y, b.y) < r.y ||
  Math.min(a.y, b.y) > r.y + r.height;

/**
 * Any point inside, any segment crossing the (closed) lasso, or the lasso drawn inside a boxed
 * element's rect or a filled shape. `bounds` is the lasso's bbox (segments missing it are skipped).
 */
function touches(el: Element, polygon: readonly Vec2[], bounds: Rect): boolean {
  const lines = touchPolylines(el);
  for (const line of lines) for (const p of line) if (pointInPolygon(p, polygon)) return true;
  const n = polygon.length;
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      if (segmentMisses(a, b, bounds)) continue;
      for (let j = 0; j < n; j++) if (segmentsIntersect(a, b, polygon[j], polygon[(j + 1) % n])) return true;
    }
  }
  // No crossing and no vertex inside: the lasso is either wholly outside or wholly inside the
  // element's outline, which counts for a box or a filled shape (not for an empty ring).
  return (isBoxed(el) || isFilledShape(el)) && lines.length > 0 && pointInPolygon(polygon[0], lines[0]);
}

/**
 * Ids of the elements the lasso picks. "inside" (clockwise loop): bbox centre inside `polygon` or
 * ≥ 50 % of the points inside. "touch" (anticlockwise loop): any point inside, any segment of the
 * element's polyline (strokes: points; shapes: outline; boxed elements: box edges) crossing the
 * lasso, or the lasso drawn entirely within a boxed element or a filled shape. PDF placements are never selected.
 */
export function lassoSelect(
  elements: ReadonlyMap<string, Element>,
  index: SpatialIndex,
  polygon: readonly Vec2[],
  mode: LassoMode = "inside",
): string[] {
  if (polygon.length < 3) return [];
  const bounds = polygonBounds(polygon);
  if (bounds.width === 0 && bounds.height === 0) return [];
  const out: string[] = [];
  for (const id of index.query(bounds)) {
    const el = elements.get(id);
    if (!el || el.points.length === 0 || isPdfPlacement(el)) continue;
    if (mode === "touch") {
      if (touches(el, polygon, bounds)) out.push(id);
      continue;
    }
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
 * Scale about `origin`. Strokes and shapes: points map, width scales by the geometric mean (shape
 * anchors are re-normalised, see shapes/geometry). Boxed elements: the box maps (normalised, so a
 * mirrored drag keeps a top-left anchor); images keep their aspect (geometric-mean factor) with
 * the corner nearest `origin` fixed.
 */
export function scaleElements(els: readonly Element[], origin: Vec2, sx: number, sy: number): Element[] {
  const k = Math.sqrt(Math.abs(sx * sy));
  const mx = (x: number) => origin.x + (x - origin.x) * sx;
  const my = (y: number) => origin.y + (y - origin.y) * sy;
  return els.map((el) => {
    if (isBoxed(el)) return scaleBox(el, mx, my, origin, k);
    const out = mapPoints(el, (p) => ({ x: mx(p.x), y: my(p.y) }));
    out.width = el.width * k;
    return el.type === "shape" ? normalizeShape(out) : out;
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
  if (el.type === "image" || el.type === "media") {
    out.width = r.width;
    out.height = r.height;
  } else {
    out.boxWidth = r.width;
    out.boxHeight = r.height;
  }
  return out;
}

/**
 * Rotate points about `centre`; boxed elements also accumulate `content.rotation`. Box-like shapes
 * move their box centre and accumulate `content.rotation` (lines and arrows rotate their points).
 */
export function rotateElements(els: readonly Element[], centre: Vec2, rad: number): Element[] {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return els.map((el) => {
    if (el.type === "shape" && isClosedShape(el.shapeType ?? "rectangle")) {
      const b = shapeRectOf(el);
      const cx = b.x + b.width / 2 - centre.x;
      const cy = b.y + b.height / 2 - centre.y;
      const dx = centre.x + cx * cos - cy * sin - (b.x + b.width / 2);
      const dy = centre.y + cx * sin + cy * cos - (b.y + b.height / 2);
      const moved = mapPoints(el, (p) => ({ x: p.x + dx, y: p.y + dy }));
      return withMeta(moved, { rotation: (contentMeta(el).rotation ?? 0) + rad });
    }
    const out = mapPoints(el, (p) => {
      const x = p.x - centre.x;
      const y = p.y - centre.y;
      return { x: centre.x + x * cos - y * sin, y: centre.y + x * sin + y * cos };
    });
    return isBoxed(el) ? withMeta(out, { rotation: (contentMeta(el).rotation ?? 0) + rad }) : out;
  });
}
