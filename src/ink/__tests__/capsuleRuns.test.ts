import { describe, expect, it } from "vitest";
import { capsuleRuns } from "../capsuleRuns";
import type { Disc } from "../types";

const discs = (rs: number[]): Disc[] => rs.map((r, i) => ({ x: i * 10, y: 0, r }));

describe("capsuleRuns", () => {
  it("constant_radius_one_run", () => {
    const runs = capsuleRuns(discs([2, 2, 2, 2, 2]), 0);
    expect(runs).toHaveLength(1);
    expect(runs[0].width).toBe(4);
    expect(runs[0].xy.length).toBe(10);
    expect(Array.from(runs[0].xy)).toEqual([0, 0, 10, 0, 20, 0, 30, 0, 40, 0]);
  });

  it("radius_jump_splits_run", () => {
    const runs = capsuleRuns(discs([2, 2, 2, 5, 5]), 0);
    expect(runs).toHaveLength(2);
    expect(runs[0].width).toBe(4);
    expect(runs[1].width).toBe(10);
    expect(Array.from(runs[0].xy)).toEqual([0, 0, 10, 0, 20, 0]);
    // second run starts at the joint so the stroke stays continuous
    expect(Array.from(runs[1].xy)).toEqual([20, 0, 30, 0, 40, 0]);
    // a radius change within tolerance (0.05) does not split
    expect(capsuleRuns(discs([2, 2.04, 2]), 0)).toHaveLength(1);
    // tolerance = max(0.05, 0.06*minR, simplifyEps)
    expect(capsuleRuns(discs([2, 2.3, 2]), 0)).toHaveLength(3);
    expect(capsuleRuns(discs([2, 2.3, 2]), 0.5)).toHaveLength(1);
  });

  it("single_disc", () => {
    const runs = capsuleRuns([{ x: 3, y: 4, r: 1.5 }], 0);
    expect(runs).toHaveLength(1);
    expect(runs[0].width).toBe(3);
    expect(Array.from(runs[0].xy)).toEqual([3, 4]);
  });
});
