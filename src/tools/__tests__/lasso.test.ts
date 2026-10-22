import { describe, expect, it } from "vitest";
import { lassoSelect, selectionBounds, translateElements } from "../lasso";
import { elementBounds, SpatialIndex } from "../spatialIndex";
import { el, mapOf } from "./fixtures";

describe("lasso", () => {
  it("selects_enclosed_stroke", () => {
    const inside = el("in", [[10, 10], [40, 40]]);
    const outside = el("out", [[300, 300], [340, 340]]);
    // Half its points inside the polygon, bbox centre outside.
    const half = el("half", [[50, 50], [90, 90], [300, 50], [310, 50]]);
    const index = new SpatialIndex();
    for (const e of [inside, outside, half]) index.insert(e.id, elementBounds(e));
    const polygon = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const ids = lassoSelect(mapOf([inside, outside, half]), index, polygon);
    expect(ids.sort()).toEqual(["half", "in"]);
    expect(selectionBounds(mapOf([inside, outside]), ["in", "out"])).toEqual({ x: 9, y: 9, width: 332, height: 332 });
  });

  it("translate_moves_all_points", () => {
    const a = el("a", [[0, 0], [10, 5]]);
    const b = el("b", [[3, 4]]);
    const [a2, b2] = translateElements([a, b], 20, -5);
    expect(a2.points.map((p) => [p.x, p.y])).toEqual([[20, -5], [30, 0]]);
    expect(b2.points.map((p) => [p.x, p.y])).toEqual([[23, -1]]);
    expect(a2.points[1].pressure).toBe(0.5);
    expect(a.points[0].x).toBe(0); // inputs untouched
    expect(a2.id).toBe("a");
  });
});
