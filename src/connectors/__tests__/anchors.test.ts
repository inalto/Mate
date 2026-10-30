import { describe, expect, it } from "vitest";
import type { Element, ShapeType } from "../../model/types";
import { shapeElement, shapeElementOutline, shapeFromDrag } from "../../shapes/geometry";
import { anchorPoint, anchors, nearestAnchor, resolveSide, SIDES } from "../anchors";
import "../../renderers/builtins";

const STAMP = "2026-01-01T00:00:00.000Z";
const style = (shapeType: ShapeType) => ({ shapeType, color: "#000000", fillColor: "transparent", width: 2, fillOpacity: 1 });

function shape(shapeType: ShapeType, x0: number, y0: number, x1: number, y1: number, rotation = 0): Element {
  const el = shapeElement(style(shapeType), shapeFromDrag(shapeType, { x: x0, y: y0 }, { x: x1, y: y1 }, false), "pg", shapeType, STAMP);
  return rotation ? { ...el, content: { ...(el.content as object), rotation } } : el;
}

function distToOutline(el: Element, p: { x: number; y: number }): number {
  const [poly] = shapeElementOutline(el);
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y));
  }
  return best;
}

describe("anchors", () => {
  it("lie_on_the_outline_of_a_rotated_rectangle", () => {
    const el = shape("rectangle", 0, 0, 200, 100, Math.PI / 6);
    for (const side of SIDES) expect(distToOutline(el, anchorPoint(el, side))).toBeLessThan(1e-6);
    // Top anchor is above the centre, right anchor to its right.
    const a = anchors(el);
    expect(a.top.y).toBeLessThan(50);
    expect(a.right.x).toBeGreaterThan(100);
  });

  it("lie_on_the_outline_of_an_ellipse", () => {
    const el = shape("ellipse", 0, 0, 200, 100);
    for (const side of SIDES) expect(distToOutline(el, anchorPoint(el, side))).toBeLessThan(1e-6);
    const a = anchors(el);
    expect(a.top.x).toBeCloseTo(100);
    expect(a.top.y).toBeCloseTo(0);
    expect(a.right.x).toBeCloseTo(200);
    expect(a.right.y).toBeCloseTo(50);
  });

  it("use_the_endpoints_of_a_line_shape", () => {
    const el = shape("line", 100, 0, 0, 50);
    const a = anchors(el);
    expect(a.left).toMatchObject({ x: 0, y: 50 });
    expect(a.right).toMatchObject({ x: 100, y: 0 });
    expect(a.top).toMatchObject({ x: 50, y: 25 });
    expect(a.bottom).toMatchObject({ x: 50, y: 25 });
  });

  it("use_side_midpoints_of_a_boxed_element", () => {
    const box: Element = {
      id: "tb",
      pageId: "pg",
      type: "text-box",
      points: [{ x: 10, y: 20, pressure: 0.5, timestamp: 0 }],
      color: "#000",
      width: 1,
      isHighlighter: false,
      boxWidth: 100,
      boxHeight: 40,
      content: {},
      createdAt: STAMP,
      updatedAt: STAMP,
      version: 0,
    };
    expect(anchors(box)).toEqual({
      top: { x: 60, y: 20 },
      right: { x: 110, y: 40 },
      bottom: { x: 60, y: 60 },
      left: { x: 10, y: 40 },
    });
  });

  it("resolveSide_picks_the_facing_side", () => {
    const el = shape("rectangle", 0, 0, 100, 100);
    expect(resolveSide(el, { x: 400, y: 50 })).toBe("right");
    expect(resolveSide(el, { x: -300, y: 60 })).toBe("left");
    expect(resolveSide(el, { x: 50, y: -300 })).toBe("top");
    expect(resolveSide(el, { x: 40, y: 500 })).toBe("bottom");
  });

  it("nearestAnchor_respects_the_distance", () => {
    const el = shape("rectangle", 0, 0, 100, 100);
    const hit = nearestAnchor(el, { x: 105, y: 52 }, 10);
    expect(hit?.side).toBe("right");
    expect(nearestAnchor(el, { x: 150, y: 52 }, 10)).toBeNull();
  });
});
