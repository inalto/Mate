// Horizontal / vertical snap for straight lines (pure): a line drawn within a few degrees of an
// axis lands exactly on it. Used by straight-lines ink, ink-to-shape lines and line endpoint drags.
import type { Vec2 } from "../canvas/camera";

/** A line this close to horizontal or vertical snaps onto the axis. */
export const AXIS_SNAP_RAD = (4 * Math.PI) / 180;

/** `end`, moved onto the horizontal or vertical through `start` when the line is within `tol` of it. */
export function snapLineEnd(start: Vec2, end: Vec2, tol = AXIS_SNAP_RAD): Vec2 {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return { x: end.x, y: end.y };
  const a = Math.abs(Math.atan2(dy, dx)); // 0..π
  if (a <= tol || Math.PI - a <= tol) return { x: end.x, y: start.y };
  if (Math.abs(a - Math.PI / 2) <= tol) return { x: start.x, y: end.y };
  return { x: end.x, y: end.y };
}
