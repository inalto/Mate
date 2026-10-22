import { describe, expect, it } from "vitest";
import { createStabilizer } from "../stabilize";
import type { Point } from "../types";

const pt = (x: number, y: number, pressure: number, timestamp = 0): Point => ({ x, y, pressure, timestamp });

describe("createStabilizer", () => {
  it("first_point_passthrough", () => {
    const s = createStabilizer(35, 1);
    expect(s(pt(3, 4, 0.7, 11))).toEqual(pt(3, 4, 0.7, 11));
  });

  it("formula_matches_spec", () => {
    const s = createStabilizer(35, 1);
    s(pt(0, 0, 0.5));
    const out = s(pt(10, 0, 1, 5));
    expect(Math.abs(out.x - 10 * (1 - Math.exp(-10 / 2.1)))).toBeLessThan(1e-9);
    expect(out.y).toBe(0);
    expect(Math.abs(out.pressure - (0.5 + 0.5 * (1 - Math.exp(-10 / 1.47))))).toBeLessThan(1e-9);
    expect(out.timestamp).toBe(5);
    // zoom scales the length: zoom 2 halves l (1.05)
    const z = createStabilizer(35, 2);
    z(pt(0, 0, 0.5));
    expect(Math.abs(z(pt(10, 0, 1)).x - 10 * (1 - Math.exp(-10 / 1.05)))).toBeLessThan(1e-9);
  });

  it("strength_zero_identity", () => {
    const s = createStabilizer(0, 1);
    s(pt(0, 0, 0.5));
    expect(s(pt(10, 7, 0.9, 2))).toEqual(pt(10, 7, 0.9, 2));
  });
});
