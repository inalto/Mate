import { describe, expect, it } from "vitest";
import { equalSpacing, snapMove, snapResize } from "../smartGuides";

const r = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("smart guides", () => {
  const other = r(100, 0, 100, 50); // left 100, centre 150, right 200; top 0, middle 25, bottom 50

  it("snaps_the_left_edge_within_threshold", () => {
    const res = snapMove(r(103, 200, 40, 40), [other], 8);
    expect(res.dx).toBe(-3);
    expect(res.dy).toBe(0);
    expect(res.guides).toContainEqual({ axis: "x", at: 100, from: 0, to: 240 });
  });

  it("snaps_the_centre_within_threshold", () => {
    // moving centre at 155 -> other centre 150
    const res = snapMove(r(135, 300, 40, 40), [other], 8);
    expect(res.dx).toBe(-5);
    expect(res.guides.some((g) => g.axis === "x" && g.at === 150)).toBe(true);
  });

  it("snaps_the_right_edge_within_threshold", () => {
    // moving right edge at 206 -> other right 200
    const res = snapMove(r(166, 300, 40, 40), [other], 8);
    expect(res.dx).toBe(-6);
    expect(res.guides.some((g) => g.axis === "x" && g.at === 200)).toBe(true);
  });

  it("does_not_snap_beyond_threshold", () => {
    const res = snapMove(r(110, 300, 30, 40), [other], 8); // nearest pairs are 10 away (110/100, 140/150)
    expect(res).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("snaps_both_axes_independently_and_prefers_the_nearest_match", () => {
    // left 98 (-> 100, d=2) beats right 138 (-> 150 centre? d=12, out); top 53 -> bottom 50 (d=-3)
    const res = snapMove(r(98, 53, 40, 40), [other], 8);
    expect(res.dx).toBe(2);
    expect(res.dy).toBe(-3);
    expect(res.guides.some((g) => g.axis === "y" && g.at === 50)).toBe(true);
  });

  it("snap_resize_snaps_one_edge", () => {
    expect(snapResize("x", 204, [other], 8)).toEqual({ at: 200, guide: { axis: "x", at: 200, from: 0, to: 50 } });
    expect(snapResize("y", 30, [other], 8).at).toBe(25);
    expect(snapResize("x", 220, [other], 8)).toEqual({ at: 220, guide: null });
  });

  it("equal_spacing_finds_the_gap_between_two_neighbours", () => {
    const left = r(0, 0, 100, 50); // right edge 100
    const right = r(260, 0, 100, 50); // left edge 260
    // moving 60 wide at x 132: gaps 32 and 68 - not equal
    expect(equalSpacing(r(132, 10, 60, 30), [left, right], 4)).toEqual([]);
    // moving at x 150: gaps 50 and 50
    const guides = equalSpacing(r(150, 10, 60, 30), [left, right], 4);
    expect(guides).toHaveLength(2);
    expect(guides.map((g) => [g.axis, g.from, g.to, g.label])).toEqual([
      ["y", 100, 150, "50"],
      ["y", 210, 260, "50"],
    ]);
  });

  it("equal_spacing_ignores_neighbours_not_overlapping_on_the_other_axis", () => {
    const left = r(0, 500, 100, 50);
    const right = r(260, 0, 100, 50);
    expect(equalSpacing(r(150, 10, 60, 30), [left, right], 4)).toEqual([]);
  });
});
