// Ruler pose geometry (pure). The pose is in page units: the anchor is the zero mark and the angle
// is degrees counter-clockwise as seen on screen. Screen y grows downwards, so the direction is
// (cos a, −sin a) and the positive side (edge 1) is the left-hand normal (−sin a, −cos a).
import { worldToScreen, screenToWorld, type Camera, type Vec2, type Viewport } from "../canvas/camera";

export interface RulerPose {
  x: number;
  y: number;
  angle: number;
}

export const RULER_WIDTH_PX = 110;
export const RULER_RIM_PX = 8;
export const RULER_GUIDE_PX = 16;
export const ANGLE_MAGNET_DEG = 2;

const HALF_WIDTH_PX = RULER_WIDTH_PX / 2;
const RAD = Math.PI / 180;

export interface Line {
  a: Vec2;
  dir: Vec2;
}
export type RulerZone = "body" | 1 | -1 | null;

export function normalizeAngle(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return r === 0 ? 0 : r;
}

export function readoutAngle(pose: RulerPose): number {
  return normalizeAngle(pose.angle) % 180;
}

export function snapRulerAngle(deg: number, step: number): number {
  if (!(step > 0)) return deg;
  const nearest = Math.round(deg / step) * step;
  const magnet = Math.min(ANGLE_MAGNET_DEG, step / 2);
  return Math.abs(deg - nearest) <= magnet ? normalizeAngle(nearest) : deg;
}

export function rulerDir(pose: RulerPose): Vec2 {
  const a = pose.angle * RAD;
  return { x: Math.cos(a), y: -Math.sin(a) };
}

/** Left-hand normal as seen on screen: the positive (edge 1) side. */
function rulerNormal(pose: RulerPose): Vec2 {
  const a = pose.angle * RAD;
  return { x: -Math.sin(a), y: -Math.cos(a) };
}

export function offsetPx(pose: RulerPose, camera: Camera, world: Vec2): number {
  const n = rulerNormal(pose);
  return ((world.x - pose.x) * n.x + (world.y - pose.y) * n.y) * camera.z;
}

export function zoneAt(pose: RulerPose, camera: Camera, world: Vec2): RulerZone {
  const o = offsetPx(pose, camera, world);
  const d = Math.abs(o);
  if (d < HALF_WIDTH_PX - RULER_RIM_PX) return "body";
  if (d <= HALF_WIDTH_PX + RULER_GUIDE_PX) return o >= 0 ? 1 : -1;
  return null;
}

export function edgeLine(pose: RulerPose, camera: Camera, side: 1 | -1): Line {
  const n = rulerNormal(pose);
  const k = (side * HALF_WIDTH_PX) / camera.z;
  return { a: { x: pose.x + n.x * k, y: pose.y + n.y * k }, dir: rulerDir(pose) };
}

export function alongUnits(pose: RulerPose, world: Vec2): number {
  const d = rulerDir(pose);
  return (world.x - pose.x) * d.x + (world.y - pose.y) * d.y;
}

/** Crossings of the centreline with the pane rectangle (screen px), ordered along `rulerDir`. */
export function visibleSpan(pose: RulerPose, camera: Camera, viewport: Viewport): [Vec2, Vec2] | null {
  if (!(viewport.width > 0) || !(viewport.height > 0)) return null;
  const p = worldToScreen(camera, pose);
  const d = rulerDir(pose);
  let t0 = -Infinity;
  let t1 = Infinity;
  // Liang–Barsky against [0, width] × [0, height].
  const clip = (pos: number, dir: number, size: number): boolean => {
    if (Math.abs(dir) < 1e-12) return pos >= 0 && pos <= size;
    const ta = (0 - pos) / dir;
    const tb = (size - pos) / dir;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
    return true;
  };
  if (!clip(p.x, d.x, viewport.width) || !clip(p.y, d.y, viewport.height)) return null;
  if (!(t0 <= t1) || !Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return [
    { x: p.x + d.x * t0, y: p.y + d.y * t0 },
    { x: p.x + d.x * t1, y: p.y + d.y * t1 },
  ];
}

export function defaultPose(camera: Camera, viewport: Viewport): RulerPose {
  const c = screenToWorld(camera, { x: viewport.width / 2, y: viewport.height / 2 });
  return { x: c.x, y: c.y, angle: 0 };
}

export function translatePose(pose: RulerPose, dx: number, dy: number): RulerPose {
  return { x: pose.x + dx, y: pose.y + dy, angle: pose.angle };
}

/** Rigid rotation by `deltaDeg` (counter-clockwise as seen) about a world point. */
export function rotatePose(pose: RulerPose, pivot: Vec2, deltaDeg: number): RulerPose {
  const r = deltaDeg * RAD;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const vx = pose.x - pivot.x;
  const vy = pose.y - pivot.y;
  return {
    x: pivot.x + vx * cos + vy * sin,
    y: pivot.y - vx * sin + vy * cos,
    angle: normalizeAngle(pose.angle + deltaDeg),
  };
}

const circularDistance = (a: number, b: number): number => {
  const d = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(d, 360 - d);
};

/** Rotate about `pivot` to the nearer of `deg` and `deg + 180`, so a typed readout never flips the ruler. */
export function withReadout(pose: RulerPose, deg: number, pivot: Vec2): RulerPose {
  const other = deg + 180;
  const target = circularDistance(deg, pose.angle) <= circularDistance(other, pose.angle) ? deg : other;
  let delta = normalizeAngle(target) - normalizeAngle(pose.angle);
  if (delta > 180) delta -= 360;
  if (delta <= -180) delta += 360;
  return rotatePose(pose, pivot, delta);
}
