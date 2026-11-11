// Closed ink: a pen stroke whose end comes back to its start encloses an area that can be filled
// (`fillColor`, painted under the ink).
import type { Element } from "./types";

/** Closed when the end is within this fraction of the path length from the start. */
const CLOSED_GAP = 0.15;

/** A pen (not highlighter) stroke of at least three points that ends near where it began. */
export function isClosedStroke(el: Element | undefined): el is Element {
  if (!el || el.type !== "stroke" || el.isHighlighter || el.points.length < 3) return false;
  let length = 0;
  for (let i = 1; i < el.points.length; i++) length += Math.hypot(el.points[i].x - el.points[i - 1].x, el.points[i].y - el.points[i - 1].y);
  const a = el.points[0];
  const z = el.points[el.points.length - 1];
  return length > 0 && Math.hypot(z.x - a.x, z.y - a.y) <= CLOSED_GAP * length;
}

/** The fill of a closed stroke, or null when it has none (empty, "none", "transparent", or not closed). */
export function strokeFill(el: Element): string | null {
  const c = el.fillColor?.trim();
  return c && c !== "none" && c !== "transparent" && isClosedStroke(el) ? c : null;
}
