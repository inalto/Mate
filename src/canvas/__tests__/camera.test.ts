import { describe, expect, it } from "vitest";
import type { Page } from "../../model/types";
import { cameraAtZoom, clampCamera, initialCamera, screenToWorld, wheelZoomFactor, zoomAt } from "../camera";
import { PAGE_MODE_TOP_MARGIN } from "../../model/constants";

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

describe("cameraAtZoom", () => {
  const vp = { width: 1000, height: 700 };

  it("page mode keeps z, centres the sheet and puts the top margin at the top", () => {
    const stack = { width: 600, height: 800, count: 1 };
    const c = cameraAtZoom(page("page"), vp, 1.5, stack);
    expect(c).toEqual({ x: (1000 - 600 * 1.5) / 2, y: PAGE_MODE_TOP_MARGIN * 1.5, z: 1.5 });
  });

  it("at the zoom initialCamera would pick it is initialCamera", () => {
    const stack = { width: 600, height: 800, count: 1 };
    const init = initialCamera(page("page"), vp, stack);
    expect(cameraAtZoom(page("page"), vp, init.z, stack)).toEqual(init);
  });

  it("canvas mode keeps z at the origin", () => {
    expect(cameraAtZoom(page("canvas"), vp, 2.5)).toEqual({ x: 0, y: 0, z: 2.5 });
  });

  it("clamps the zoom to the allowed range", () => {
    expect(cameraAtZoom(page("canvas"), vp, 50).z).toBe(10);
    expect(cameraAtZoom(page("canvas"), vp, 0.001).z).toBe(0.1);
  });
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

  it("centre_lock_holds_a_narrow_sheet_in_the_middle_and_frees_a_wide_one", () => {
    const vp = { width: 2000, height: 1000 };
    const stack = { width: 1080, height: 1528, count: 1 };
    // Sheet narrower than the view: wherever it was dragged, it comes back to the middle.
    expect(clampCamera({ x: 30, y: 0, z: 1 }, page("page"), vp, stack, true).x).toBe((2000 - 1080) / 2);
    expect(clampCamera({ x: 30, y: 0, z: 1 }, page("page"), vp, stack).x).not.toBe((2000 - 1080) / 2);
    // Zoomed in past the view's width: it pans, but only until an edge of the sheet meets the view's.
    expect(clampCamera({ x: -500, y: 0, z: 3 }, page("page"), vp, stack, true).x).toBe(-500);
    expect(clampCamera({ x: 300, y: 0, z: 3 }, page("page"), vp, stack, true).x).toBeCloseTo(0); // left edge held
    expect(clampCamera({ x: -5000, y: 0, z: 3 }, page("page"), vp, stack, true).x).toBe(2000 - 1080 * 3); // right edge held
    // Without the setting the side margin and overshoot stay reachable.
    expect(clampCamera({ x: 300, y: 0, z: 3 }, page("page"), vp, stack).x).toBe(300);
  });
});
