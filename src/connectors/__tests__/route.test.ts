import { describe, expect, it } from "vitest";
import type { Vec2 } from "../../canvas/camera";
import type { Rect } from "../../tools/spatialIndex";
import type { Side } from "../../model/content";
import { CURVE_SEGMENTS, ELBOW_PADDING, SIDE_DIR, curveControls, curveShape, nearestT, pointAt, routePath } from "../route";

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

  it("curve_between_two_free_ends_bows_instead_of_running_straight", () => {
    const start = { x: 0, y: 0 };
    const end = { x: 200, y: 0 };
    const r = routePath("curve", start, null, end, null, []);
    expect(r).toHaveLength(CURVE_SEGMENTS + 1);
    expect(r[0]).toEqual(start);
    expect(r[r.length - 1]).toEqual(end);
    expect(Math.abs(r[CURVE_SEGMENTS / 2].y)).toBeGreaterThan(10);
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

describe("curve shapes", () => {
  const route = (s: Vec2, ss: Side | null, e: Vec2, es: Side | null) => routePath("curve", s, ss, e, es, []);
  const along = (p: Vec2, d: Vec2) => p.x * d.x + p.y * d.y;
  const cross = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  const norm = (a: Vec2, b: Vec2) => {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
  };

  // Start tangent follows d1; the end tangent arrives against d2 (the curve moves along -d2 into the end).
  function expectTangents(s: Vec2, ss: Side | null, e: Vec2, es: Side | null) {
    const [c1, c2] = curveControls(s, ss, e, es);
    const r = route(s, ss, e, es);
    const t0 = norm(s, c1);
    const t1 = norm(c2, e);
    expect(t0.x * (r[1].x - s.x) + t0.y * (r[1].y - s.y)).toBeGreaterThan(0);
    if (ss) {
      expect(t0.x).toBeCloseTo(SIDE_DIR[ss].x);
      expect(t0.y).toBeCloseTo(SIDE_DIR[ss].y);
    }
    if (es) {
      expect(t1.x).toBeCloseTo(-SIDE_DIR[es].x);
      expect(t1.y).toBeCloseTo(-SIDE_DIR[es].y);
    }
  }

  it("classifies by the two outward directions", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 200, y: 150 };
    expect(curveShape("right", "left", a, b)).toBe("S");
    expect(curveShape("top", "bottom", a, b)).toBe("S");
    expect(curveShape("right", "right", a, b)).toBe("U");
    expect(curveShape("bottom", "bottom", a, b)).toBe("U");
    expect(curveShape("right", "top", a, b)).toBe("C");
    expect(curveShape("left", "bottom", a, b)).toBe("C");
    expect(curveShape(null, null, a, b)).toBe("C");
  });

  it("S facing: control points sit half-way along the axis and the curve stays between the ends", () => {
    const s = { x: 0, y: 0 };
    const e = { x: 300, y: 120 };
    expect(curveControls(s, "right", e, "left")).toEqual([
      { x: 150, y: 0 },
      { x: 150, y: 120 },
    ]);
    for (const p of route(s, "right", e, "left")) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(300);
    }
    expectTangents(s, "right", e, "left");
  });

  it("S facing away swings out around both ends instead of cutting back between them", () => {
    const s = { x: 300, y: 0 };
    const e = { x: 0, y: 150 };
    const r = route(s, "right", e, "left");
    const xs = r.map((p) => p.x);
    expect(Math.max(...xs)).toBeGreaterThan(s.x + 20);
    expect(Math.min(...xs)).toBeLessThan(e.x - 20);
    expectTangents(s, "right", e, "left");
    // Reach grows with how far behind the end is.
    const near = curveControls({ x: 300, y: 0 }, "right", { x: 250, y: 150 }, "left")[0].x - 300;
    const far = curveControls({ x: 300, y: 0 }, "right", { x: 0, y: 150 }, "left")[0].x - 300;
    expect(far).toBeGreaterThan(near);
  });

  it("U passes beyond the farther end by a visible margin, on either axis", () => {
    const s = { x: 0, y: 0 };
    const e = { x: 120, y: 200 };
    const xs = route(s, "right", e, "right").map((p) => p.x);
    expect(Math.max(...xs)).toBeGreaterThan(e.x + 20);
    expectTangents(s, "right", e, "right");
    const ys = route({ x: 0, y: 0 }, "top", { x: 150, y: -90 }, "top").map((p) => p.y);
    expect(Math.min(...ys)).toBeLessThan(-90 - 20);
    expectTangents({ x: 0, y: 0 }, "top", { x: 150, y: -90 }, "top");
    // Reach grows with the perpendicular separation.
    const small = curveControls({ x: 0, y: 0 }, "right", { x: 0, y: 50 }, "right")[0].x;
    const big = curveControls({ x: 0, y: 0 }, "right", { x: 0, y: 400 }, "right")[0].x;
    expect(big).toBeGreaterThan(small);
  });

  it("C is a single bow with no inflection", () => {
    const s = { x: 0, y: 0 };
    const e = { x: 200, y: 200 };
    const r = route(s, "right", e, "top");
    const signs = new Set<number>();
    for (let i = 1; i < r.length - 1; i++) signs.add(Math.sign(cross(r[i - 1], r[i], r[i + 1])));
    signs.delete(0);
    expect(signs.size).toBe(1);
    expectTangents(s, "right", e, "top");
    // A quarter turn: the handles reach about half-way along each own axis.
    const [c1, c2] = curveControls(s, "right", e, "top");
    expect(c1.x).toBeCloseTo(110);
    expect(c2.y).toBeCloseTo(200 - 110);
  });

  it("tangents hold for every pair of sides", () => {
    const sides: Side[] = ["top", "right", "bottom", "left"];
    for (const ss of sides)
      for (const es of sides) expectTangents({ x: 10, y: 20 }, ss, { x: 260, y: 180 }, es);
  });

  it("one free end: the attached end leaves perpendicular and the curve reaches the free point smoothly", () => {
    const e = { x: 250, y: 40 };
    expectTangents({ x: 0, y: 0 }, "right", e, null);
    expectTangents(e, null, { x: 0, y: 0 }, "right");
    // Free point ahead of the side: no loop, x stays monotonic.
    const xs = route({ x: 0, y: 0 }, "right", e, null).map((p) => p.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 1e-9);
    // Free point behind it still leaves rightwards.
    const back = route({ x: 0, y: 0 }, "right", { x: -200, y: 30 }, null);
    expect(back[1].x).toBeGreaterThan(0);
    expect(back[0]).toEqual({ x: 0, y: 0 });
    expect(back[CURVE_SEGMENTS]).toEqual({ x: -200, y: 30 });
  });

  it("keeps the output shape for every case", () => {
    const sides: (Side | null)[] = [null, "top", "right", "bottom", "left"];
    for (const ss of sides)
      for (const es of sides) {
        const s = { x: 5, y: 7 };
        const e = { x: 123, y: -88 };
        const r = route(s, ss, e, es);
        expect(r).toHaveLength(CURVE_SEGMENTS + 1);
        expect(r[0]).toEqual(s);
        expect(r[CURVE_SEGMENTS]).toEqual(e);
        expect(along(r[1], { x: 1, y: 0 })).not.toBeNaN();
      }
  });
});
