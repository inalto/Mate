import { describe, expect, it } from "vitest";
import type { Page } from "../../model/types";
import { canSwipeAt, detectSwipe, type SwipeSample } from "../pageSwipe";

const page = (mode: Page["mode"]): Page => ({
  id: "p",
  sectionId: "s",
  title: "t",
  isExpanded: true,
  isFavourite: false,
  depth: 0,
  mode,
  backgroundConfig: { type: "ruled", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex: 0,
  createdAt: "",
  updatedAt: "",
  version: 0,
});

/** Evenly spaced samples from (x0, y0) to (x1, y1) over `ms`. */
function line(x0: number, y0: number, x1: number, y1: number, ms: number, t0 = 0, steps = 10): SwipeSample[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: x0 + ((x1 - x0) * i) / steps,
    y: y0 + ((y1 - y0) * i) / steps,
    t: t0 + (ms * i) / steps,
  }));
}

describe("detectSwipe", () => {
  it("leftward_is_minus_one_rightward_plus_one", () => {
    expect(detectSwipe(line(400, 300, 250, 310, 200))).toBe(-1);
    expect(detectSwipe(line(100, 300, 260, 290, 200))).toBe(1);
  });

  it("rejects_short_slow_long_or_diagonal_moves", () => {
    expect(detectSwipe(line(400, 300, 330, 300, 100))).toBeNull(); // 70 px
    expect(detectSwipe(line(400, 300, 300, 300, 500))).toBeNull(); // 0.2 px/ms
    expect(detectSwipe(line(800, 300, 200, 300, 700))).toBeNull(); // 700 ms
    expect(detectSwipe(line(400, 300, 250, 380, 200))).toBeNull(); // |dx| < 2|dy|
    expect(detectSwipe([{ x: 0, y: 0, t: 0 }])).toBeNull();
    expect(detectSwipe(line(0, 0, 0, 200, 200))).toBeNull(); // vertical
  });

  it("measures_from_the_last_direction_change", () => {
    // A slow drag right for a second, then a quick flick back left: the flick counts.
    const slow = line(100, 300, 400, 300, 1000);
    const flick = line(400, 300, 250, 300, 200, 1000).slice(1);
    expect(detectSwipe([...slow, ...flick])).toBe(-1);
    // A flick left that ends with a short drag back right is not a leftward swipe.
    const back = line(250, 300, 260, 300, 50, 1200, 2).slice(1);
    expect(detectSwipe([...line(400, 300, 250, 300, 200, 1000), ...back])).toBeNull();
  });
});

describe("canSwipeAt", () => {
  const vp = { width: 800, height: 600 };
  // Page mode at z = 1 in an 800 px viewport: x is clamped to [-1416, 1136].
  it("only_against_the_edge_pushed_towards", () => {
    const left = { x: 1136, y: 0, z: 1 };
    const right = { x: -1416, y: 0, z: 1 };
    const middle = { x: 0, y: 0, z: 1 };
    expect(canSwipeAt(left, page("page"), vp, 1)).toBe(true);
    expect(canSwipeAt(left, page("page"), vp, -1)).toBe(false);
    expect(canSwipeAt(right, page("page"), vp, -1)).toBe(true);
    expect(canSwipeAt(right, page("page"), vp, 1)).toBe(false);
    expect(canSwipeAt(middle, page("page"), vp, 1)).toBe(false);
    expect(canSwipeAt(middle, page("page"), vp, -1)).toBe(false);
  });

  it("zoomed_out_sheet_swipes_both_ways_canvas_never", () => {
    const out = { x: 0, y: 0, z: 0.1 };
    expect(canSwipeAt(out, page("page"), vp, 1)).toBe(true);
    expect(canSwipeAt(out, page("page"), vp, -1)).toBe(true);
    expect(canSwipeAt({ x: 0, y: 0, z: 1 }, page("canvas"), vp, 1)).toBe(false);
    expect(canSwipeAt({ x: -500, y: 0, z: 1 }, page("canvas"), vp, -1)).toBe(false);
  });
});
