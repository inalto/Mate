// Wheel / pan / pinch camera maths (pure). Spec 03 §4: Ctrl+wheel zooms at the cursor, plain wheel
// pans (or zooms when scrollBehavior is "zoom" and the device is not a trackpad); wheel panning may
// overscroll up to 60 px with resistance 0.25 and snaps back 50 ms after the last wheel event.
import { panBy, screenToWorld, wheelZoomFactor, zoomAt, clampZoom, type Camera, type Vec2 } from "./camera";

export const OVERSCROLL_MAX = 60;
export const OVERSCROLL_RESISTANCE = 0.25;
export const SNAP_BACK_MS = 50;
const LINE_PX = 16;

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Crude heuristic: a mouse wheel notch is a large vertical-only delta; anything else is a trackpad. */
export function isLikelyTrackpadWheel(e: Pick<WheelLike, "deltaX" | "deltaY">): boolean {
  return !(Math.abs(e.deltaY) >= 50 && e.deltaX === 0);
}

export type WheelAction = { kind: "zoom"; factor: number } | { kind: "pan"; dx: number; dy: number };

/** Decide what a wheel event does. Pan deltas are camera deltas in screen px. */
export function classifyWheel(e: WheelLike, scrollBehavior: string): WheelAction {
  const scale = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? 800 : 1;
  const dx = e.deltaX * scale;
  const dy = e.deltaY * scale;
  if (e.ctrlKey || e.metaKey) return { kind: "zoom", factor: wheelZoomFactor(dy) };
  if (scrollBehavior === "zoom" && !isLikelyTrackpadWheel(e)) return { kind: "zoom", factor: wheelZoomFactor(dy) };
  if (e.shiftKey && dx === 0) return { kind: "pan", dx: -dy, dy: 0 };
  return { kind: "pan", dx: -dx, dy: -dy };
}

const soft = (excess: number) =>
  Math.sign(excess) * Math.min(OVERSCROLL_MAX, Math.abs(excess) * OVERSCROLL_RESISTANCE);

/**
 * Pan with rubber-band overscroll. `cam` may already be overscrolled (from a previous call); the
 * raw excess is recovered from it so repeated wheel events accumulate correctly.
 */
export function overscrollPan(
  cam: Camera,
  dx: number,
  dy: number,
  clamp: (c: Camera) => Camera,
): Camera {
  const base = clamp(cam);
  const rawX = (cam.x - base.x) / OVERSCROLL_RESISTANCE;
  const rawY = (cam.y - base.y) / OVERSCROLL_RESISTANCE;
  const wanted = { x: base.x + rawX + dx, y: base.y + rawY + dy, z: cam.z };
  const bounded = clamp(wanted);
  return { x: bounded.x + soft(wanted.x - bounded.x), y: bounded.y + soft(wanted.y - bounded.y), z: cam.z };
}

/** Apply a wheel event; `focus` is the cursor in element-relative screen px. */
export function applyWheel(
  cam: Camera,
  e: WheelLike,
  focus: Vec2,
  scrollBehavior: string,
  clamp: (c: Camera) => Camera,
): Camera {
  const a = classifyWheel(e, scrollBehavior);
  if (a.kind === "zoom") return clamp(zoomAt(clamp(cam), focus, cam.z * a.factor));
  return overscrollPan(cam, a.dx, a.dy, clamp);
}

/** Hard-clamped drag pan (space / middle button / barrel / one finger). */
export function dragPan(cam: Camera, dx: number, dy: number, clamp: (c: Camera) => Camera): Camera {
  return clamp(panBy(cam, dx, dy));
}

export interface PinchStart {
  camera: Camera;
  mid: Vec2;
  dist: number;
}

/** Pinch: scale = initial·dist/initialDist about the start midpoint, following the midpoint. */
export function pinchCamera(start: PinchStart, mid: Vec2, dist: number): Camera {
  const z = clampZoom(start.camera.z * (dist / start.dist));
  const w = screenToWorld(start.camera, start.mid);
  return { x: mid.x - w.x * z, y: mid.y - w.y * z, z };
}

/** Zoom by a factor about a screen point (toolbar buttons / keyboard use the viewport centre). */
export function zoomBy(cam: Camera, factor: number, focus: Vec2, clamp: (c: Camera) => Camera): Camera {
  return clamp(zoomAt(cam, focus, cam.z * factor));
}
