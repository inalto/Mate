// Swipe to turn pages (touch, page mode only). Pure: `detectSwipe` reads a one-finger pan's
// screen-space samples; `canSwipeAt` allows it only once the sheet edge the finger pushes towards is
// already in view, so a pan across the sheet itself is never a page turn (the side overshoot does not
// count as room to scroll).
import { sheetSize, type Camera, type SheetStack, type Viewport } from "./camera";
import type { Page } from "../model/types";

export interface SwipeSample {
  x: number;
  y: number;
  /** Milliseconds (event timeStamp). */
  t: number;
}

export interface SwipeOptions {
  /** Minimum horizontal travel (screen px). */
  minDistance?: number;
  /** |dx| must be at least this multiple of |dy|. */
  axisRatio?: number;
  /** Maximum duration (ms) since the last horizontal direction change. */
  maxDuration?: number;
  /** Minimum average speed (px/ms). */
  minSpeed?: number;
}

export const SWIPE_MIN_DISTANCE = 80;
export const SWIPE_AXIS_RATIO = 2;
export const SWIPE_MAX_DURATION_MS = 600;
export const SWIPE_MIN_SPEED = 0.3;
/** Horizontal moves at or below this (px) do not count as a direction change. */
const JITTER_PX = 1;

/**
 * Direction of a horizontal swipe, measured from the last horizontal direction change to the end:
 * travel ≥ 80 px, |dx| ≥ 2·|dy|, ≤ 600 ms, average speed ≥ 0.3 px/ms. -1 when the finger moved
 * right → left (next page), +1 left → right (previous page), null otherwise.
 */
export function detectSwipe(samples: readonly SwipeSample[], opts: SwipeOptions = {}): -1 | 1 | null {
  const minDistance = opts.minDistance ?? SWIPE_MIN_DISTANCE;
  const axisRatio = opts.axisRatio ?? SWIPE_AXIS_RATIO;
  const maxDuration = opts.maxDuration ?? SWIPE_MAX_DURATION_MS;
  const minSpeed = opts.minSpeed ?? SWIPE_MIN_SPEED;
  const n = samples.length;
  if (n < 2) return null;
  const last = samples[n - 1];
  // Final horizontal direction: the last move that is not jitter.
  let dir = 0;
  for (let i = n - 1; i > 0 && dir === 0; i--) {
    const d = samples[i].x - samples[i - 1].x;
    if (Math.abs(d) > JITTER_PX) dir = Math.sign(d);
  }
  if (dir === 0) return null;
  let start = 0;
  for (let i = n - 1; i > 0; i--) {
    const d = samples[i].x - samples[i - 1].x;
    if (Math.abs(d) > JITTER_PX && Math.sign(d) !== dir) {
      start = i;
      break;
    }
  }
  const first = samples[start];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const duration = last.t - first.t;
  if (Math.abs(dx) < minDistance || Math.abs(dx) < axisRatio * Math.abs(dy)) return null;
  if (duration > maxDuration || Math.abs(dx) / Math.max(duration, 1) < minSpeed) return null;
  return dx < 0 ? -1 : 1;
}

/**
 * True when `page` is in page mode and the sheet edge the finger pushes towards is visible at
 * `camera` (the camera at the start of the pan): for a leftward swipe (dir -1) the sheet's right
 * edge is at or left of the viewport's right side, for a rightward one (dir 1) its left edge is at
 * or right of 0. Both hold when the whole sheet width fits.
 */
export function canSwipeAt(camera: Camera, page: Page, viewport: Viewport, dir: -1 | 1, stack?: SheetStack): boolean {
  if (page.mode !== "page") return false;
  const width = (stack ?? sheetSize(page)).width;
  const left = camera.x;
  const right = camera.x + width * camera.z;
  return dir === -1 ? right <= viewport.width : left >= 0;
}
