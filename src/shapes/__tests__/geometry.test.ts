import { describe, expect, it } from "vitest";
import type { Element, ShapeType } from "../../model/types";
import { effectiveCaps } from "../../model/content";
import { shapeBounds, shapeElementOutline, shapeFromDrag, shapeHit, shapeOutline } from "../geometry";

const rect = { x: 10, y: 20, width: 100, height: 50 };

function shape(shapeType: ShapeType, xy: [number, number][], extra: Partial<Element> = {}): Element {
  return {
    id: "s",
    pageId: "pg",
    type: "shape",
    shapeType,
    points: xy.map(([x, y]) => ({ x, y, pressure: 0.5, timestamp: 0 })),
    color: "#000000",
    fillColor: "transparent",
    width: 2,
    isHighlighter: false,
    content: { fillOpacity: 1 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 0,
    ...extra,
  };
}

describe("shape geometry", () => {
  it("rectangle_outline_has_4_corners", () => {
    const [poly, ...rest] = shapeOutline("rectangle", rect);
    expect(rest).toHaveLength(0);
    // Closed: four corners plus the first repeated.
    expect(poly).toHaveLength(5);
    expect(poly[4]).toEqual(poly[0]);
    expect(poly.slice(0, 4)).toEqual([
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 70 },
      { x: 10, y: 70 },
    ]);
  });

  it("ellipse_outline_is_closed_and_within_rect", () => {
    for (const type of ["ellipse", "circle"] as const) {
      const [poly] = shapeOutline(type, rect);
      expect(poly).toHaveLength(65);
      expect(poly[64].x).toBeCloseTo(poly[0].x);
      expect(poly[64].y).toBeCloseTo(poly[0].y);
      for (const p of poly) {
        expect(p.x).toBeGreaterThanOrEqual(rect.x - 1e-9);
        expect(p.x).toBeLessThanOrEqual(rect.x + rect.width + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(rect.y - 1e-9);
        expect(p.y).toBeLessThanOrEqual(rect.y + rect.height + 1e-9);
      }
      // Touches all four sides.
      expect(Math.min(...poly.map((p) => p.x))).toBeCloseTo(10);
      expect(Math.max(...poly.map((p) => p.y))).toBeCloseTo(70);
    }
  });

  it("arrow_has_head", () => {
    // Line/arrow rects are signed: (x, y) is the start, (x + width, y + height) the end.
    const line = shapeOutline("line", { x: 0, y: 0, width: 100, height: 0 });
    expect(line).toEqual([[{ x: 0, y: 0 }, { x: 100, y: 0 }]]);
    const [shaft, head] = shapeOutline("arrow", { x: 0, y: 0, width: 100, height: 0 }, 0, { headLength: 12 });
    expect(shaft).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(head).toHaveLength(4); // closed triangle
    expect(head[0]).toEqual({ x: 100, y: 0 }); // tip at the end point
    for (const p of head.slice(1, 3)) {
      expect(p.x).toBeCloseTo(100 - 12 * Math.cos(Math.PI / 6));
      expect(Math.abs(p.y)).toBeCloseTo(12 * Math.sin(Math.PI / 6));
    }
  });

  it("polygons_fill_their_rect", () => {
    for (const type of ["triangle", "diamond", "pentagon", "hexagon", "star", "polygon"] as const) {
      const [poly] = shapeOutline(type, rect);
      expect(poly[poly.length - 1]).toEqual(poly[0]);
      const xs = poly.map((p) => p.x);
      const ys = poly.map((p) => p.y);
      expect(Math.min(...xs)).toBeCloseTo(10);
      expect(Math.max(...xs)).toBeCloseTo(110);
      expect(Math.min(...ys)).toBeCloseTo(20);
      expect(Math.max(...ys)).toBeCloseTo(70);
    }
    expect(shapeOutline("star", rect)[0]).toHaveLength(11);
    expect(shapeOutline("pentagon", rect)[0]).toHaveLength(6);
    expect(shapeOutline("polygon", rect, 0, { sides: 8 })[0]).toHaveLength(9);
  });

  it("rotation_turns_the_outline_about_the_centre", () => {
    const [poly] = shapeOutline("rectangle", { x: 0, y: 0, width: 100, height: 50 }, Math.PI / 2);
    expect(poly[0].x).toBeCloseTo(75);
    expect(poly[0].y).toBeCloseTo(-25);
  });

  it("drag_normalises_and_constrains", () => {
    const r = shapeFromDrag("rectangle", { x: 100, y: 80 }, { x: 40, y: 50 }, false);
    expect(r.points.map((p) => [p.x, p.y])).toEqual([
      [40, 50],
      [100, 80],
    ]);
    expect([r.boxWidth, r.boxHeight]).toEqual([60, 30]);
    // Shift: square (the larger side, towards the drag).
    const sq = shapeFromDrag("rectangle", { x: 0, y: 0 }, { x: -60, y: 30 }, true);
    expect(sq.points.map((p) => [p.x, p.y])).toEqual([
      [-60, 0],
      [0, 60],
    ]);
    // A circle is always square.
    expect(shapeFromDrag("circle", { x: 0, y: 0 }, { x: 40, y: 10 }, false).boxHeight).toBe(40);
    // Lines keep direction; Shift snaps to 45 degrees.
    const ln = shapeFromDrag("line", { x: 10, y: 10 }, { x: 0, y: 30 }, false);
    expect(ln.points.map((p) => [p.x, p.y])).toEqual([
      [10, 10],
      [0, 30],
    ]);
    const snapped = shapeFromDrag("arrow", { x: 0, y: 0 }, { x: 100, y: 10 }, true);
    expect(snapped.points[1].y).toBeCloseTo(0);
    expect(snapped.points[1].x).toBeCloseTo(Math.hypot(100, 10));
  });

  it("element_outline_bounds_and_hit", () => {
    const el = shape("rectangle", [
      [0, 0],
      [100, 50],
    ], { boxWidth: 100, boxHeight: 50, width: 4 });
    expect(shapeElementOutline(el)[0]).toHaveLength(5);
    expect(shapeBounds(el)).toEqual({ x: -2, y: -2, width: 104, height: 54 });
    expect(shapeHit(el, { x: 100, y: 25 }, 1)).toBe(true); // on the edge
    expect(shapeHit(el, { x: 50, y: 25 }, 1)).toBe(true); // inside
    expect(shapeHit(el, { x: 150, y: 25 }, 1)).toBe(false);
    const ln = shape("line", [
      [0, 0],
      [100, 100],
    ]);
    expect(shapeHit(ln, { x: 50, y: 50 }, 1)).toBe(true);
    expect(shapeHit(ln, { x: 90, y: 10 }, 1)).toBe(false);
  });
});

describe("line caps", () => {
  const seg = { x: 0, y: 0, width: 100, height: 0 };

  it("legacy_arrow_without_caps_keeps_its_head", () => {
    const el = shape("arrow", [
      [0, 0],
      [100, 0],
    ]);
    const [shaft, head, ...rest] = shapeElementOutline(el);
    expect(shaft).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(head[0]).toEqual({ x: 100, y: 0 });
    expect(head).toHaveLength(4);
    expect(rest).toHaveLength(0);
    expect(effectiveCaps(el)).toEqual({ start: "none", end: "arrow" });
    expect(effectiveCaps(shape("line", [[0, 0], [1, 1]]))).toEqual({ start: "none", end: "none" });
    expect(effectiveCaps(shape("rectangle", [[0, 0], [1, 1]], { content: { fillOpacity: 1, caps: { start: "dot", end: "dot" } } }))).toEqual({
      start: "none",
      end: "none",
    });
  });

  it("dot_cap_is_a_16_segment_circle_on_the_end_point", () => {
    const [, dot] = shapeOutline("line", seg, 0, { caps: { start: "none", end: "dot" }, capWidth: 4 });
    expect(dot).toHaveLength(17); // closed
    expect(dot[16]).toEqual(dot[0]);
    const r = Math.max(3, 1.5 * 4);
    for (const p of dot) expect(Math.hypot(p.x - 100, p.y)).toBeCloseTo(r);
    // Thin lines keep a visible dot.
    const [, small] = shapeOutline("line", seg, 0, { caps: { start: "none", end: "dot" }, capWidth: 0.5 });
    expect(Math.hypot(small[0].x - 100, small[0].y)).toBeCloseTo(3);
  });

  it("bar_cap_is_perpendicular_and_centred", () => {
    const [, bar] = shapeOutline("line", seg, 0, { caps: { start: "bar", end: "none" }, capWidth: 2 });
    expect(bar).toHaveLength(2);
    const len = Math.max(10, 3 * 2);
    expect(bar[0].x).toBeCloseTo(0);
    expect(bar[1].x).toBeCloseTo(0);
    expect(Math.abs(bar[0].y - bar[1].y)).toBeCloseTo(len);
    expect(bar[0].y + bar[1].y).toBeCloseTo(0);
  });

  it("start_arrow_points_backwards_and_caps_come_start_then_end", () => {
    const polys = shapeOutline("line", seg, 0, { caps: { start: "arrow", end: "bar" }, headLength: 12, capWidth: 2 });
    expect(polys).toHaveLength(3);
    const [, head, bar] = polys;
    expect(head[0]).toEqual({ x: 0, y: 0 });
    for (const p of head.slice(1, 3)) expect(p.x).toBeCloseTo(12 * Math.cos(Math.PI / 6));
    expect(bar[0].x).toBeCloseTo(100);
    // An arrow element with caps none/none is a plain shaft.
    expect(shapeOutline("arrow", seg, 0, { caps: { start: "none", end: "none" } })).toHaveLength(1);
  });

  it("caps_extend_bounds_and_hit_testing", () => {
    const el = shape("line", [
      [0, 0],
      [100, 0],
    ], { content: { fillOpacity: 1, caps: { start: "none", end: "bar" } } });
    const b = shapeBounds(el);
    expect(b.height).toBeCloseTo(10 + 2);
    expect(shapeHit(el, { x: 100, y: 4.5 }, 0)).toBe(true);
    expect(shapeHit({ ...el, content: { fillOpacity: 1 } }, { x: 100, y: 4.5 }, 0)).toBe(false);
  });
});
