import { describe, expect, it } from "vitest";
import type { Element } from "../../model/types";
import { coverBoxElement } from "../../covers/cover";
import { shapeFromDrag } from "../../shapes/geometry";
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
      el("graph", [[0, 0], [100, 0]], { type: "graph", boxWidth: 100, boxHeight: 40 }),
    ]);
    for (const mode of ["stroke", "partial"] as const) {
      expect(eraseAt(elements, index, { x: 50, y: 10 }, 20, mode, opts)).toEqual({ removed: [], replaced: [] });
    }
  });
});

describe("eraser over recall covers", () => {
  const ink = el("ink", [[0, 10], [80, 10]]);
  const stroke = el("cv", [[0, 10], [80, 10]], { width: 28, penStyle: "cover", color: "#334155" });
  const box = coverBoxElement("#334155", shapeFromDrag("rectangle", { x: -50, y: -50 }, { x: 200, y: 100 }, false), "pg", "box", "T");

  it("a covered cover shields what it hides: only the cover goes", () => {
    for (const cover of [stroke, box]) {
      const { elements, index } = setup([ink, cover]);
      for (const mode of ["stroke", "partial"] as const) {
        expect(eraseAt(elements, index, { x: 40, y: 10 }, 5, mode, opts)).toEqual({ removed: [cover.id], replaced: [] });
      }
    }
  });

  it("a revealed cover shields nothing", () => {
    const { elements, index } = setup([ink, stroke]);
    const r = eraseAt(elements, index, { x: 40, y: 10 }, 5, "stroke", { ...opts, revealed: new Set(["cv"]) });
    expect([...r.removed].sort()).toEqual(["cv", "ink"]);
  });

  it("a cover that cannot be erased still shields what it hides", () => {
    const { elements, index } = setup([ink, box]);
    expect(eraseAt(elements, index, { x: 40, y: 10 }, 5, "stroke", { ...opts, eraseShapes: false })).toEqual({ removed: [], replaced: [] });
  });

  it("a cover erased earlier in the same drag keeps shielding", () => {
    const { elements, index } = setup([ink]);
    expect(eraseAt(elements, index, { x: 40, y: 10 }, 5, "stroke", { ...opts, shields: [box] })).toEqual({ removed: [], replaced: [] });
    expect(eraseAt(elements, index, { x: 40, y: 10 }, 5, "stroke", opts).removed).toEqual(["ink"]);
  });

  it("the partial eraser never splits a cover: a box cover's edge or a stroke cover goes whole", () => {
    const edge = setup([box]);
    expect(eraseAt(edge.elements, edge.index, { x: -50, y: 20 }, 5, "partial", opts)).toEqual({ removed: ["box"], replaced: [] });
    const long = el("cv", [[0, 10], [100, 10], [200, 10]], { width: 28, penStyle: "cover" });
    const along = setup([long]);
    expect(eraseAt(along.elements, along.index, { x: 100, y: 10 }, 5, "partial", { ...opts, revealed: new Set(["cv"]) })).toEqual({
      removed: ["cv"],
      replaced: [],
    });
  });
});
