import { describe, expect, it } from "vitest";
import { hitTest } from "../../canvas/toolInteractions";
import { scaleElements } from "../lasso";
import { elementBounds, SpatialIndex } from "../spatialIndex";
import { el, mapOf } from "./fixtures";

describe("boxed element bounds", () => {
  it("boxed_bounds_from_anchor_and_box", () => {
    for (const type of ["text-box", "table", "codespace", "graph"] as const) {
      const b = el("b", [[10, 20]], { type, boxWidth: 100, boxHeight: 40, width: 1 });
      expect(elementBounds(b)).toEqual({ x: 10, y: 20, width: 100, height: 40 });
    }
    // Images use top-level width/height as their box size.
    const img = el("i", [[5, 6]], { type: "image", width: 300, height: 200 });
    expect(elementBounds(img)).toEqual({ x: 5, y: 6, width: 300, height: 200 });
    // A box without a size yet is an empty box at its anchor (not the stroke-width padding).
    const bare = el("t", [[7, 8]], { type: "text-box", width: 4 });
    expect(elementBounds(bare)).toEqual({ x: 7, y: 8, width: 0, height: 0 });
    // Rotation about the centre widens the axis-aligned bounds.
    const rot = el("r", [[0, 0]], { type: "graph", boxWidth: 100, boxHeight: 100, content: { rotation: Math.PI / 4 } });
    const r = elementBounds(rot);
    expect(r.width).toBeCloseTo(100 * Math.SQRT2);
    expect(r.x + r.width / 2).toBeCloseTo(50);
  });

  it("click_inside_box_hits_it", () => {
    const stroke = el("s", [[0, 0], [400, 400]]);
    const b = el("b", [[100, 100]], { type: "text-box", boxWidth: 80, boxHeight: 30, createdAt: "2026-02-01T00:00:00.000Z" });
    const all = mapOf([stroke, b]);
    const index = SpatialIndex.from(all.values());
    expect(hitTest(index, all, { x: 170, y: 125 }, 2)).toBe("b");
    expect(hitTest(index, all, { x: 300, y: 120 }, 2)).toBeNull();
  });

  it("scale_keeps_image_aspect", () => {
    const img = el("i", [[0, 0]], { type: "image", width: 200, height: 100 });
    const [out] = scaleElements([img], { x: 0, y: 0 }, 2, 0.5);
    expect(out.width! / out.height!).toBeCloseTo(2);
    expect(out.points[0]).toMatchObject({ x: 0, y: 0 });
    // Text boxes stretch freely; a mirrored drag keeps the box's top-left anchor normalised.
    const tb = el("t", [[10, 10]], { type: "text-box", boxWidth: 100, boxHeight: 50, width: 1 });
    const [s] = scaleElements([tb], { x: 110, y: 60 }, -1, 2);
    expect(elementBounds(s)).toEqual({ x: 110, y: -40, width: 100, height: 100 });
    expect(s.width).toBe(1);
  });
});
