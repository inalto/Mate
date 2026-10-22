import { describe, expect, it } from "vitest";
import { hitTest } from "../../canvas/toolInteractions";
import type { Element, ShapeType } from "../../model/types";
import "../../renderers/builtins";
import { eraseAt } from "../eraser";
import { rotateElements, scaleElements } from "../lasso";
import { elementBounds, isBoxed, SpatialIndex } from "../spatialIndex";
import { el, mapOf } from "./fixtures";

const shape = (id: string, shapeType: ShapeType, xy: [number, number][], extra: Partial<Element> = {}): Element =>
  el(id, xy, {
    type: "shape",
    shapeType,
    color: "#1565C0",
    fillColor: "transparent",
    width: 2,
    boxWidth: Math.abs(xy[1][0] - xy[0][0]),
    boxHeight: Math.abs(xy[1][1] - xy[0][1]),
    content: { fillOpacity: 1 },
    penStyle: undefined,
    ...extra,
  });

const box = shape("r", "rectangle", [
  [0, 0],
  [100, 50],
]);

function setup(els: Element[]) {
  const index = SpatialIndex.from(els);
  return { elements: mapOf(els), index };
}
const on = { eraseShapes: true, eraseImages: false };

describe("shapes with the eraser, lasso and hit-testing", () => {
  it("whole_erase_follows_the_outline", () => {
    const { elements, index } = setup([box]);
    // The middle of an unfilled rectangle is empty paper.
    expect(eraseAt(elements, index, { x: 50, y: 25 }, 5, "stroke", on).removed).toEqual([]);
    expect(eraseAt(elements, index, { x: 100, y: 25 }, 5, "stroke", on).removed).toEqual(["r"]);
    expect(eraseAt(elements, index, { x: 100, y: 25 }, 5, "stroke", { ...on, eraseShapes: false }).removed).toEqual([]);
    // A filled shape is erased from anywhere inside.
    const filled = setup([{ ...box, fillColor: "#C62828" }]);
    expect(eraseAt(filled.elements, filled.index, { x: 50, y: 25 }, 5, "stroke", on).removed).toEqual(["r"]);
  });

  it("partial_erase_turns_the_outline_into_strokes", () => {
    const { elements, index } = setup([box]);
    let n = 0;
    const r = eraseAt(elements, index, { x: 100, y: 25 }, 5, "partial", { ...on, newId: () => `f${++n}`, now: "T" });
    expect(r.removed).toEqual([]);
    expect(r.replaced).toHaveLength(1);
    const { removedId, parts } = r.replaced[0];
    expect(removedId).toBe("r");
    expect(parts).toHaveLength(1); // the closed outline opens into one polyline around the gap
    const [frag] = parts;
    expect(frag).toMatchObject({ type: "stroke", color: "#1565C0", width: 2, penStyle: "pen", pageId: "pg", updatedAt: "T" });
    expect(frag.shapeType).toBeUndefined();
    expect(frag.fillColor).toBeUndefined();
    expect(frag.boxWidth).toBeUndefined();
    for (const p of frag.points) expect(Math.hypot(p.x - 100, p.y - 25)).toBeGreaterThanOrEqual(5.999);
    // Untouched: no change.
    expect(eraseAt(elements, index, { x: 50, y: 25 }, 5, "partial", on)).toEqual({ removed: [], replaced: [] });
    // Filled: the outline still opens into strokes (the fill goes); rubbing the inside erases it whole.
    const filled = setup([{ ...box, fillColor: "#C62828" }]);
    expect(eraseAt(filled.elements, filled.index, { x: 100, y: 25 }, 5, "partial", on).replaced[0].parts[0].type).toBe("stroke");
    expect(eraseAt(filled.elements, filled.index, { x: 50, y: 25 }, 5, "partial", on).removed).toEqual(["r"]);
    // Disabled: shapes are skipped in partial mode too.
    expect(eraseAt(elements, index, { x: 100, y: 25 }, 5, "partial", { ...on, eraseShapes: false }).replaced).toEqual([]);
  });

  it("scale_keeps_shape_anchors_normalised", () => {
    const [out] = scaleElements([box], { x: 100, y: 50 }, -2, 1);
    expect(out.points.map((p) => [p.x, p.y])).toEqual([
      [100, 0],
      [300, 50],
    ]);
    expect([out.boxWidth, out.boxHeight]).toEqual([200, 50]);
    // Lines keep their direction.
    const ln = shape("l", "line", [
      [0, 0],
      [100, 100],
    ]);
    const [s] = scaleElements([ln], { x: 0, y: 0 }, -1, 1);
    expect(s.points.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [-100, 100],
    ]);
    expect([s.boxWidth, s.boxHeight]).toEqual([100, 100]);
  });

  it("rotate_turns_the_box_about_its_centre", () => {
    const [out] = rotateElements([box], { x: 0, y: 0 }, Math.PI / 2);
    expect((out.content as { rotation: number }).rotation).toBeCloseTo(Math.PI / 2);
    // The box centre (50, 25) rotates to (-25, 50); the box itself keeps its size.
    expect(out.points[0].x).toBeCloseTo(-75);
    expect(out.points[0].y).toBeCloseTo(25);
    expect([out.boxWidth, out.boxHeight]).toEqual([100, 50]);
    expect((out.content as { fillOpacity: number }).fillOpacity).toBe(1);
  });

  it("shapes_are_canvas_selected_and_hit_by_outline", () => {
    expect(isBoxed(box)).toBe(false);
    expect(elementBounds(box)).toEqual({ x: -1, y: -1, width: 102, height: 52 });
    const ln = shape("l", "line", [
      [0, 0],
      [100, 100],
    ]);
    const { elements, index } = setup([ln]);
    expect(hitTest(index, elements, { x: 50, y: 50 }, 2)).toBe("l");
    expect(hitTest(index, elements, { x: 90, y: 10 }, 2)).toBeNull();
  });
});
