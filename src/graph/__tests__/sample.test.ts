import { describe, expect, it } from "vitest";
import { sampleCurve, sampleParametric } from "../sample";

const finite = (pts: { x: number; y: number }[][]) => pts.every((b) => b.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));

describe("sampleCurve", () => {
  it("plot_skips_non_finite_samples", () => {
    const branches = sampleCurve((x) => 1 / x, -1, 1, { yRange: 20 });
    expect(branches.length).toBeGreaterThanOrEqual(2);
    expect(finite(branches)).toBe(true);
    // Left branch stays negative, right branch positive: nothing joins across the pole.
    for (const b of branches) {
      const signs = new Set(b.map((p) => Math.sign(p.y)));
      expect(signs.size).toBe(1);
    }
  });

  it("tan_splits_into_branches", () => {
    // tan has 6 poles in -10..10 (±π/2, ±3π/2, ±5π/2): 7 branches.
    const branches = sampleCurve(Math.tan, -10, 10, { yRange: 20 });
    expect(branches.length).toBe(7);
    expect(finite(branches)).toBe(true);
    for (const b of branches) for (let i = 1; i < b.length; i++) expect(b[i].y).toBeGreaterThanOrEqual(b[i - 1].y);
  });

  it("smooth_curve_is_one_branch", () => {
    const branches = sampleCurve(Math.sin, -10, 10, { yRange: 20 });
    expect(branches.length).toBe(1);
    expect(branches[0].length).toBeGreaterThanOrEqual(256);
    expect(branches[0][0].x).toBeCloseTo(-10);
    expect(branches[0][branches[0].length - 1].x).toBeCloseTo(10);
  });

  it("refines_where_the_curve_bends", () => {
    // 256 even samples over 200 units cannot follow sin at a 2-unit scale: refinement adds points.
    const [b] = sampleCurve(Math.sin, -100, 100, { yRange: 2 });
    expect(b.length).toBeGreaterThan(256);
    expect(b.length).toBeLessThanOrEqual(2048);
  });

  it("steep_continuous_curve_is_not_split", () => {
    expect(sampleCurve((x) => x ** 3, -10, 10, { yRange: 20 }).length).toBe(1);
  });

  it("never_exceeds_the_sample_cap", () => {
    let calls = 0;
    const wild = (x: number) => {
      calls++;
      return Math.sin(1 / x) * 1e6;
    };
    const branches = sampleCurve(wild, -1, 1, { yRange: 2, max: 2048 });
    const total = branches.reduce((s, b) => s + b.length, 0);
    expect(total).toBeLessThanOrEqual(2048);
    expect(calls).toBeLessThanOrEqual(2048 * 2 + 2);
  });

  it("all_nan_gives_no_branches", () => {
    expect(sampleCurve(() => NaN, 0, 1, { yRange: 1 })).toEqual([]);
  });

  it("parametric_circle_closes", () => {
    const [b] = sampleParametric(Math.cos, Math.sin, 0, 2 * Math.PI, { xRange: 4, yRange: 4 });
    expect(b[0].x).toBeCloseTo(1);
    expect(b[b.length - 1].x).toBeCloseTo(1);
    expect(b[b.length - 1].y).toBeCloseTo(0);
  });
});
