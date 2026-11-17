// The ruler's pointer drag: one pointer translates, two apply the rigid motion of the pair (no
// scaling), the angle snaps about the midpoint, a third pointer is refused.
import { describe, expect, it } from "vitest";
import { screenToWorld, worldToScreen, type Camera, type Vec2 } from "../../canvas/camera";
import { createRulerDrag } from "../drag";
import { offsetPx, type RulerPose } from "../pose";

function harness(start: RulerPose, camera: Camera, step: number) {
  let pose = start;
  const drag = createRulerDrag({ pose: () => pose, camera: () => camera, angleStep: () => step });
  const move = (id: number, p: Vec2) => {
    const next = drag.move(id, p);
    if (next) pose = next;
    return next;
  };
  return { drag, move, pose: () => pose };
}

/** A point `r` screen px from `c` at `deg` counter-clockwise as seen. */
const at = (c: Vec2, r: number, deg: number): Vec2 => ({
  x: c.x + r * Math.cos((deg * Math.PI) / 180),
  y: c.y - r * Math.sin((deg * Math.PI) / 180),
});

describe("createRulerDrag", () => {
  it("translates by the world delta of one pointer and keeps the angle", () => {
    const h = harness({ x: 100, y: 200, angle: 30 }, { x: 0, y: 0, z: 2 }, 15);
    expect(h.drag.down(1, { x: 50, y: 50 })).toBe(true);
    const out = h.move(1, { x: 80, y: 50 })!;
    expect(out.x).toBeCloseTo(115, 9);
    expect(out.y).toBeCloseTo(200, 9);
    expect(out.angle).toBe(30);
  });

  /** Turns the pair by `deg` about `mid` in 1° steps, both fingers moving. */
  const turnPair = (h: ReturnType<typeof harness>, mid: Vec2, deg: number) => {
    h.drag.down(1, at(mid, 100, 180));
    h.drag.down(2, at(mid, 100, 0));
    for (let d = 1; d <= deg; d++) {
      h.move(1, at(mid, 100, 180 + d));
      h.move(2, at(mid, 100, d));
    }
  };

  it("turns with two pointers about their midpoint, snapping with step 15", () => {
    // The magnet is ±2° (constraints), so a 16° turn snaps to 15° and a 20° turn does not.
    const camera = { x: 0, y: 0, z: 1 };
    const mid = { x: 400, y: 300 };
    const h = harness({ x: 400, y: 300, angle: 0 }, camera, 15);
    turnPair(h, mid, 16);
    expect(h.pose().angle).toBeCloseTo(15, 9);
    expect(Math.abs(offsetPx(h.pose(), camera, screenToWorld(camera, mid)))).toBeLessThan(1e-9);
    const far = harness({ x: 400, y: 300, angle: 0 }, camera, 15);
    turnPair(far, mid, 20);
    expect(far.pose().angle).toBeCloseTo(20, 9);
  });

  it("turns by the exact 20° with step 0", () => {
    const camera = { x: 0, y: 0, z: 1 };
    const h = harness({ x: 400, y: 300, angle: 0 }, camera, 0);
    const mid = { x: 400, y: 300 };
    turnPair(h, mid, 20);
    expect(h.pose().angle).toBeCloseTo(20, 9);
    expect(Math.abs(offsetPx(h.pose(), camera, screenToWorld(camera, mid)))).toBeLessThan(1e-9);
  });

  it("does not stick at a snap during a slow turn", () => {
    const camera = { x: 0, y: 0, z: 1 };
    const h = harness({ x: 400, y: 300, angle: 0 }, camera, 15);
    const mid = { x: 400, y: 300 };
    h.drag.down(1, at(mid, 100, 180));
    h.drag.down(2, at(mid, 100, 0));
    // Only finger 2 moves, 0.5° at a time, to 30° (the pair turns by 15°, about a moving midpoint).
    for (let d = 0.5; d <= 30; d += 0.5) h.move(2, at(mid, 100, d));
    const a = h.pose().angle;
    expect(a).toBeCloseTo(15, 9);
    for (let d = 30.5; d <= 40; d += 0.5) h.move(2, at(mid, 100, d));
    // 20° turned: past the magnet of 15, so it shows the true angle.
    expect(h.pose().angle).toBeCloseTo(20, 6);
  });

  it("leaves the pose alone when two pointers move apart without turning", () => {
    const camera = { x: 10, y: -20, z: 1.5 };
    const start = { x: 300, y: 250, angle: 0 };
    const h = harness(start, camera, 15);
    const mid = worldToScreen(camera, start);
    h.drag.down(1, at(mid, 50, 180));
    h.drag.down(2, at(mid, 50, 0));
    h.move(1, at(mid, 150, 180));
    h.move(2, at(mid, 150, 0));
    expect(h.pose().x).toBeCloseTo(start.x, 9);
    expect(h.pose().y).toBeCloseTo(start.y, 9);
    expect(h.pose().angle).toBeCloseTo(0, 9);
  });

  it("refuses a third pointer", () => {
    const h = harness({ x: 0, y: 0, angle: 0 }, { x: 0, y: 0, z: 1 }, 15);
    expect(h.drag.down(1, { x: 0, y: 0 })).toBe(true);
    expect(h.drag.down(2, { x: 10, y: 0 })).toBe(true);
    expect(h.drag.down(3, { x: 20, y: 0 })).toBe(false);
    expect(h.drag.count()).toBe(2);
    expect(h.drag.move(3, { x: 30, y: 0 })).toBeNull();
  });

  it("continues as a translation without a jump when one of two lifts", () => {
    const camera = { x: 0, y: 0, z: 1 };
    const h = harness({ x: 400, y: 300, angle: 0 }, camera, 0);
    const mid = { x: 400, y: 300 };
    h.drag.down(1, at(mid, 100, 180));
    h.drag.down(2, at(mid, 100, 0));
    h.move(2, at(mid, 100, 10));
    const turned = h.pose();
    h.drag.up(1);
    expect(h.drag.count()).toBe(1);
    const p = at(mid, 100, 10);
    // No movement: no jump.
    const same = h.move(2, p)!;
    expect(same.x).toBeCloseTo(turned.x, 9);
    expect(same.y).toBeCloseTo(turned.y, 9);
    expect(same.angle).toBeCloseTo(turned.angle, 9);
    const out = h.move(2, { x: p.x + 20, y: p.y - 10 })!;
    expect(out.x).toBeCloseTo(turned.x + 20, 9);
    expect(out.y).toBeCloseTo(turned.y - 10, 9);
    expect(out.angle).toBeCloseTo(turned.angle, 9);
  });
});
