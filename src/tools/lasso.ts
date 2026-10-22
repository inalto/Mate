// Lasso selection and selection transforms (pure).
import type { Element, Point } from "../model/types";
import type { Vec2 } from "../canvas/camera";
import { contentMeta, elementBounds, withMeta, type Rect, type SpatialIndex } from "./spatialIndex";

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

/** Scale about `origin`; stroke width scales by the geometric mean, boxes by |sx|, |sy|. */
export function scaleElements(els: readonly Element[], origin: Vec2, sx: number, sy: number): Element[] {
  const k = Math.sqrt(Math.abs(sx * sy));
  return els.map((el) => {
    const out = mapPoints(el, (p) => ({ x: origin.x + (p.x - origin.x) * sx, y: origin.y + (p.y - origin.y) * sy }));
    out.width = el.width * k;
    if (el.boxWidth !== undefined) out.boxWidth = el.boxWidth * Math.abs(sx);
    if (el.boxHeight !== undefined) out.boxHeight = el.boxHeight * Math.abs(sy);
    return out;
  });
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
    return el.boxWidth !== undefined ? withMeta(out, { rotation: (contentMeta(el).rotation ?? 0) + rad }) : out;
  });
}
