/** Pan momentum: a finger flick keeps the page gliding, decaying until it stops. */
import type { Vec2 } from "./camera";

export const MIN_FLING_SPEED = 0.05;
export const FLING_STOP_SPEED = 0.02;
/** Velocity retained per 16 ms. */
export const FLING_DECAY = 0.95;
/** Longest frame step honoured, so a stalled or backgrounded frame cannot cause a jump. */
export const MAX_FRAME_MS = 50;

/** Pointer velocity (px/ms) over the samples within `windowMs` of `now`. */
export function releaseVelocity(samples: { x: number; y: number; t: number }[], now: number, windowMs = 80): Vec2 {
  // The last sample before the window anchors it, so a sparse stream still yields a displacement.
  const from = samples.findIndex((s) => s.t >= now - windowMs);
  if (from < 0) return { x: 0, y: 0 };
  const recent = samples.slice(Math.max(0, from - 1));
  if (recent.length < 2) return { x: 0, y: 0 };
  const first = recent[0];
  const last = recent[recent.length - 1];
  const span = last.t - first.t;
  if (span <= 0) return { x: 0, y: 0 };
  return { x: (last.x - first.x) / span, y: (last.y - first.y) / span };
}

/** One fling frame: the displacement to apply and the decayed velocity, or null once it has stopped. */
export function stepFling(v: Vec2, dtMs: number): { v: Vec2; dx: number; dy: number } | null {
  if (Math.hypot(v.x, v.y) < FLING_STOP_SPEED) return null;
  const k = FLING_DECAY ** (dtMs / 16);
  return { v: { x: v.x * k, y: v.y * k }, dx: v.x * dtMs, dy: v.y * dtMs };
}

/** Runs the fling on animation frames; `apply` returns false when the camera could not move. Returns a canceller. */
export function startFling(
  v: Vec2,
  apply: (dx: number, dy: number) => boolean,
  raf: (cb: (t: number) => void) => number = (cb) => requestAnimationFrame(cb),
): () => void {
  if (Math.hypot(v.x, v.y) < MIN_FLING_SPEED) return () => {};
  let stopped = false;
  let vel = v;
  let prev: number | null = null;
  const frame = (t: number) => {
    if (stopped) return;
    const dt = prev === null ? 16 : Math.min(MAX_FRAME_MS, Math.max(0, t - prev));
    prev = t;
    const step = stepFling(vel, dt);
    if (!step) return;
    vel = step.v;
    if (!apply(step.dx, step.dy)) return;
    raf(frame);
  };
  raf(frame);
  return () => {
    stopped = true;
  };
}

/**
 * The fling's per-frame `apply` over a camera store. It stops as soon as anything else replaces the
 * camera (zoom to fit, frame navigation, jump to sheet, a page load) or the page is no longer ready.
 */
export function cameraFlingApply<C extends { x: number; y: number }>(
  get: () => C,
  set: (c: C) => void,
  pan: (c: C, dx: number, dy: number) => C,
  isReady: () => boolean = () => true,
): (dx: number, dy: number) => boolean {
  let own = get();
  return (dx, dy) => {
    if (get() !== own || !isReady()) return false;
    const n = pan(own, dx, dy);
    if (n.x === own.x && n.y === own.y) return false;
    set(n);
    own = get();
    return true;
  };
}
