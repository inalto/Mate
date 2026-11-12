// Wheel / pan / pinch camera maths (pure). Spec 03 §4: Ctrl+wheel zooms at the cursor, plain wheel
// pans (or zooms when scrollBehavior is "zoom" and the device is not a trackpad); wheel panning may
// overscroll up to 60 px with resistance 0.25 and snaps back 50 ms after the last wheel event.
import { PAGE_GAP } from "../model/constants";
import { panBy, screenToWorld, wheelZoomFactor, zoomAt, clampZoom, type Camera, type SheetStack, type Vec2, type Viewport } from "./camera";

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

/** How close (relative) the zoom must be to the fit-width zoom to count as "already fitted". */
const FIT_TOLERANCE = 0.01;

/**
 * Page mode double tap. Unless the sheet already spans the view's width exactly, zoom so it does
 * (in or out), keeping the tapped height in place; when it already does, show the whole sheet under
 * the tap (fit to height, centred). The caller clamps the result.
 */
export function doubleTapFit(cam: Camera, tap: Vec2, viewport: Viewport, stack: SheetStack): Camera {
  if (!(viewport.width > 0) || !(viewport.height > 0) || !(stack.width > 0) || !(stack.height > 0)) return cam;
  const wz = clampZoom(viewport.width / stack.width);
  if (Math.abs(cam.z - wz) > wz * FIT_TOLERANCE) return { x: 0, y: zoomAt(cam, tap, wz).y, z: wz };
  const hz = clampZoom(viewport.height / stack.height);
  const stride = stack.height + PAGE_GAP;
  const i = Math.min(Math.max(0, stack.count - 1), Math.max(0, Math.floor(screenToWorld(cam, tap).y / stride)));
  return { x: (viewport.width - stack.width * hz) / 2, y: -i * stride * hz, z: hz };
}

/** A finger tap: where it landed (element-relative screen px) and when it lifted (ms). */
export interface FingerTap {
  x: number;
  y: number;
  t: number;
}

export const FINGER_TAP_MS = 300;
export const FINGER_TAP_SLOP_PX = 10;
export const FINGER_DOUBLE_TAP_MS = 400;
/** Fingers land less precisely than a pen: the second tap may be this far from the first. */
export const FINGER_DOUBLE_TAP_PX = 40;
/** Two-finger taps are matched by where the first finger landed: looser still. */
export const TWO_FINGER_DOUBLE_TAP_PX = 80;
export const DOUBLE_TAP_ZOOM_FACTOR = 2;

/**
 * The tap a one-finger pan amounts to, or null: lifted within 300 ms of landing and never further
 * than 10 px from where it landed. `samples` are the pan's screen samples (first = landing).
 */
export function fingerTapOf(samples: readonly { x: number; y: number; t: number }[], liftedAt: number): FingerTap | null {
  const first = samples[0];
  if (!first || liftedAt - first.t > FINGER_TAP_MS) return null;
  for (const p of samples) if (Math.hypot(p.x - first.x, p.y - first.y) > FINGER_TAP_SLOP_PX) return null;
  return { x: first.x, y: first.y, t: liftedAt };
}

/**
 * The tap a whole touch gesture amounts to (any number of fingers), or null: every contact lifted
 * within 300 ms of the first landing at `at`, none moved further than 10 px (`travel`).
 */
export function gestureTapOf(at: { x: number; y: number; t: number } | undefined, liftedAt: number, travel: number): FingerTap | null {
  if (!at || liftedAt - at.t > FINGER_TAP_MS || travel > FINGER_TAP_SLOP_PX) return null;
  return { x: at.x, y: at.y, t: liftedAt };
}

/** `next` follows `prev` closely enough in time and place (within `px`) to be a double tap. */
export const isFingerDoubleTap = (prev: FingerTap | null, next: FingerTap, px = FINGER_DOUBLE_TAP_PX): boolean =>
  !!prev && next.t - prev.t <= FINGER_DOUBLE_TAP_MS && Math.hypot(next.x - prev.x, next.y - prev.y) <= px;
