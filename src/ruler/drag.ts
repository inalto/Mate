// Moving the ruler with pointers on its body (pure). One pointer translates by its world delta; two
// apply the rigid motion of the pair (the midpoint's delta plus the turn of the line between them,
// about the midpoint, never a scale). The unsnapped pose is kept between moves and only the output
// is snapped, so a slow turn neither sticks at a snap nor drifts.
import { screenToWorld, type Camera, type Vec2 } from "../canvas/camera";
import { normalizeAngle, rotatePose, snapRulerAngle, translatePose, type RulerPose } from "./pose";

export interface RulerDrag {
  /** Starts tracking a pointer; false for a third pointer (it is ignored). */
  down(id: number, screen: Vec2): boolean;
  /** The pose after this pointer moved to `screen` (pane px), or null for an unknown pointer. */
  move(id: number, screen: Vec2): RulerPose | null;
  up(id: number): void;
  count(): number;
}

/** Signed difference b − a in degrees, in (−180, 180]. */
export function angleDelta(a: number, b: number): number {
  let d = normalizeAngle(b - a);
  if (d > 180) d -= 360;
  return d;
}

/** Direction from `a` to `b` in degrees, counter-clockwise as seen (screen y grows downwards). */
export function screenAngle(a: Vec2, b: Vec2): number {
  return (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI;
}

export function createRulerDrag(opts: { pose(): RulerPose; camera(): Camera; angleStep(): number }): RulerDrag {
  const pointers = new Map<number, Vec2>();
  let raw: RulerPose | null = null;

  const restart = () => {
    raw = pointers.size > 0 ? opts.pose() : null;
  };

  return {
    down(id, screen) {
      if (!pointers.has(id) && pointers.size >= 2) return false;
      pointers.set(id, { x: screen.x, y: screen.y });
      restart();
      return true;
    },
    move(id, screen) {
      const prev = pointers.get(id);
      if (!prev || !raw) return null;
      const cam = opts.camera();
      const next = { x: screen.x, y: screen.y };
      if (pointers.size === 1) {
        pointers.set(id, next);
        const a = screenToWorld(cam, prev);
        const b = screenToWorld(cam, next);
        raw = translatePose(raw, b.x - a.x, b.y - a.y);
        return raw;
      }
      let other: Vec2 | null = null;
      for (const [k, p] of pointers) if (k !== id) other = p;
      if (!other) return null;
      pointers.set(id, next);
      const midBefore = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
      const midAfter = { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 };
      const turn = angleDelta(screenAngle(other, prev), screenAngle(other, next));
      const w0 = screenToWorld(cam, midBefore);
      const w1 = screenToWorld(cam, midAfter);
      raw = translatePose(rotatePose(raw, w0, turn), w1.x - w0.x, w1.y - w0.y);
      const snapped = snapRulerAngle(raw.angle, opts.angleStep());
      const fix = angleDelta(raw.angle, snapped);
      return fix === 0 ? raw : rotatePose(raw, w1, fix);
    },
    up(id) {
      if (!pointers.delete(id)) return;
      // The pointer left continues from the pose as it is now (snapped), without a jump.
      restart();
    },
    count: () => pointers.size,
  };
}
