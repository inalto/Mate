// Uniform-grid spatial index over element bounds (world units) for eraser / lasso candidate queries.
import type { Element } from "../model/types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const CELL_SIZE = 256;

export const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

/** Element metadata stored in `content` (JSON object): z-order and rotation (radians). */
export function contentMeta(el: Element): { zIndex?: number; rotation?: number } {
  const c = el.content;
  return c !== null && typeof c === "object" && !Array.isArray(c) ? (c as { zIndex?: number; rotation?: number }) : {};
}

/** Merge `patch` into `el.content` when it is an object (or empty); other content is left untouched. */
export function withMeta(el: Element, patch: { zIndex?: number; rotation?: number }): Element {
  const c = el.content;
  if (c !== undefined && c !== null && (typeof c !== "object" || Array.isArray(c))) return el;
  return { ...el, content: { ...((c as object | null) ?? {}), ...patch } };
}

function rotatedBox(r: Rect, rad: number): Rect {
  if (!rad) return r;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = (Math.abs(r.width * cos) + Math.abs(r.height * sin)) / 2;
  const hh = (Math.abs(r.width * sin) + Math.abs(r.height * cos)) / 2;
  return { x: cx - hw, y: cy - hh, width: 2 * hw, height: 2 * hh };
}

/**
 * World bounds: boxed elements (boxWidth/boxHeight) span the box from their first point; others the
 * points' bbox expanded by width/2. `content.rotation` rotates the box about its centre.
 */
export function elementBounds(el: Element): Rect {
  const pts = el.points;
  if (pts.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let r: Rect;
  if (el.boxWidth !== undefined && el.boxHeight !== undefined) {
    r = { x: pts[0].x, y: pts[0].y, width: el.boxWidth, height: el.boxHeight };
  } else {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const h = el.width / 2;
    r = { x: minX - h, y: minY - h, width: maxX - minX + el.width, height: maxY - minY + el.width };
  }
  return rotatedBox(r, contentMeta(el).rotation ?? 0);
}

export class SpatialIndex {
  private readonly cells = new Map<string, Set<string>>();
  private readonly bounds = new Map<string, Rect>();

  private readonly cellSize: number;

  constructor(cellSize = CELL_SIZE) {
    this.cellSize = cellSize;
  }

  static from(elements: Iterable<Element>): SpatialIndex {
    const idx = new SpatialIndex();
    for (const el of elements) idx.insert(el.id, elementBounds(el));
    return idx;
  }

  private forCells(r: Rect, fn: (key: string) => void): void {
    const s = this.cellSize;
    const x0 = Math.floor(r.x / s);
    const x1 = Math.floor((r.x + r.width) / s);
    const y0 = Math.floor(r.y / s);
    const y1 = Math.floor((r.y + r.height) / s);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) fn(`${cx},${cy}`);
  }

  insert(id: string, bounds: Rect): void {
    if (this.bounds.has(id)) this.remove(id);
    this.bounds.set(id, bounds);
    this.forCells(bounds, (k) => {
      let set = this.cells.get(k);
      if (!set) this.cells.set(k, (set = new Set()));
      set.add(id);
    });
  }

  remove(id: string): void {
    const b = this.bounds.get(id);
    if (!b) return;
    this.bounds.delete(id);
    this.forCells(b, (k) => {
      const set = this.cells.get(k);
      if (!set) return;
      set.delete(id);
      if (set.size === 0) this.cells.delete(k);
    });
  }

  clear(): void {
    this.cells.clear();
    this.bounds.clear();
  }

  /** Ids whose bounds overlap `rect`. */
  query(rect: Rect): string[] {
    const out = new Set<string>();
    this.forCells(rect, (k) => {
      const set = this.cells.get(k);
      if (!set) return;
      for (const id of set) if (!out.has(id) && rectsOverlap(this.bounds.get(id)!, rect)) out.add(id);
    });
    return [...out];
  }
}
