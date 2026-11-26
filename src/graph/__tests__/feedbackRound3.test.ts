// Tester feedback round 3: square graphs with an optional same-scale box, pinch inside the plot,
// filled perfect shapes and highlighter shapes (the side panel it placed is gone: the editor is full page).
import { describe, expect, it } from "vitest";
import { SNAP_FILL_OPACITY, snapShapeElement } from "../../canvas/inkSnap";
import type { RecognizedShape } from "../../shapes/recognize";
import { boxForDomain, DEFAULT_DOMAIN, DEFAULT_GRAPH_SIZE, graphDataOf, graphElement } from "../data";
import { pinchDomain } from "../editorMath";

describe("graph box", () => {
  it("a_new_graph_is_square", () => {
    const el = graphElement("pg", "g", "", { x: 0, y: 0 }, "#000");
    expect(el.boxWidth).toBe(el.boxHeight);
    expect(DEFAULT_GRAPH_SIZE.width).toBe(DEFAULT_GRAPH_SIZE.height);
    expect(graphDataOf(el).aspect).toBeUndefined(); // the box is kept unless asked otherwise
  });

  it("same_scale_gives_the_box_the_shape_of_the_view_at_the_same_area", () => {
    const wide = boxForDomain({ width: 400, height: 400 }, { xMin: -20, xMax: 20, yMin: -10, yMax: 10 });
    expect(wide.width / wide.height).toBeCloseTo(2, 1);
    expect(wide.width * wide.height).toBeCloseTo(160000, -3);
    const tall = boxForDomain({ width: 400, height: 400 }, { xMin: 0, xMax: 5, yMin: 0, yMax: 10 });
    expect(tall.height / tall.width).toBeCloseTo(2, 1);
    expect(boxForDomain({ width: 400, height: 400 }, DEFAULT_DOMAIN)).toEqual({ width: 400, height: 400 });
  });

  it("an_extreme_view_is_capped", () => {
    const b = boxForDomain({ width: 400, height: 400 }, { xMin: 0, xMax: 1000, yMin: 0, yMax: 1 });
    expect(b.width / b.height).toBeCloseTo(4, 1);
    expect(boxForDomain({ width: 900, height: 900 }, { xMin: 0, xMax: 4, yMin: 0, yMax: 1 }).width).toBeLessThanOrEqual(960);
  });

  it("the_aspect_is_read_back_from_stored_data", () => {
    expect(graphDataOf({ content: { graphData: { aspect: "equal" } } }).aspect).toBe("equal");
    expect(graphDataOf({ content: { graphData: { aspect: "nonsense" } } }).aspect).toBeUndefined();
  });
});

describe("pinch inside the plot", () => {
  const d = { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };

  it("fingers_moving_apart_zoom_in_about_their_midpoint", () => {
    const out = pinchDomain(d, 100, 200, 0.5, 0.5, 0.5, 0.5);
    expect(out).toEqual({ xMin: -5, xMax: 5, yMin: -5, yMax: 5 });
    // Off-centre: the point under the fingers stays there.
    const off = pinchDomain(d, 100, 200, 0.75, 0.25, 0.75, 0.25);
    expect(off.xMin + 0.75 * (off.xMax - off.xMin)).toBeCloseTo(5);
    expect(off.yMax - 0.25 * (off.yMax - off.yMin)).toBeCloseTo(5);
  });

  it("fingers_moving_together_pan", () => {
    const out = pinchDomain(d, 100, 100, 0.5, 0.5, 0.75, 0.5); // a quarter of the box to the right
    expect(out.xMin).toBeCloseTo(-15);
    expect(out.xMax).toBeCloseTo(5);
    expect(out.yMin).toBeCloseTo(-10);
  });

  it("a_degenerate_gesture_changes_nothing", () => {
    expect(pinchDomain(d, 0, 100, 0.5, 0.5, 0.5, 0.5)).toBe(d);
  });
});

describe("perfect shapes", () => {
  const rect: RecognizedShape = { type: "rectangle", score: 1, rect: { x: 0, y: 0, width: 100, height: 60 }, rotation: 0 };
  const line: RecognizedShape = { type: "arrow", score: 1, rect: { x: 0, y: 0, width: 100, height: 0 }, rotation: 0 };
  const pen = { color: "#1565C0", width: 3, type: "pen" as const };

  it("are_unfilled_by_default_and_tinted_with_the_ink_colour_when_asked", () => {
    expect(snapShapeElement(rect, pen, "pg", "a", "").fillColor).toBe("transparent");
    const filled = snapShapeElement(rect, pen, "pg", "a", "", true);
    expect(filled.fillColor).toBe("#1565C0");
    expect((filled.content as { fillOpacity: number }).fillOpacity).toBe(SNAP_FILL_OPACITY);
    // Open shapes have nothing to fill.
    expect(snapShapeElement(line, pen, "pg", "a", "", true).fillColor).toBe("transparent");
  });

  it("stay_highlighter_ink_with_the_highlighter", () => {
    const hl = { color: "#FDE047", width: 20, type: "highlighter" as const };
    const box = snapShapeElement(rect, hl, "pg", "a", "");
    expect(box).toMatchObject({ type: "stroke", isHighlighter: true, penStyle: "highlighter", color: "#FDE047", width: 20 });
    // Along the outline, through every corner, with points laid densely on the sides.
    const xy = box.points.map((p) => [p.x, p.y]);
    for (const corner of [[0, 0], [100, 0], [100, 60], [0, 60]]) expect(xy).toContainEqual(corner);
    expect(xy[0]).toEqual([0, 0]);
    expect(xy[xy.length - 1]).toEqual([0, 0]);
    for (const [x, y] of xy) expect(x === 0 || x === 100 || y === 0 || y === 60).toBe(true);
    const straight = snapShapeElement(line, hl, "pg", "a", "").points;
    expect([straight[0].x, straight[0].y]).toEqual([0, 0]);
    expect([straight[straight.length - 1].x, straight[straight.length - 1].y]).toEqual([100, 0]); // no arrow head
    expect(straight.every((p) => p.y === 0)).toBe(true);
  });
});
