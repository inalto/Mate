import { describe, expect, it } from "vitest";
import { insetQuad, isConvexQuad, orderQuad, outputSize, quadArea } from "../quad";
import type { Point, Quad } from "../types";

const rect = (w: number, h: number): Quad => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

describe("orderQuad", () => {
  const skewed: Quad = [
    { x: 20, y: 10 },
    { x: 220, y: 40 },
    { x: 200, y: 180 },
    { x: 5, y: 150 },
  ];

  it("recovers TL, TR, BR, BL from all 24 permutations of a skewed quad", () => {
    const perms = permutations([...skewed]);
    expect(perms).toHaveLength(24);
    for (const p of perms) expect(orderQuad(p)).toEqual(skewed);
  });
});

describe("isConvexQuad", () => {
  it("accepts a rectangle and a skewed convex quad", () => {
    expect(isConvexQuad(rect(10, 5))).toBe(true);
    expect(
      isConvexQuad([
        { x: 20, y: 10 },
        { x: 220, y: 40 },
        { x: 200, y: 180 },
        { x: 5, y: 150 },
      ]),
    ).toBe(true);
  });

  it("rejects a bow-tie", () => {
    const [a, b, c, d] = rect(10, 10);
    expect(isConvexQuad([a, b, d, c])).toBe(false);
  });

  it("rejects a concave (dart) quad", () => {
    expect(
      isConvexQuad([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 2 },
        { x: 0, y: 10 },
      ]),
    ).toBe(false);
  });

  it("rejects three collinear points", () => {
    expect(
      isConvexQuad([
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 10 },
      ]),
    ).toBe(false);
  });

  it("rejects a zero-area quad", () => {
    const p: Point = { x: 3, y: 3 };
    expect(isConvexQuad([p, p, p, p])).toBe(false);
  });
});

describe("quadArea", () => {
  it("is absolute, whatever the winding", () => {
    expect(quadArea(rect(4, 3))).toBeCloseTo(12);
    const [a, b, c, d] = rect(4, 3);
    expect(quadArea([d, c, b, a])).toBeCloseTo(12);
  });
});

describe("outputSize", () => {
  it("scales a 4000x3000 rectangle down to 2400x1800", () => {
    expect(outputSize(rect(4000, 3000))).toEqual({ width: 2400, height: 1800 });
  });

  it("never upscales a 300x200 rectangle", () => {
    expect(outputSize(rect(300, 200))).toEqual({ width: 300, height: 200 });
  });

  it("is at least 16 px: a 4x4 quad gives 16x16", () => {
    expect(outputSize(rect(4, 4))).toEqual({ width: 16, height: 16 });
  });

  it("honours a custom maxLongSide and returns integers", () => {
    const s = outputSize(rect(1000, 333), 500);
    expect(s.width).toBe(500);
    expect(Number.isInteger(s.height)).toBe(true);
  });
});

describe("insetQuad", () => {
  it("insets 10 % from each edge by default", () => {
    const q = insetQuad(100, 200);
    expect(q[0]).toEqual({ x: 10, y: 20 });
    expect(q[2]).toEqual({ x: 90, y: 180 });
    expect(isConvexQuad(q)).toBe(true);
  });

  it("takes a fraction", () => {
    expect(insetQuad(100, 100, 0.25)[0]).toEqual({ x: 25, y: 25 });
  });
});
