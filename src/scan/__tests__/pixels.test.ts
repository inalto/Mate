import { describe, expect, it } from "vitest";
import { rotate90, WORKING_MAX } from "../pixels";
import type { Pixels } from "../types";

/** A w×h image whose pixel i has red = i, so positions can be read back. */
function labelled(w: number, h: number): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([i, 100 + i, 200, 255], i * 4);
  return { data, width: w, height: h };
}

const reds = (p: Pixels) => Array.from({ length: p.width * p.height }, (_, i) => p.data[i * 4]);

describe("rotate90", () => {
  it("turns a 2×3 image clockwise into 3×2", () => {
    // a b        e c a
    // c d   ->   f d b
    // e f
    const src = labelled(2, 3);
    const out = rotate90(src);
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
    expect(reds(out)).toEqual([4, 2, 0, 5, 3, 1]);
    // Every channel travels with its pixel.
    expect(Array.from(out.data.subarray(0, 4))).toEqual([4, 104, 200, 255]);
  });

  it("is pure and comes back after four turns", () => {
    const src = labelled(2, 3);
    const copy = new Uint8ClampedArray(src.data);
    const back = rotate90(rotate90(rotate90(rotate90(src))));
    expect(src.data).toEqual(copy);
    expect(back).toEqual(src);
  });

  it("caps the working copy at 3000 px", () => {
    expect(WORKING_MAX).toBe(3000);
  });
});
