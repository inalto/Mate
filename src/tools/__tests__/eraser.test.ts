import { describe, expect, it } from "vitest";
import type { Element } from "../../model/types";
import { eraseAt } from "../eraser";
import { elementBounds, SpatialIndex } from "../spatialIndex";
import { el, mapOf } from "./fixtures";

const opts = { eraseShapes: true, eraseImages: false };
function setup(els: Element[]) {
  const index = new SpatialIndex();
  for (const e of els) index.insert(e.id, elementBounds(e));
  return { elements: mapOf(els), index };
}

describe("eraser", () => {
  it("stroke_mode_removes_touching_stroke", () => {
    // A long segment passing through the eraser with both endpoints far away.
    const { elements, index } = setup([el("s", [[0, 0], [200, 0]])]);
    const r = eraseAt(elements, index, { x: 100, y: 8 }, 10, "stroke", opts);
    expect(r.removed).toEqual(["s"]);
    expect(r.replaced).toEqual([]);
  });

  it("stroke_mode_ignores_far_stroke", () => {
    const { elements, index } = setup([el("s", [[0, 0], [200, 0]])]);
    // 10 (radius) + 1 (half width) < 12.
    const r = eraseAt(elements, index, { x: 100, y: 12 }, 10, "stroke", opts);
    expect(r).toEqual({ removed: [], replaced: [] });
  });

  it("partial_mode_splits_into_two", () => {
    const { elements, index } = setup([el("s", [[0, 0], [100, 0], [200, 0]])]);
    const r = eraseAt(elements, index, { x: 100, y: 0 }, 9, "partial", opts);
    expect(r.removed).toEqual([]);
    expect(r.replaced).toHaveLength(1);
    const { removedId, parts } = r.replaced[0];
    expect(removedId).toBe("s");
    expect(parts).toHaveLength(2);
    expect(parts[0].points.map((p) => [p.x, p.y])).toEqual([[0, 0], [90, 0]]);
    expect(parts[1].points.map((p) => [p.x, p.y])).toEqual([[110, 0], [200, 0]]);
    expect(new Set(parts.map((p) => p.id)).size).toBe(2);
    expect(parts.every((p) => p.id !== "s" && p.color === "#000000" && p.width === 2)).toBe(true);
  });

  it("partial_mode_drops_single_point_fragment", () => {
    // (0,0) lies exactly on the eraser edge (r 9 + half width 1 = 10): it would be a lone point.
    const { elements, index } = setup([el("s", [[0, 0], [5, 0], [30, 0]])]);
    const r = eraseAt(elements, index, { x: 10, y: 0 }, 9, "partial", opts);
    expect(r.replaced).toHaveLength(1);
    expect(r.replaced[0].parts).toHaveLength(1);
    expect(r.replaced[0].parts[0].points.map((p) => [p.x, p.y])).toEqual([[20, 0], [30, 0]]);
    // A stroke entirely inside the eraser is removed outright.
    const inner = setup([el("t", [[0, 0], [2, 0]])]);
    expect(eraseAt(inner.elements, inner.index, { x: 1, y: 0 }, 9, "partial", opts)).toEqual({
      removed: ["t"],
      replaced: [],
    });
  });

  it("never_erases_text_box", () => {
    const { elements, index } = setup([
      el("tb", [[0, 0], [100, 0]], { type: "text-box", boxWidth: 100, boxHeight: 40 }),
      el("tbl", [[0, 0], [100, 0]], { type: "table", boxWidth: 100, boxHeight: 40 }),
      el("code", [[0, 0], [100, 0]], { type: "codespace", boxWidth: 100, boxHeight: 40 }),
    ]);
    for (const mode of ["stroke", "partial"] as const) {
      expect(eraseAt(elements, index, { x: 50, y: 10 }, 20, mode, opts)).toEqual({ removed: [], replaced: [] });
    }
  });
});
