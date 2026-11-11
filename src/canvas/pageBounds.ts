// Pure helpers for page mode: sheets stack vertically with PAGE_GAP between them.
// Sheet i occupies y in [i*stride, i*stride + height]; the gap below it is not part of any sheet.
import { PAGE_GAP } from "../model/constants";
import type { Rect } from "../tools/spatialIndex";
import type { SheetStack, Vec2 } from "./camera";

export function sheetRectAt(stack: SheetStack, p: Vec2): Rect | null {
  if (p.y < 0) return null;
  const stride = stack.height + PAGE_GAP;
  const i = Math.floor(p.y / stride);
  if (i >= stack.count) return null;
  const local = p.y - i * stride;
  if (local > stack.height) return null; // in the gap
  if (p.x < 0 || p.x > stack.width) return null;
  return { x: 0, y: i * stride, width: stack.width, height: stack.height };
}

export function clampToRect(p: Vec2, r: Rect): Vec2 {
  return {
    x: Math.min(Math.max(p.x, r.x), r.x + r.width),
    y: Math.min(Math.max(p.y, r.y), r.y + r.height),
  };
}

export const inRect = (p: Vec2, r: Rect): boolean => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/** Where the segment from `a` (in `r`) to `b` (outside it) crosses the edge of `r`. */
export function exitPoint(a: Vec2, b: Vec2, r: Rect): Vec2 {
  let t = 1;
  const cut = (from: number, to: number, min: number, max: number) => {
    if (to < min) t = Math.min(t, (min - from) / (to - from));
    else if (to > max) t = Math.min(t, (max - from) / (to - from));
  };
  cut(a.x, b.x, r.x, r.x + r.width);
  cut(a.y, b.y, r.y, r.y + r.height);
  return clampToRect({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, r);
}

export function clampDeltaToStack(bounds: Rect, delta: Vec2, stack: SheetStack): Vec2 {
  const maxX = stack.width - bounds.width;
  const targetX = bounds.x + delta.x;
  // Wider than the sheet: pin to the left edge.
  const clampedX = maxX < 0 ? 0 : Math.min(Math.max(targetX, 0), maxX);
  const targetY = bounds.y + delta.y;
  const clampedY = Math.max(targetY, 0);
  return { x: clampedX - bounds.x, y: clampedY - bounds.y };
}

export function placeInStack(bounds: Rect, stack: SheetStack): Vec2 {
  return clampDeltaToStack(bounds, { x: 0, y: 0 }, stack);
}
