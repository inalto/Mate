import { describe, expect, it } from "vitest";
import type { Page } from "../../model/types";
import { clampCamera, screenToWorld, wheelZoomFactor, zoomAt } from "../camera";

const page = (mode: Page["mode"]): Page => ({
  id: "p",
  sectionId: "s",
  title: "t",
  isExpanded: true,
  isFavourite: false,
  depth: 0,
  mode,
  backgroundConfig: { type: "ruled", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex: 0,
  createdAt: "",
  updatedAt: "",
  version: 0,
});

describe("camera", () => {
  it("zoom_clamped", () => {
    const c = { x: 0, y: 0, z: 1 };
    expect(zoomAt(c, { x: 100, y: 100 }, 20).z).toBe(10);
    expect(zoomAt(c, { x: 100, y: 100 }, 0.01).z).toBe(0.1);
  });

  it("zoom_keeps_focus_point_fixed", () => {
    const c = { x: -123.4, y: 56.7, z: 1.3 };
    const focus = { x: 321, y: 210 };
    const before = screenToWorld(c, focus);
    const after = screenToWorld(zoomAt(c, focus, 3.7), focus);
    expect(Math.abs(after.x - before.x)).toBeLessThan(1e-9);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1e-9);
  });

  it("wheel_factor", () => {
    expect(wheelZoomFactor(100)).toBeCloseTo(Math.exp(-1), 12);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it("canvas_clamp_blocks_negative_origin", () => {
    const vp = { width: 800, height: 600 };
    const c = clampCamera({ x: 250, y: 90, z: 2 }, page("canvas"), vp);
    expect(c).toEqual({ x: 0, y: 0, z: 2 });
    // Right/down is unbounded.
    const far = clampCamera({ x: -1e6, y: -1e6, z: 1 }, page("canvas"), vp);
    expect(far).toEqual({ x: -1e6, y: -1e6, z: 1 });
  });
});
