// Pure maths of the graph editor: where its settings panel goes, and the view after a pinch.
import { zoomDomain, type GraphDomain } from "./data";

/** Gap between the box and the settings panel (screen px). */
const PANEL_GAP = 8;

/** Where the settings panel goes: beside the box, or over it when neither side has room. */
export type PanelSide = "left" | "right" | "inside";

/**
 * Place the settings panel (screen px): left of the box when it fits in the pane, else right of it,
 * else over the box; and how far up or down it must shift to stay within the pane's height.
 */
export function placeGraphPanel(
  box: { left: number; right: number; top: number },
  panel: { width: number; height: number },
  pane: { left: number; right: number; top: number; bottom: number },
): { side: PanelSide; dy: number } {
  const side: PanelSide =
    box.left - PANEL_GAP - panel.width >= pane.left ? "left" : box.right + PANEL_GAP + panel.width <= pane.right ? "right" : "inside";
  let dy = 0;
  if (box.top + panel.height > pane.bottom) dy = pane.bottom - (box.top + panel.height);
  if (box.top + dy < pane.top) dy = pane.top - box.top;
  return { side, dy: Math.round(dy) };
}

/**
 * The view after a two-finger gesture that started on `start`: the fingers were `d0` apart about
 * the box fraction (fx0, fy0) and are now `d1` apart about (fx1, fy1). The point under the fingers
 * stays under them.
 */
export function pinchDomain(start: GraphDomain, d0: number, d1: number, fx0: number, fy0: number, fx1: number, fy1: number): GraphDomain {
  if (!(d0 > 0) || !(d1 > 0)) return start;
  const ax = start.xMin + fx0 * (start.xMax - start.xMin);
  const ay = start.yMax - fy0 * (start.yMax - start.yMin);
  const z = zoomDomain(start, d0 / d1, ax, ay);
  const dx = (fx1 - fx0) * (z.xMax - z.xMin);
  const dy = (fy1 - fy0) * (z.yMax - z.yMin);
  return { xMin: z.xMin - dx, xMax: z.xMax - dx, yMin: z.yMin + dy, yMax: z.yMax + dy };
}
