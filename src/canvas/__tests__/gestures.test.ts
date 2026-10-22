import { describe, expect, it } from "vitest";
import type { Camera } from "../camera";
import { applyWheel, isLikelyTrackpadWheel, OVERSCROLL_MAX, overscrollPan, pinchCamera } from "../gestures";

const clampOrigin = (c: Camera): Camera => ({ x: Math.min(0, c.x), y: Math.min(0, c.y), z: c.z });
const wheel = (o: Partial<WheelEvent>) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...o });

describe("gestures", () => {
  it("ctrl_wheel_zooms_at_cursor_and_plain_wheel_pans", () => {
    const c = { x: -100, y: -100, z: 1 };
    const z = applyWheel(c, wheel({ deltaY: -100, ctrlKey: true }), { x: 200, y: 200 }, "pan", clampOrigin);
    expect(z.z).toBeCloseTo(Math.E, 10);
    const p = applyWheel(c, wheel({ deltaY: 30 }), { x: 0, y: 0 }, "pan", clampOrigin);
    expect(p).toEqual({ x: -100, y: -130, z: 1 });
  });

  it("scroll_behavior_zoom_only_for_mouse_wheels", () => {
    expect(isLikelyTrackpadWheel({ deltaX: 0, deltaY: 100 })).toBe(false);
    expect(isLikelyTrackpadWheel({ deltaX: 2, deltaY: 12 })).toBe(true);
    const c = { x: -10, y: -10, z: 1 };
    expect(applyWheel(c, wheel({ deltaY: 100 }), { x: 0, y: 0 }, "zoom", clampOrigin).z).not.toBe(1);
    expect(applyWheel(c, wheel({ deltaY: 10, deltaX: 1 }), { x: 0, y: 0 }, "zoom", clampOrigin).z).toBe(1);
  });

  it("overscroll_has_resistance_and_a_cap", () => {
    let c: Camera = { x: 0, y: 0, z: 1 };
    c = overscrollPan(c, 0, 40, clampOrigin);
    expect(c.y).toBeCloseTo(10, 10);
    c = overscrollPan(c, 0, 40, clampOrigin);
    expect(c.y).toBeCloseTo(20, 10);
    c = overscrollPan(c, 0, 10000, clampOrigin);
    expect(c.y).toBe(OVERSCROLL_MAX);
  });

  it("pinch_scales_about_midpoint", () => {
    const start = { camera: { x: 0, y: 0, z: 1 }, mid: { x: 100, y: 100 }, dist: 100 };
    expect(pinchCamera(start, { x: 100, y: 100 }, 200)).toEqual({ x: -100, y: -100, z: 2 });
    expect(pinchCamera(start, { x: 100, y: 100 }, 1).z).toBe(0.1);
  });
});
