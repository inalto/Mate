import { describe, expect, it } from "vitest";
import type { Vec2 } from "../../canvas/camera";
import type { Rect } from "../../tools/spatialIndex";
import { CURVE_SEGMENTS, ELBOW_PADDING, nearestT, pointAt, routePath } from "../route";

const A: Rect = { x: 0, y: 0, width: 100, height: 100 };
const B: Rect = { x: 300, y: 200, width: 100, height: 100 };

const pad = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, width: r.width + 2 * p, height: r.height + 2 * p });

/** True when an axis-aligned segment passes through the interior of `r`. */
function enters(a: Vec2, b: Vec2, r: Rect): boolean {
  return Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.width && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.height;
}

function expectElbow(route: Vec2[], start: Vec2, end: Vec2, boxes: Rect[]) {
  expect(route[0]).toEqual(start);
  expect(route[route.length - 1]).toEqual(end);
  expect(route.length).toBeLessThanOrEqual(6);
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i];
    const b = route[i + 1];
    expect(Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9).toBe(true);
  }
  // Stubs aside (first and last segment), nothing passes through a padded attached box.
  for (let i = 1; i + 2 < route.length; i++) for (const r of boxes) expect(enters(route[i], route[i + 1], pad(r, ELBOW_PADDING - 1e-6))).toBe(false);
}

describe("routePath", () => {
  it("straight_is_the_two_ends", () => {
    expect(routePath("straight", { x: 1, y: 2 }, "right", { x: 30, y: 40 }, null, [])).toEqual([
      { x: 1, y: 2 },
      { x: 30, y: 40 },
    ]);
  });

  it("curve_starts_and_ends_at_the_anchors_and_leaves_perpendicular", () => {
    const start = { x: 100, y: 50 };
    const end = { x: 300, y: 250 };
    const r = routePath("curve", start, "right", end, "left", []);
    expect(r).toHaveLength(CURVE_SEGMENTS + 1);
    expect(r[0]).toEqual(start);
    expect(r[r.length - 1]).toEqual(end);
    // Leaving the right side heads right first, entering the left side arrives from the left.
    expect(r[1].x).toBeGreaterThan(start.x);
    expect(Math.abs(r[1].y - start.y)).toBeLessThan(r[1].x - start.x);
    expect(r[r.length - 2].x).toBeLessThan(end.x);
  });

  it("elbow_is_axis_aligned_and_avoids_both_boxes", () => {
    const cases: [Vec2, "top" | "right" | "bottom" | "left", Vec2, "top" | "right" | "bottom" | "left"][] = [
      [{ x: 100, y: 50 }, "right", { x: 300, y: 250 }, "left"],
      [{ x: 50, y: 100 }, "bottom", { x: 350, y: 200 }, "top"],
      [{ x: 100, y: 50 }, "right", { x: 350, y: 200 }, "top"],
      // Facing away from each other: the route goes around.
      [{ x: 0, y: 50 }, "left", { x: 400, y: 250 }, "right"],
      [{ x: 50, y: 0 }, "top", { x: 350, y: 300 }, "bottom"],
    ];
    for (const [s, ss, e, es] of cases) expectElbow(routePath("elbow", s, ss, e, es, [A, B]), s, e, [A, B]);
  });

  it("elbow_with_a_free_end", () => {
    const s = { x: 100, y: 50 };
    const e = { x: 400, y: 400 };
    expectElbow(routePath("elbow", s, "right", e, null, [A]), s, e, [A]);
  });
});

describe("pointAt / nearestT", () => {
  const route = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];
  it("walk_by_arc_length", () => {
    expect(pointAt(route, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAt(route, 0.5)).toEqual({ x: 100, y: 0 });
    expect(pointAt(route, 0.75)).toEqual({ x: 100, y: 50 });
    expect(pointAt(route, 2)).toEqual({ x: 100, y: 100 });
  });
  it("nearestT_projects_onto_the_route", () => {
    expect(nearestT(route, { x: 50, y: -10 })).toBeCloseTo(0.25);
    expect(nearestT(route, { x: 130, y: 50 })).toBeCloseTo(0.75);
  });
});
