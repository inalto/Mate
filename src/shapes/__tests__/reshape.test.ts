import { describe, expect, it } from "vitest";
import type { Element } from "../../model/types";
import { shapeElement, shapeElementOutline, shapeFromDrag } from "../geometry";
import { isCurveStroke, reshapeHandles } from "../reshape";

const shape = (type: Element["shapeType"], x: number, y: number, w: number, h: number, rotation = 0): Element => {
  const el = shapeElement(
    { shapeType: type!, color: "#000", fillColor: "transparent", width: 2, fillOpacity: 1 },
    shapeFromDrag(type!, { x, y }, { x: x + w, y: y + h }, false),
    "pg",
    "s1",
    "",
  );
  return rotation ? { ...el, content: { ...(el.content as object), rotation } } : el;
};

const corners = (el: Element) => shapeElementOutline(el)[0].slice(0, -1);
const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

describe("reshape handles", () => {
  it("a_rectangle_has_a_handle_on_each_corner", () => {
    const hs = reshapeHandles(shape("rectangle", 10, 20, 100, 50));
    expect(hs.map((h) => h.at)).toEqual([
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 70 },
      { x: 10, y: 70 },
    ]);
  });

  it("dragging_one_corner_moves_only_that_corner", () => {
    const el = shape("rectangle", 0, 0, 100, 50);
    const next = reshapeHandles(el)[2].apply({ x: 140, y: 90 });
    const c = corners(next);
    close(c[0], { x: 0, y: 0 });
    close(c[1], { x: 100, y: 0 });
    close(c[2], { x: 140, y: 90 });
    close(c[3], { x: 0, y: 50 });
    expect(next.boxWidth).toBeCloseTo(140);
    expect(next.boxHeight).toBeCloseTo(90);
    // The handles of the reshaped polygon are its new corners.
    close(reshapeHandles(next)[2].at, { x: 140, y: 90 });
  });

  it("a_rotated_polygon_keeps_its_other_corners_in_place", () => {
    const el = shape("triangle", 0, 0, 80, 60, Math.PI / 5);
    const before = corners(el);
    const next = reshapeHandles(el)[0].apply({ x: 200, y: -40 });
    const after = corners(next);
    close(after[0], { x: 200, y: -40 });
    close(after[1], before[1]);
    close(after[2], before[2]);
  });

  it("every_polygon_type_has_one_handle_per_corner", () => {
    expect(reshapeHandles(shape("triangle", 0, 0, 10, 10))).toHaveLength(3);
    expect(reshapeHandles(shape("diamond", 0, 0, 10, 10))).toHaveLength(4);
    expect(reshapeHandles(shape("pentagon", 0, 0, 10, 10))).toHaveLength(5);
    expect(reshapeHandles(shape("hexagon", 0, 0, 10, 10))).toHaveLength(6);
    expect(reshapeHandles(shape("star", 0, 0, 10, 10))).toHaveLength(10);
    expect(reshapeHandles(shape("line", 0, 0, 10, 10))).toHaveLength(0);
  });

  it("a_circle_has_four_handles_and_stretches_into_an_ellipse", () => {
    const el = shape("circle", 0, 0, 100, 100);
    const hs = reshapeHandles(el);
    expect(hs.map((h) => h.at)).toEqual([
      { x: 50, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 100 },
      { x: 0, y: 50 },
    ]);
    const wide = hs[1].apply({ x: 180, y: 50 });
    expect(wide.shapeType).toBe("ellipse");
    expect(wide.boxWidth).toBeCloseTo(180);
    expect(wide.boxHeight).toBeCloseTo(100);
    expect(wide.points[0].x).toBeCloseTo(0); // the opposite side stays
    const tall = hs[0].apply({ x: 50, y: -60 });
    expect(tall.boxHeight).toBeCloseTo(160);
    expect(tall.points[1].y).toBeCloseTo(100);
  });

  it("a_rotated_ellipse_stretches_along_its_own_axis", () => {
    const el = shape("ellipse", 0, 0, 100, 40, Math.PI / 2);
    const hs = reshapeHandles(el);
    // Turned a quarter: the "east" end of the long axis points down.
    close(hs[1].at, { x: 50, y: 70 });
    const west = hs[3].at;
    const next = hs[1].apply({ x: 50, y: 120 });
    expect(next.boxWidth).toBeCloseTo(150);
    expect(next.boxHeight).toBeCloseTo(40);
    close(reshapeHandles(next)[3].at, west); // the far end did not move
    close(reshapeHandles(next)[1].at, { x: 50, y: 120 });
  });

  it("a_snapped_curve_has_three_handles", () => {
    const pts = Array.from({ length: 21 }, (_, i) => ({ x: i * 5, y: Math.sin((i / 20) * Math.PI) * 30, pressure: 0.5, timestamp: i }));
    const curve: Element = { id: "c", pageId: "pg", type: "stroke", points: pts, color: "#000", width: 2, isHighlighter: false, content: { curve: true }, createdAt: "", updatedAt: "", version: 0 };
    expect(isCurveStroke(curve)).toBe(true);
    expect(isCurveStroke({ ...curve, content: undefined })).toBe(false);
    const hs = reshapeHandles(curve);
    expect(hs).toHaveLength(3);
    close(hs[0].at, { x: 0, y: 0 });
    close(hs[2].at, { x: 100, y: pts[20].y });
    // An end: the other end stays, the curve keeps its form (here: twice as long).
    const longer = hs[2].apply({ x: 200, y: 0 });
    close(longer.points[0], { x: 0, y: 0 });
    close(longer.points[20], { x: 200, y: 0 });
    expect(longer.points[10].y).toBeCloseTo(60, 0);
    // The middle: the curve passes through the point it is dragged to, ends in place.
    const bent = hs[1].apply({ x: 50, y: -40 });
    const mid = bent.points[(bent.points.length - 1) / 2];
    close(mid, { x: 50, y: -40 });
    close(bent.points[0], { x: 0, y: 0 });
    close(bent.points[bent.points.length - 1], { x: 100, y: pts[20].y });
  });
});
