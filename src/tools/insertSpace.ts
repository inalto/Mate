// Insert-space tool (pure): which elements move when a horizontal line is dragged, and by how much.
import { isPdfPlacement } from "../model/content";
import type { Element } from "../model/types";
import { translateElements } from "./lasso";
import { elementBounds, isBoxed } from "./spatialIndex";

export interface SpaceOptions {
  /** Boxed elements straddling the line move too (otherwise only elements fully below it move). */
  cutImages: boolean;
  /** Largest allowed bottom edge after an insertion (page mode); unbounded when absent. */
  maxBottom?: number;
}

/** True when `el` moves with the content below `lineY`. PDF-backed placements are locked. */
function moves(el: Element, lineY: number, cutImages: boolean): boolean {
  if (isPdfPlacement(el)) return false;
  const b = elementBounds(el);
  if (b.y >= lineY) return true;
  return cutImages && isBoxed(el) && b.y + b.height > lineY;
}

/** Elements shifted down by `dy` (up when negative) from `lineY`; unaffected ones are returned as is. */
export function shiftBelow(elements: readonly Element[], lineY: number, dy: number, opts: SpaceOptions): Element[] {
  if (dy === 0) return [...elements];
  return elements.map((el) => (moves(el, lineY, opts.cutImages) ? translateElements([el], 0, dy)[0] : el));
}

/** `dy` limited so removal never pulls content over the line and insertion stays within `maxBottom`. */
export function clampShift(elements: readonly Element[], lineY: number, dy: number, opts: SpaceOptions): number {
  if (dy < 0) {
    let gap = Infinity;
    for (const el of elements) {
      if (!moves(el, lineY, opts.cutImages)) continue;
      const top = elementBounds(el).y;
      if (top >= lineY) gap = Math.min(gap, top - lineY);
    }
    return gap === Infinity ? 0 : Math.max(dy, -gap);
  }
  if (opts.maxBottom === undefined) return dy;
  let room = Infinity;
  for (const el of elements) {
    if (!moves(el, lineY, opts.cutImages)) continue;
    const b = elementBounds(el);
    room = Math.min(room, opts.maxBottom - (b.y + b.height));
  }
  return Math.min(dy, Math.max(0, room));
}
