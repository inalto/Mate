// Shape geometry (pure): outlines as polylines, drag-to-shape, bounds and hit-testing.
// A shape element stores two anchor points: rectangle-like types `points[0]` top-left and
// `points[1]` bottom-right of their box; line/arrow the start and end. `boxWidth/boxHeight` are the
// box size, `content.rotation` turns the outline about the box centre.
import type { Vec2 } from "../canvas/camera";
import { contentOf, effectiveCaps, type LineCap, type LineCaps, type ShapeContent } from "../model/content";
import type { Element, Point, Settings, ShapeType } from "../model/types";

export interface ShapeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OutlineOptions {
  /** Side count of the generic `polygon` type (default 6). */
  sides?: number;
  /** Arrow head length (default 12). */
  headLength?: number;
  /** Line/arrow end caps (default: an arrow ends in a head, a line has none). */
  caps?: LineCaps;
  /** Stroke width that sizes dot and bar caps (default 1). */
  capWidth?: number;
}

/** Anchor points and box size of a shape (see `shapeFromDrag`). */
export interface ShapeDrag {
  points: Point[];
  boxWidth: number;
  boxHeight: number;
}

/** Shape style chosen in the shape menu (settings `defaultShape*`). */
export interface ShapeStyle {
  shapeType: ShapeType;
  color: string;
  fillColor: string;
  width: number;
  fillOpacity: number;
}

/** The shape tool's current style (settings `defaultShape*`). */
export const shapeStyleOf = (cfg: Settings): ShapeStyle => ({
  shapeType: cfg.defaultShapeType,
  color: cfg.defaultShapeStrokeColor,
  fillColor: cfg.defaultShapeFillColor,
  width: cfg.defaultShapeStrokeWidth,
  fillOpacity: cfg.defaultShapeFillOpacity,
});

export const ELLIPSE_SEGMENTS = 64;
const STAR_INNER_RATIO = 0.5;
const DEFAULT_POLYGON_SIDES = 6;
const ARROW_HEAD_ANGLE = Math.PI / 6;

/** False for the open types (line, arrow), which have no interior and are never filled. */
export const isClosedShape = (t: ShapeType): boolean => t !== "line" && t !== "arrow";

/** Arrow head length for a stroke width. */
export const arrowHeadLength = (strokeWidth: number): number => Math.max(12, 4 * strokeWidth);

/** True when `fillColor` paints anything (not empty, "none" or "transparent"). */
export const hasFill = (fillColor: string | undefined): fillColor is string =>
  !!fillColor && fillColor !== "none" && fillColor !== "transparent";

const normalize = (r: ShapeRect): ShapeRect => ({
  x: Math.min(r.x, r.x + r.width),
  y: Math.min(r.y, r.y + r.height),
  width: Math.abs(r.width),
  height: Math.abs(r.height),
});

/** Closed copy of `pts` (first point repeated at the end). */
const close = (pts: Vec2[]): Vec2[] => (pts.length > 0 ? [...pts, { ...pts[0] }] : pts);

/** Regular polygon / star vertices (unit circle, first vertex at the top), scaled to fill `r`. */
function fitted(r: ShapeRect, verts: Vec2[]): Vec2[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of verts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const sx = maxX > minX ? r.width / (maxX - minX) : 0;
  const sy = maxY > minY ? r.height / (maxY - minY) : 0;
  return verts.map((p) => ({ x: r.x + (p.x - minX) * sx, y: r.y + (p.y - minY) * sy }));
}

function regular(n: number, inner?: number): Vec2[] {
  const count = inner === undefined ? n : n * 2;
  const out: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const rad = inner !== undefined && i % 2 === 1 ? inner : 1;
    out.push({ x: rad * Math.cos(a), y: rad * Math.sin(a) });
  }
  return out;
}

/** Closed triangle at the end of start→end (tip first); empty for a zero-length arrow. */
export function arrowHead(start: Vec2, end: Vec2, length: number): Vec2[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [];
  const ux = dx / len;
  const uy = dy / len;
  const back = length * Math.cos(ARROW_HEAD_ANGLE);
  const side = length * Math.sin(ARROW_HEAD_ANGLE);
  const bx = end.x - ux * back;
  const by = end.y - uy * back;
  return close([
    { x: end.x, y: end.y },
    { x: bx - uy * side, y: by + ux * side },
    { x: bx + uy * side, y: by - ux * side },
  ]);
}

const DOT_SEGMENTS = 16;

/** Dot cap radius for a stroke width. */
export const dotCapRadius = (strokeWidth: number): number => Math.max(3, 1.5 * strokeWidth);

/** Bar cap length for a stroke width. */
export const barCapLength = (strokeWidth: number): number => Math.max(10, 3 * strokeWidth);

/**
 * Outline of one line cap at `at`, `dir` the unit direction pointing out of the line there: arrow
 * is a closed triangle (tip first), dot a closed 16-segment circle, bar an open two-point segment
 * across the line. Empty for `none`, and for arrow/bar without a direction (zero-length line).
 */
export function capOutline(kind: LineCap, at: Vec2, dir: Vec2, width: number, headLength = arrowHeadLength(width)): Vec2[] {
  const hasDir = dir.x !== 0 || dir.y !== 0;
  switch (kind) {
    case "arrow":
      return hasDir ? arrowHead({ x: at.x - dir.x, y: at.y - dir.y }, at, headLength) : [];
    case "dot": {
      const r = dotCapRadius(width);
      const pts: Vec2[] = [];
      for (let i = 0; i < DOT_SEGMENTS; i++) {
        const a = (i * 2 * Math.PI) / DOT_SEGMENTS;
        pts.push({ x: at.x + r * Math.cos(a), y: at.y + r * Math.sin(a) });
      }
      return close(pts);
    }
    case "bar": {
      if (!hasDir) return [];
      const h = barCapLength(width) / 2;
      return [
        { x: at.x - dir.y * h, y: at.y + dir.x * h },
        { x: at.x + dir.y * h, y: at.y - dir.x * h },
      ];
    }
    default:
      return [];
  }
}

/** True for cap polylines painted as a filled area (arrow, dot), false for stroked ones (bar). */
export const isFilledCap = (poly: readonly Vec2[]): boolean => poly.length > 2;

function rotate(polys: Vec2[][], c: Vec2, rad: number): Vec2[][] {
  if (!rad) return polys;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return polys.map((poly) =>
    poly.map((p) => {
      const x = p.x - c.x;
      const y = p.y - c.y;
      return { x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos };
    }),
  );
}

/**
 * Outline polylines of a shape. Closed types give one closed polyline (first point repeated) that
 * fills `rect`; circle and ellipse are 64-segment polygons. Line/arrow read `rect` as signed: start
 * (x, y), end (x + width, y + height); after the shaft come the start then the end cap outlines
 * (`opts.caps`, see `capOutline`; by default an arrow gets its head as a closed polyline).
 * `rotation` (radians) turns everything about the rect centre.
 */
export function shapeOutline(type: ShapeType, rect: ShapeRect, rotation = 0, opts: OutlineOptions = {}): Vec2[][] {
  const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  let polys: Vec2[][];
  if (!isClosedShape(type)) {
    const start = { x: rect.x, y: rect.y };
    const end = { x: rect.x + rect.width, y: rect.y + rect.height };
    polys = [[start, end]];
    const caps = opts.caps ?? { start: "none", end: type === "arrow" ? "arrow" : "none" };
    const len = Math.hypot(rect.width, rect.height);
    const dir = len > 0 ? { x: rect.width / len, y: rect.height / len } : { x: 0, y: 0 };
    const width = opts.capWidth ?? 1;
    const head = opts.headLength ?? 12;
    for (const cap of [
      capOutline(caps.start, start, { x: -dir.x, y: -dir.y }, width, head),
      capOutline(caps.end, end, dir, width, head),
    ])
      if (cap.length > 0) polys.push(cap);
  } else {
    const r = normalize(rect);
    const { x, y, width: w, height: h } = r;
    switch (type) {
      case "circle":
      case "ellipse": {
        const pts: Vec2[] = [];
        for (let i = 0; i < ELLIPSE_SEGMENTS; i++) {
          const a = (i * 2 * Math.PI) / ELLIPSE_SEGMENTS;
          pts.push({ x: x + w / 2 + (w / 2) * Math.cos(a), y: y + h / 2 + (h / 2) * Math.sin(a) });
        }
        polys = [close(pts)];
        break;
      }
      case "triangle":
        polys = [close([{ x: x + w / 2, y }, { x: x + w, y: y + h }, { x, y: y + h }])];
        break;
      case "diamond":
        polys = [close([{ x: x + w / 2, y }, { x: x + w, y: y + h / 2 }, { x: x + w / 2, y: y + h }, { x, y: y + h / 2 }])];
        break;
      case "pentagon":
        polys = [close(fitted(r, regular(5)))];
        break;
      case "hexagon":
        polys = [close(fitted(r, regular(6)))];
        break;
      case "star":
        polys = [close(fitted(r, regular(5, STAR_INNER_RATIO)))];
        break;
      case "polygon":
        polys = [close(fitted(r, regular(Math.max(3, Math.round(opts.sides ?? DEFAULT_POLYGON_SIDES)))))];
        break;
      default:
        polys = [close([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }])];
    }
  }
  return rotate(polys, centre, rotation);
}

/** Signed anchor rect of a shape element (see `shapeOutline`). */
export function shapeRectOf(el: Element): ShapeRect {
  const a = el.points[0] ?? { x: 0, y: 0 };
  const b = el.points[1] ?? { x: a.x + (el.boxWidth ?? 0), y: a.y + (el.boxHeight ?? 0) };
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}

type ShapeMeta = ShapeContent & { sides: number };

/** Outline of a shape element, including its rotation and line caps. */
export function shapeElementOutline(el: Element, withRotation = true): Vec2[][] {
  const c = contentOf<ShapeMeta>(el);
  return shapeOutline(el.shapeType ?? "rectangle", shapeRectOf(el), withRotation ? (c.rotation ?? 0) : 0, {
    sides: c.sides,
    headLength: arrowHeadLength(el.width),
    caps: effectiveCaps(el),
    capWidth: el.width,
  });
}

/** Fill opacity of a shape element (content.fillOpacity, default 1, clamped to 0..1). */
export function fillOpacityOf(el: Element): number {
  const v = contentOf<ShapeContent>(el).fillOpacity;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

/** World bounds before rotation: the outline's bbox expanded by half the stroke width. */
export function shapeBounds(el: Element): ShapeRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of shapeElementOutline(el, false))
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  const h = el.width / 2;
  return { x: minX - h, y: minY - h, width: maxX - minX + el.width, height: maxY - minY + el.width };
}

function segDist2(a: Vec2, b: Vec2, c: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2)) : 0;
  return (a.x + t * dx - c.x) ** 2 + (a.y + t * dy - c.y) ** 2;
}

function inside(p: Vec2, poly: readonly Vec2[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/**
 * True when `p` is within `tol` (+ half the stroke width) of the outline, or (with `interior`)
 * inside a closed shape.
 */
export function shapeHit(el: Element, p: Vec2, tol: number, interior = true): boolean {
  const polys = shapeElementOutline(el);
  const r2 = (tol + el.width / 2) ** 2;
  for (const poly of polys) for (let i = 0; i + 1 < poly.length; i++) if (segDist2(poly[i], poly[i + 1], p) <= r2) return true;
  // Filled line caps (arrow head, dot) are solid: hit anywhere inside, not only on the rim.
  for (let k = 1; k < polys.length; k++) if (isFilledCap(polys[k]) && inside(p, polys[k])) return true;
  return interior && isClosedShape(el.shapeType ?? "rectangle") && polys.length > 0 && inside(p, polys[0]);
}

const point = (v: Vec2, i: number): Point => ({ x: v.x, y: v.y, pressure: 0.5, timestamp: i });

const SNAP = Math.PI / 4;

/**
 * Anchor points and box size for a drag from `start` to `end`. `constrain` (Shift) makes boxes
 * square and snaps lines to 45°; a circle is always square.
 */
export function shapeFromDrag(
  type: ShapeType,
  start: Vec2,
  end: Vec2,
  constrain: boolean,
): ShapeDrag {
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  if (!isClosedShape(type)) {
    if (constrain) {
      const len = Math.hypot(dx, dy);
      const a = Math.round(Math.atan2(dy, dx) / SNAP) * SNAP;
      dx = len * Math.cos(a);
      dy = len * Math.sin(a);
      if (Math.abs(dx) < 1e-9) dx = 0;
      if (Math.abs(dy) < 1e-9) dy = 0;
    }
    return {
      points: [point(start, 0), point({ x: start.x + dx, y: start.y + dy }, 1)],
      boxWidth: Math.abs(dx),
      boxHeight: Math.abs(dy),
    };
  }
  if (constrain || type === "circle") {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * s;
    dy = (dy < 0 ? -1 : 1) * s;
  }
  const r = normalize({ x: start.x, y: start.y, width: dx, height: dy });
  return {
    points: [point({ x: r.x, y: r.y }, 0), point({ x: r.x + r.width, y: r.y + r.height }, 1)],
    boxWidth: r.width,
    boxHeight: r.height,
  };
}

/** Re-derive the box after the anchors moved: closed types get top-left/bottom-right anchors again. */
export function normalizeShape(el: Element): Element {
  if (el.points.length === 0) return el;
  const r = shapeRectOf(el);
  if (!isClosedShape(el.shapeType ?? "rectangle")) return { ...el, boxWidth: Math.abs(r.width), boxHeight: Math.abs(r.height) };
  const n = normalize(r);
  const a = el.points[0];
  const b = el.points[1] ?? a;
  return {
    ...el,
    points: [
      { ...a, x: n.x, y: n.y },
      { ...b, x: n.x + n.width, y: n.y + n.height },
    ],
    boxWidth: n.width,
    boxHeight: n.height,
  };
}

/** A new shape element from a drag result and a style. */
export function shapeElement(
  style: ShapeStyle,
  drag: ShapeDrag,
  pageId: string,
  id: string,
  now: string,
): Element {
  return {
    id,
    pageId,
    type: "shape",
    shapeType: style.shapeType,
    points: drag.points,
    color: style.color,
    fillColor: style.fillColor,
    width: style.width,
    isHighlighter: false,
    boxWidth: drag.boxWidth,
    boxHeight: drag.boxHeight,
    content: { fillOpacity: style.fillOpacity },
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}
