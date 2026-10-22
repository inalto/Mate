import { describe, expect, it } from "vitest";
import { elementBounds, SpatialIndex } from "../spatialIndex";
import { el } from "./fixtures";

describe("spatialIndex", () => {
  it("query_returns_overlapping_only", () => {
    const idx = new SpatialIndex();
    const a = el("a", [[0, 0], [100, 0]]);
    const b = el("b", [[1000, 1000], [1100, 1000]]);
    const c = el("c", [[50, -500], [50, 500]]);
    for (const e of [a, b, c]) idx.insert(e.id, elementBounds(e));
    expect(idx.query({ x: 40, y: -10, width: 20, height: 20 }).sort()).toEqual(["a", "c"]);
    expect(idx.query({ x: 990, y: 990, width: 20, height: 20 })).toEqual(["b"]);
    // Same grid cell as "a" but outside its bounds.
    expect(idx.query({ x: 150, y: 150, width: 10, height: 10 })).toEqual([]);
    idx.remove("a");
    expect(idx.query({ x: 40, y: -10, width: 20, height: 20 })).toEqual(["c"]);
    expect(elementBounds(a)).toEqual({ x: -1, y: -1, width: 102, height: 2 });
  });
});
