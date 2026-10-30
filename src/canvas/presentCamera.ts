// Presentation camera (pure): the camera that shows one frame in the viewport, whole (fit) or
// covering the viewport with the overflow cropped (fill).
import type { Element } from "../model/types";
import { boxRect } from "../tools/spatialIndex";
import { clampZoom, fitBounds, type Camera, type Viewport } from "./camera";

/**
 * Camera for presenting `frame`: fit shows the whole frame centred with `marginPx` on every side;
 * fill zooms until the frame covers the viewport (its shorter side fills it, the rest is cropped),
 * centred, without a margin. Zoom is clamped to 0.1..10.
 */
export function frameCamera(frame: Element, viewport: Viewport, fill: boolean, marginPx = 24): Camera {
  const r = boxRect(frame);
  if (!fill || r.width <= 0 || r.height <= 0) return fitBounds(r, viewport, marginPx);
  const z = clampZoom(Math.max(viewport.width / r.width, viewport.height / r.height));
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  return { x: viewport.width / 2 - cx * z, y: viewport.height / 2 - cy * z, z };
}
