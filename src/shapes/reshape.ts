// Reshaping by handles (pure). A closed polygon has a handle on each corner (a moved corner makes
// the outline free-form: `content.vertices`); a circle or ellipse has four, on the ends of its two
// axes (a stretched circle becomes an ellipse); a curve snapped from ink has three: its two ends
// and its middle. Each handle knows where it is and what the element becomes when it is dragged
// to a point. Lines and arrows keep their own end handles (toolInteractions).
import type { Vec2 } from "../canvas/camera";
import { contentOf, type ShapeContent } from "../model/content";
import type { Element, Point } from "../model/types";
import { isPolygonType, shapeElementOutline, shapeRectOf, type ShapeRect } from "./geometry";

export interface ReshapeHandle {
  /** Where the handle is (world). */
  at: Vec2;
  /** The element with this handle dragged to world point `p`. */
  apply(p: Vec2): Element;
}

const rotated = (p: Vec2, c: Vec2, rad: number): Vec2 => {
  if (!rad) return { x: p.x, y: p.y };
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const x = p.x - c.x;
  const y = p.y - c.y;
  return { x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos };
};

const boxOf = (el: Element): ShapeRect => {
  const r = shapeRectOf(el);
  return { x: Math.min(r.x, r.x + r.width), y: Math.min(r.y, r.y + r.height), width: Math.abs(r.width), height: Math.abs(r.height) };
};
const centreOf = (r: ShapeRect): Vec2 => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const rotationOf = (el: Element): number => contentOf<ShapeContent & { rotation: number }>(el).rotation ?? 0;

/** An ink stroke that ink-to-shape turned into a smooth curve (it keeps three handles). */
export const isCurveStroke = (el: Element | undefined): boolean =>
  !!el && el.type === "stroke" && contentOf<{ curve: boolean }>(el).curve === true && el.points.length >= 3;

/**
 * `el` with its unrotated box replaced by `box` (the box of the reshaped outline in the frame that
 * turns about the old centre `c0`): the box is shifted so that, turned about its own new centre,
 * every point stays where the drag put it.
 */
function reboxed(el: Element, box: ShapeRect, c0: Vec2, rad: number, extra: Partial<Element> = {}): Element {
  const c1 = centreOf(box);
  const d = { x: c0.x - c1.x, y: c0.y - c1.y };
  const rd = rotated(d, { x: 0, y: 0 }, rad);
  const x = box.x + d.x - rd.x;
  const y = box.y + d.y - rd.y;
  const a = el.points[0] ?? { x: 0, y: 0, pressure: 0.5, timestamp: 0 };
  const b = el.points[1] ?? { ...a, timestamp: 1 };
  return {
    ...el,
    ...extra,
    points: [
      { ...a, x, y },
      { ...b, x: x + box.width, y: y + box.height },
    ],
    boxWidth: box.width,
    boxHeight: box.height,
  };
}

function polygonHandles(el: Element): ReshapeHandle[] {
  const rad = rotationOf(el);
  const c0 = centreOf(boxOf(el));
  const [main] = shapeElementOutline(el, false);
  if (!main || main.length < 4) return [];
  const local = main.slice(0, -1); // the closing point repeats the first
  return local.map((u, k) => ({
    at: rotated(u, c0, rad),
    apply(p: Vec2): Element {
      const q = rotated(p, c0, -rad);
      const pts = local.map((v, i) => (i === k ? q : v));
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const v of pts) {
        x0 = Math.min(x0, v.x);
        y0 = Math.min(y0, v.y);
        x1 = Math.max(x1, v.x);
        y1 = Math.max(y1, v.y);
      }
      const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      const vertices = pts.map((v) => ({ x: (v.x - x0) / (box.width || 1), y: (v.y - y0) / (box.height || 1) }));
      return reboxed(el, box, c0, rad, { content: { ...contentOf<ShapeContent>(el), vertices } });
    },
  }));
}

function roundHandles(el: Element): ReshapeHandle[] {
  const rad = rotationOf(el);
  const r = boxOf(el);
  const c0 = centreOf(r);
  const right = r.x + r.width;
  const bottom = r.y + r.height;
  /** The box with one side moved to the pointer (the opposite side stays). */
  const sides: { at: Vec2; box(q: Vec2): ShapeRect }[] = [
    { at: { x: c0.x, y: r.y }, box: (q) => ({ x: r.x, y: Math.min(q.y, bottom), width: r.width, height: Math.abs(bottom - q.y) }) },
    { at: { x: right, y: c0.y }, box: (q) => ({ x: Math.min(q.x, r.x), y: r.y, width: Math.abs(q.x - r.x), height: r.height }) },
    { at: { x: c0.x, y: bottom }, box: (q) => ({ x: r.x, y: Math.min(q.y, r.y), width: r.width, height: Math.abs(q.y - r.y) }) },
    { at: { x: r.x, y: c0.y }, box: (q) => ({ x: Math.min(q.x, right), y: r.y, width: Math.abs(right - q.x), height: r.height }) },
  ];
  return sides.map((s) => ({
    at: rotated(s.at, c0, rad),
    apply(p: Vec2): Element {
      const box = s.box(rotated(p, c0, -rad));
      // A circle pulled out of round is an ellipse from then on.
      const round = Math.abs(box.width - box.height) < 1e-6;
      return reboxed(el, box, c0, rad, { shapeType: el.shapeType === "circle" && !round ? "ellipse" : el.shapeType });
    },
  }));
}

/** Index of the point halfway along the stroke (by length). */
function middleIndex(pts: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    run += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (run >= total / 2) return i;
  }
  return Math.floor(pts.length / 2);
}

function curveHandles(el: Element): ReshapeHandle[] {
  const pts = el.points;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const mid = pts[middleIndex(pts)];
  /** An end dragged to `p`: the whole curve turns and grows about the other end, keeping its form. */
  const end =
    (moved: Point, fixed: Point) =>
    (p: Vec2): Element => {
      const ox = moved.x - fixed.x;
      const oy = moved.y - fixed.y;
      const len = Math.hypot(ox, oy);
      if (len < 1e-6) return el;
      const k = Math.hypot(p.x - fixed.x, p.y - fixed.y) / len;
      const rad = Math.atan2(p.y - fixed.y, p.x - fixed.x) - Math.atan2(oy, ox);
      const cos = Math.cos(rad) * k;
      const sin = Math.sin(rad) * k;
      return {
        ...el,
        points: pts.map((q) => {
          const x = q.x - fixed.x;
          const y = q.y - fixed.y;
          return { ...q, x: fixed.x + x * cos - y * sin, y: fixed.y + x * sin + y * cos };
        }),
      };
    };
  /** The middle dragged to `p`: the curve becomes the arc through the two ends and `p`. */
  const bend = (p: Vec2): Element => {
    const cx = 2 * p.x - (first.x + last.x) / 2;
    const cy = 2 * p.y - (first.y + last.y) / 2;
    const n = Math.max(25, pts.length | 1); // odd: the middle sample is the handle itself
    const out: Point[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const u = 1 - t;
      out.push({ x: u * u * first.x + 2 * u * t * cx + t * t * last.x, y: u * u * first.y + 2 * u * t * cy + t * t * last.y, pressure: 0.5, timestamp: i });
    }
    return { ...el, points: out };
  };
  return [
    { at: { x: first.x, y: first.y }, apply: end(first, last) },
    { at: { x: mid.x, y: mid.y }, apply: bend },
    { at: { x: last.x, y: last.y }, apply: end(last, first) },
  ];
}

/** The reshape handles of `el` ([] when it has none: lines, arrows, plain ink, boxed elements). */
export function reshapeHandles(el: Element): ReshapeHandle[] {
  if (isCurveStroke(el)) return curveHandles(el);
  if (el.type !== "shape" || el.points.length === 0) return [];
  const type = el.shapeType ?? "rectangle";
  if (type === "circle" || type === "ellipse") return roundHandles(el);
  return isPolygonType(type) ? polygonHandles(el) : [];
}
