// Eraser hit-testing (pure). Stroke mode removes any touched element; partial mode cuts strokes
// where they enter/leave the eraser circle. Shapes are hit along their outline (or anywhere inside
// when filled); partial mode turns a touched shape outline into stroke fragments. Text boxes,
// tables, code blocks and graphs are never erased.
import { isPdfPlacement } from "../model/content";
import type { Element, Point } from "../model/types";
import type { Vec2 } from "../canvas/camera";
import { hasFill, isClosedShape, isFilledCap, shapeElementOutline, shapeHit } from "../shapes/geometry";
import { contentMeta, elementBounds, type SpatialIndex } from "./spatialIndex";

export type EraseMode = "stroke" | "partial";

export interface EraseOptions {
  eraseShapes: boolean;
  eraseImages: boolean;
  /** Id generator for split fragments (default crypto.randomUUID). */
  newId?: () => string;
  /** Timestamp for fragments' updatedAt (default now). */
  now?: string;
}

export interface EraseResult {
  removed: string[];
  replaced: { removedId: string; parts: Element[] }[];
}

function erasable(el: Element, opts: EraseOptions): boolean {
  switch (el.type) {
    case "stroke":
      return true;
    case "shape":
      return opts.eraseShapes;
    case "image":
      return opts.eraseImages && !isPdfPlacement(el); // PDF pages are locked
    case "media":
      return opts.eraseImages;
    default:
      return false; // text-box, table, codespace, graph and other structured content are never erased
  }
}

/** Squared distance from `c` to segment ab. */
function segDist2(a: Vec2, b: Vec2, c: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t * dx - c.x;
  const y = a.y + t * dy - c.y;
  return x * x + y * y;
}

/** True when any segment of `pts` comes within `r` of `c`. */
export function polylineTouches(pts: Point[], c: Vec2, r: number): boolean {
  const r2 = r * r;
  if (pts.length === 1) return segDist2(pts[0], pts[0], c) <= r2;
  for (let i = 0; i + 1 < pts.length; i++) if (segDist2(pts[i], pts[i + 1], c) <= r2) return true;
  return false;
}

function rectTouches(el: Element, c: Vec2, r: number): boolean {
  const b = elementBounds(el);
  const x = Math.max(b.x, Math.min(c.x, b.x + b.width));
  const y = Math.max(b.y, Math.min(c.y, b.y + b.height));
  return (x - c.x) ** 2 + (y - c.y) ** 2 <= r * r;
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    ...a,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t,
    timestamp: a.timestamp + (b.timestamp - a.timestamp) * t,
  };
}

const CUT = null;

/**
 * Split a polyline by a circle. Returns null when untouched, else the outside fragments (each ≥ 2
 * points; shorter fragments are dropped). Boundary crossings are inserted as fragment endpoints.
 */
export function splitPolyline(pts: Point[], c: Vec2, r: number): Point[][] | null {
  const r2 = r * r;
  const inside = (p: Vec2) => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 < r2;
  const tokens: (Point | null)[] = [];
  let cut = false;
  const emit = (p: Point | null) => {
    if (p === CUT) cut = true;
    tokens.push(p);
  };
  emit(inside(pts[0]) ? CUT : pts[0]);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const A = dx * dx + dy * dy;
    if (A > 0) {
      const fx = a.x - c.x;
      const fy = a.y - c.y;
      const B = 2 * (fx * dx + fy * dy);
      const C = fx * fx + fy * fy - r2;
      const disc = B * B - 4 * A * C;
      if (disc > 0) {
        const sq = Math.sqrt(disc);
        const t0 = (-B - sq) / (2 * A);
        const t1 = (-B + sq) / (2 * A);
        if (t0 > 0 && t0 < 1) {
          tokens.push(lerpPoint(a, b, t0));
          emit(CUT);
        }
        if (t1 > 0 && t1 < 1) {
          emit(CUT);
          tokens.push(lerpPoint(a, b, t1));
        }
      }
    }
    emit(inside(b) ? CUT : b);
  }
  if (!cut) return null;
  const frags: Point[][] = [];
  let cur: Point[] = [];
  for (const t of tokens) {
    if (t === CUT) {
      if (cur.length >= 2) frags.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length >= 2) frags.push(cur);
  return frags;
}

/** Split a closed polyline; the fragments either side of its start/end point join into one. */
function splitClosed(pts: Point[], c: Vec2, r: number): Point[][] | null {
  const frags = splitPolyline(pts, c, r);
  if (!frags || frags.length < 2) return frags;
  const first = frags[0];
  const last = frags[frags.length - 1];
  if (first[0] !== pts[0] || last[last.length - 1] !== pts[pts.length - 1]) return frags;
  return [[...last, ...first.slice(1)], ...frags.slice(1, -1)];
}

/**
 * Partial erase of a shape: its outline polylines are cut like strokes. Null when untouched, else
 * the remaining pieces (untouched polylines whole) as plain pen strokes in the shape's colour/width.
 */
function splitShape(el: Element, c: Vec2, reach: number): Point[][] | null {
  const closed = isClosedShape(el.shapeType ?? "rectangle");
  let touched = false;
  const out: Point[][] = [];
  shapeElementOutline(el).forEach((poly, i) => {
    const pts = poly.map((v, k): Point => ({ x: v.x, y: v.y, pressure: 0.5, timestamp: k }));
    // The main outline of closed shapes and filled line caps (arrow heads, dots) are closed polylines.
    const frags = closed || (i > 0 && isFilledCap(poly)) ? splitClosed(pts, c, reach) : splitPolyline(pts, c, reach);
    if (frags) touched = true;
    out.push(...(frags ?? [pts]));
  });
  return touched ? out : null;
}

/** A stroke element carrying a shape fragment (fill, box and rotation are dropped). */
function shapeFragment(el: Element, points: Point[], id: string, now: string): Element {
  const { shapeType: _t, fillColor: _f, boxWidth: _w, boxHeight: _h, content: _c, ...rest } = el;
  const z = contentMeta(el).zIndex;
  return {
    ...rest,
    id,
    type: "stroke",
    penStyle: "pen",
    isHighlighter: false,
    points,
    ...(z !== undefined ? { content: { zIndex: z } } : {}),
    updatedAt: now,
    version: 0,
  };
}

/**
 * Erase at `center` with `radiusUnits` (world units, already zoom-compensated by the caller).
 * A stroke is hit when any segment comes within radius + width/2.
 */
export function eraseAt(
  elements: ReadonlyMap<string, Element>,
  index: SpatialIndex,
  center: Vec2,
  radiusUnits: number,
  mode: EraseMode,
  opts: EraseOptions,
): EraseResult {
  const result: EraseResult = { removed: [], replaced: [] };
  const r = radiusUnits;
  const ids = index.query({ x: center.x - r, y: center.y - r, width: 2 * r, height: 2 * r });
  const newId = opts.newId ?? (() => crypto.randomUUID());
  for (const id of ids) {
    const el = elements.get(id);
    if (!el || el.points.length === 0 || !erasable(el, opts)) continue;
    if (el.type === "shape") {
      if (mode === "stroke") {
        if (shapeHit(el, center, r, hasFill(el.fillColor))) result.removed.push(id);
        continue;
      }
      const frags = splitShape(el, center, r + el.width / 2);
      if (!frags) {
        // Rubbing the inside of a filled shape erases it whole (there is no outline to cut there).
        if (hasFill(el.fillColor) && shapeHit(el, center, r)) result.removed.push(id);
        continue;
      }
      if (frags.length === 0) {
        result.removed.push(id);
        continue;
      }
      const now = opts.now ?? new Date().toISOString();
      result.replaced.push({ removedId: id, parts: frags.map((points) => shapeFragment(el, points, newId(), now)) });
      continue;
    }
    if (el.type !== "stroke") {
      if (rectTouches(el, center, r)) result.removed.push(id);
      continue;
    }
    const reach = r + el.width / 2;
    if (mode === "stroke" || el.points.length === 1) {
      if (polylineTouches(el.points, center, reach)) result.removed.push(id);
      continue;
    }
    const frags = splitPolyline(el.points, center, reach);
    if (!frags) continue;
    if (frags.length === 0) {
      result.removed.push(id);
      continue;
    }
    const now = opts.now ?? new Date().toISOString();
    result.replaced.push({
      removedId: id,
      parts: frags.map((points) => ({ ...el, id: newId(), points, updatedAt: now, version: 0 })),
    });
  }
  return result;
}
