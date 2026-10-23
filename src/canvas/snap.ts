// Snap-to-grid (settings.snapToGrid): shape corners, new text boxes and selection moves land on the
// page background's grid. The grid step is the page's `backgroundConfig.spacing` (the same spacing
// the dots/lines/grid backgrounds are drawn with), whatever the background type; 40 when unset.
import type { Vec2 } from "./camera";
import type { Page } from "../model/types";

export const DEFAULT_GRID_SPACING = 40;

/** Grid step (page units) for a page. */
export const gridSpacingOf = (page: Pick<Page, "backgroundConfig"> | null | undefined): number => {
  const s = page?.backgroundConfig?.spacing;
  return typeof s === "number" && s > 0 ? s : DEFAULT_GRID_SPACING;
};

/** Nearest grid intersection to `p`. */
export const snapPoint = (p: Vec2, spacing: number): Vec2 => ({
  x: Math.round(p.x / spacing) * spacing,
  y: Math.round(p.y / spacing) * spacing,
});

/** Move delta adjusted so the anchor (top-left of the moved bounds) lands on the grid. */
export const snapDelta = (anchor: Vec2, delta: Vec2, spacing: number): Vec2 => {
  const t = snapPoint({ x: anchor.x + delta.x, y: anchor.y + delta.y }, spacing);
  return { x: t.x - anchor.x, y: t.y - anchor.y };
};
