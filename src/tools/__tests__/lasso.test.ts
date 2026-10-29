import { describe, expect, it } from "vitest";
import { lassoDirection, lassoMode, lassoSelect, selectionBounds, translateElements } from "../lasso";
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

  // Screen/world coordinates are y-down: top-left → top-right → bottom-right → bottom-left is clockwise.
  const cw = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  const ccw = [...cw].reverse();

  it("direction_from_signed_area", () => {
    expect(lassoDirection(cw)).toBe("cw");
    expect(lassoDirection(ccw)).toBe("ccw");
    expect(lassoDirection(cw.slice(0, 2))).toBeNull();
    expect(lassoDirection([{ x: 0, y: 0 }, { x: 50, y: 0.2 }, { x: 100, y: 0 }])).toBeNull();
    expect(lassoDirection([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }])).toBeNull();
  });

  const ellipse = (rx: number, ry: number, sign: 1 | -1) =>
    Array.from({ length: 64 }, (_, i) => {
      const a = (sign * i * 2 * Math.PI) / 64;
      return { x: 600 + rx * Math.cos(a), y: 15 + ry * Math.sin(a) };
    });

  it("thin_loop_around_a_line_of_text_has_a_direction", () => {
    // A 1200×30 loop around one line of handwriting: area/P² ≈ 0.005, still a deliberate loop.
    expect(lassoDirection(ellipse(600, 15, -1))).toBe("ccw");
    expect(lassoMode(ellipse(600, 15, -1))).toBe("touch");
    expect(lassoDirection(ellipse(600, 15, 1))).toBe("cw");
  });

  it("zero_area_scribbles_have_no_direction", () => {
    const backAndForth = [0, 100, 200, 100, 0, 100, 200].map((x, i) => ({ x, y: i % 2 }));
    expect(lassoDirection(backAndForth)).toBeNull();
    const line = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 1200, y: 0 }, { x: 600, y: 0 }];
    expect(lassoDirection(line)).toBeNull();
  });

  it("mode_mapping", () => {
    expect(lassoMode(cw)).toBe("inside");
    expect(lassoMode(ccw)).toBe("touch");
    expect(lassoMode([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe("inside");
  });

  // A stroke crossing the lasso without enough of it inside, a text box the lasso passes through,
  // an image the lasso is drawn inside, and a stroke far away.
  const crossing = el("cross", [[-200, 50], [-100, 50], [50, 50], [300, 50], [500, 50]]);
  const text = el("txt", [[-300, 40]], { type: "text-box", boxWidth: 450, boxHeight: 20 });
  const image = el("img", [[-50, -50]], { type: "image", width: 300, height: 300 });
  const far = el("far", [[1000, 1000], [1100, 1100]]);
  const touchSet = [crossing, text, far];
  const indexOf = (els: ReturnType<typeof el>[]) => {
    const index = new SpatialIndex();
    for (const e of els) index.insert(e.id, elementBounds(e));
    return index;
  };

  it("touch_selects_crossed_stroke_and_box", () => {
    const ids = lassoSelect(mapOf(touchSet), indexOf(touchSet), ccw, "touch");
    expect(ids.sort()).toEqual(["cross", "txt"]);
  });

  it("touch_selects_image_drawn_inside", () => {
    const ids = lassoSelect(mapOf([image, far]), indexOf([image, far]), ccw, "touch");
    expect(ids).toEqual(["img"]);
  });

  it("touch_selects_crossed_shape_outline", () => {
    // An unfilled shape around the lasso is a ring: drawing inside it touches nothing.
    const ring = el("ring", [[-50, -50], [150, 150]], { type: "shape", shapeType: "rectangle", fillColor: "none" });
    expect(lassoSelect(mapOf([ring]), indexOf([ring]), ccw, "touch")).toEqual([]);
    const clear = el("clear", [[-50, -50], [150, 150]], {
      type: "shape",
      shapeType: "rectangle",
      fillColor: "#ff0000",
      content: { fillOpacity: 0 },
    });
    expect(lassoSelect(mapOf([clear]), indexOf([clear]), ccw, "touch")).toEqual([]);
    const edge = el("edge", [[50, 50], [200, 200]], { type: "shape", shapeType: "ellipse" });
    expect(lassoSelect(mapOf([edge]), indexOf([edge]), ccw, "touch")).toEqual(["edge"]);
  });

  it("touch_selects_filled_shape_drawn_inside", () => {
    const filled = el("filled", [[-50, -50], [150, 150]], { type: "shape", shapeType: "rectangle", fillColor: "#ff0000" });
    expect(lassoSelect(mapOf([filled, far]), indexOf([filled, far]), ccw, "touch")).toEqual(["filled"]);
    const disc = el("disc", [[-100, -100], [200, 200]], { type: "shape", shapeType: "ellipse", fillColor: "#00ff00" });
    expect(lassoSelect(mapOf([disc]), indexOf([disc]), ccw, "touch")).toEqual(["disc"]);
    // Not when the lasso sits outside the filled shape (inside its bbox corner).
    const corner = [{ x: -95, y: -95 }, { x: -95, y: -85 }, { x: -85, y: -85 }, { x: -85, y: -95 }];
    expect(lassoSelect(mapOf([disc]), indexOf([disc]), corner, "touch")).toEqual([]);
  });

  it("inside_ignores_touched_elements", () => {
    expect(lassoSelect(mapOf(touchSet), indexOf(touchSet), cw, "inside")).toEqual([]);
    expect(lassoSelect(mapOf([image]), indexOf([image]), cw)).toEqual([]);
  });

  it("point_only_polygon_selects_nothing", () => {
    const dot = [{ x: 50, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 50 }];
    const all = [crossing, text, image];
    expect(lassoSelect(mapOf(all), indexOf(all), dot, "touch")).toEqual([]);
    expect(lassoSelect(mapOf(all), indexOf(all), dot, "inside")).toEqual([]);
  });
});
