import { describe, expect, it } from "vitest";
import type { Element, ShapeType } from "../../model/types";
import { APPROX_CHAR_WIDTH, DEFAULT_LABEL_FONT_SIZE, labelLines, labelMeasure, shapeInnerRect, shapeLabelOf, withShapeLabel, type ShapeLabel } from "../label";

function shape(shapeType: ShapeType, extra: Partial<Element> = {}): Element {
  return {
    id: "s",
    pageId: "pg",
    type: "shape",
    shapeType,
    points: [
      { x: 0, y: 0, pressure: 0.5, timestamp: 0 },
      { x: 200, y: 100, pressure: 0.5, timestamp: 1 },
    ],
    color: "#1565C0",
    fillColor: "transparent",
    width: 4,
    isHighlighter: false,
    boxWidth: 200,
    boxHeight: 100,
    content: { fillOpacity: 1 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 0,
    ...extra,
  };
}

const label: ShapeLabel = { text: "hello", fontSize: 20, color: "#C62828", align: "left" };
const measure = (s: string): number => s.length * 7;

describe("shape label model", () => {
  it("reads_a_stored_label", () => {
    expect(shapeLabelOf(shape("rectangle", { content: { fillOpacity: 1, label } }))).toEqual(label);
  });

  it("no_label_is_null", () => {
    expect(shapeLabelOf(shape("rectangle"))).toBeNull();
    expect(shapeLabelOf(shape("rectangle", { content: { fillOpacity: 1, label: "x" } }))).toBeNull();
    expect(shapeLabelOf(shape("rectangle", { content: { fillOpacity: 1, label: { text: 3 } } }))).toBeNull();
    expect(shapeLabelOf(shape("rectangle", { content: null }))).toBeNull();
  });

  it("lines_and_arrows_have_no_label", () => {
    expect(shapeLabelOf(shape("line", { content: { fillOpacity: 1, label } }))).toBeNull();
    expect(shapeLabelOf(shape("arrow", { content: { fillOpacity: 1, label } }))).toBeNull();
  });

  it("missing_or_bad_fields_take_defaults", () => {
    const el = shape("rectangle", { content: { fillOpacity: 1, label: { text: "x", fontSize: -2, color: 5, align: "justify" } } });
    expect(shapeLabelOf(el)).toEqual({ text: "x", fontSize: DEFAULT_LABEL_FONT_SIZE, color: "#1565C0", align: "center" });
    expect(DEFAULT_LABEL_FONT_SIZE).toBe(16);
  });

  it("with_shape_label_sets_and_removes_keeping_other_content", () => {
    const el = shape("rectangle", { content: { fillOpacity: 0.5, rotation: 1 } });
    const set = withShapeLabel(el, label);
    expect(set.content).toEqual({ fillOpacity: 0.5, rotation: 1, label });
    expect(el.content).toEqual({ fillOpacity: 0.5, rotation: 1 });
    expect(set).not.toBe(el);
    const cleared = withShapeLabel(set, null);
    expect(cleared.content).toEqual({ fillOpacity: 0.5, rotation: 1 });
    expect(withShapeLabel(shape("rectangle", { content: null }), label).content).toEqual({ label });
  });
});

describe("shapeInnerRect", () => {
  it("rectangle_insets_by_stroke_width_plus_6", () => {
    // width 4 → inset 10 per side.
    expect(shapeInnerRect(shape("rectangle"))).toEqual({ x: 10, y: 10, width: 180, height: 80 });
  });

  it("ellipse_and_circle_use_the_inscribed_rectangle", () => {
    for (const t of ["ellipse", "circle"] as const) {
      const r = shapeInnerRect(shape(t))!;
      expect(r.width).toBeCloseTo(200 * 0.707);
      expect(r.height).toBeCloseTo(100 * 0.707);
      expect(r.x + r.width / 2).toBeCloseTo(100);
      expect(r.y + r.height / 2).toBeCloseTo(50);
    }
  });

  it("triangle_uses_the_lower_55_percent_inset_15_percent", () => {
    const r = shapeInnerRect(shape("triangle"))!;
    expect(r.x).toBeCloseTo(30);
    expect(r.width).toBeCloseTo(140);
    expect(r.y).toBeCloseTo(45);
    expect(r.height).toBeCloseTo(55);
  });

  it("diamond_uses_the_middle_50_percent", () => {
    expect(shapeInnerRect(shape("diamond"))).toEqual({ x: 50, y: 25, width: 100, height: 50 });
  });

  it("polygons_and_stars_use_the_central_60_percent", () => {
    for (const t of ["pentagon", "hexagon", "star", "polygon"] as const) {
      const r = shapeInnerRect(shape(t))!;
      expect(r.x).toBeCloseTo(40);
      expect(r.y).toBeCloseTo(20);
      expect(r.width).toBeCloseTo(120);
      expect(r.height).toBeCloseTo(60);
    }
  });

  it("is_unrotated_and_normalised", () => {
    const flipped = shape("diamond", {
      points: [
        { x: 200, y: 100, pressure: 0.5, timestamp: 0 },
        { x: 0, y: 0, pressure: 0.5, timestamp: 1 },
      ],
      content: { fillOpacity: 1, rotation: 1 },
    });
    expect(shapeInnerRect(flipped)).toEqual({ x: 50, y: 25, width: 100, height: 50 });
  });

  it("never_negative_for_tiny_rectangles", () => {
    const tiny = shape("rectangle", {
      points: [
        { x: 0, y: 0, pressure: 0.5, timestamp: 0 },
        { x: 10, y: 10, pressure: 0.5, timestamp: 1 },
      ],
    });
    expect(shapeInnerRect(tiny)).toEqual({ x: 5, y: 5, width: 0, height: 0 });
  });

  it("lines_and_arrows_have_none", () => {
    expect(shapeInnerRect(shape("line"))).toBeNull();
    expect(shapeInnerRect(shape("arrow"))).toBeNull();
  });
});

describe("labelLines", () => {
  it("wraps_the_label_to_the_inner_width", () => {
    // Rectangle inner width 180 px = 25 characters at 7 px.
    const el = withShapeLabel(shape("rectangle"), { ...label, text: "aaaa bbbb cccc dddd eeee ffff\nend" });
    expect(labelLines(el, measure)).toEqual(["aaaa bbbb cccc dddd eeee", "ffff", "end"]);
  });

  it("no_label_is_no_lines", () => {
    expect(labelLines(shape("rectangle"), measure)).toEqual([]);
  });
});

describe("labelMeasure", () => {
  it("estimates_by_character_without_a_canvas", () => {
    // jsdom has no OffscreenCanvas.
    expect(labelMeasure(20)("abcd")).toBeCloseTo(4 * 20 * APPROX_CHAR_WIDTH);
  });
});
