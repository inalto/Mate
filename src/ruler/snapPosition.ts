// Position snap of the ruler (pure). At 0° and 90° only, where background lines and element sides
// are parallel to the edges: the edge nearest a target within the threshold moves onto it, and a
// guide is shown along the matched line.
import type { Camera, Viewport } from "../canvas/camera";
import type { Guide } from "../tools/smartGuides";
import type { Rect } from "../tools/spatialIndex";
import { edgeLine, readoutAngle, translatePose, type RulerPose } from "./pose";

export interface PositionTargets {
  /** The nearest background line across `axis` ("y": a horizontal line), or null. */
  lineNear(axis: "x" | "y", value: number): number | null;
  /** Element bounds: their start, centre and end across the ruler are stops. */
  rects: readonly Rect[];
  /** The pane, for the length of a guide along a background line. */
  viewport: Viewport;
}

const ANGLE_EPS = 1e-6;
const TIE_EPS = 1e-9;

export function snapRulerPosition(
  pose: RulerPose,
  camera: Camera,
  targets: PositionTargets,
  thresholdPx: number,
): { pose: RulerPose; guide: Guide | null } {
  const deg = readoutAngle(pose);
  const horizontal = deg < ANGLE_EPS || deg > 180 - ANGLE_EPS;
  if (!horizontal && Math.abs(deg - 90) >= ANGLE_EPS) return { pose, guide: null };
  // A horizontal ruler snaps y values and draws a horizontal guide (axis "y"), and vice versa.
  const axis = horizontal ? "y" : "x";
  const limit = thresholdPx / camera.z;
  let best: { d: number; at: number; rect: Rect | null } | null = null;
  const consider = (d: number, at: number, rect: Rect | null) => {
    if (!(Math.abs(d) <= limit)) return;
    if (best) {
      const diff = Math.abs(d) - Math.abs(best.d);
      if (diff > TIE_EPS) return;
      // On a tie an element stop wins over a background line.
      if (diff >= -TIE_EPS && (best.rect !== null || rect === null)) return;
    }
    best = { d, at, rect };
  };
  for (const side of [1, -1] as const) {
    const e = edgeLine(pose, camera, side).a[axis];
    const line = targets.lineNear(axis, e);
    if (line !== null) consider(line - e, line, null);
    for (const r of targets.rects) {
      const start = horizontal ? r.y : r.x;
      const size = horizontal ? r.height : r.width;
      for (const stop of [start, start + size / 2, start + size]) consider(stop - e, stop, r);
    }
  }
  if (!best) return { pose, guide: null };
  const { d, at, rect } = best as { d: number; at: number; rect: Rect | null };
  let from: number;
  let to: number;
  if (rect) {
    from = horizontal ? rect.x : rect.y;
    to = from + (horizontal ? rect.width : rect.height);
  } else {
    // The left (or top) of the view in page units; 0 − c rather than −c so 0 stays +0.
    from = (0 - (horizontal ? camera.x : camera.y)) / camera.z;
    to = from + (horizontal ? targets.viewport.width : targets.viewport.height) / camera.z;
  }
  return {
    pose: horizontal ? translatePose(pose, 0, d) : translatePose(pose, d, 0),
    guide: { axis, at, from, to },
  };
}
