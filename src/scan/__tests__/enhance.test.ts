// Tests for the grey and black-and-white clean-up modes.
import { describe, expect, it } from "vitest";
import { applyMode, toBlackWhite, toGrey } from "../enhance";
import type { Pixels } from "../types";

function make(w: number, h: number, f: (x: number, y: number) => [number, number, number, number?]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = f(x, y);
      data.set([r, g, b, a], (y * w + x) * 4);
    }
  return { data, width: w, height: h };
}

describe("toGrey", () => {
  it("makes r = g = b, keeps alpha, uses a new buffer", () => {
    const src = make(5, 4, (x, y) => [x * 50, y * 60, 200 - x * 10, 100 + x]);
    const out = toGrey(src);
    expect(out.data).not.toBe(src.data);
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(out.data[i + 1]);
      expect(out.data[i]).toBe(out.data[i + 2]);
      expect(out.data[i + 3]).toBe(src.data[i + 3]);
    }
    const o = make(1, 1, () => [255, 0, 0]);
    expect(toGrey(o).data[0]).toBe(Math.round(0.299 * 255));
  });
});

describe("toBlackWhite", () => {
  it("whitens uneven paper and keeps a thin stroke dark", () => {
    const src = make(64, 64, (x) => {
      const v = Math.round(140 + (90 * x) / 63);
      const c = x >= 30 && x < 34 ? 40 : v;
      return [c, c, c];
    });
    const out = toBlackWhite(src);
    expect(out.data).not.toBe(src.data);
    for (let y = 0; y < 64; y += 9)
      for (let x = 0; x < 64; x++) {
        const v = out.data[(y * 64 + x) * 4];
        if (Math.abs(x - 31.5) >= 9) expect(v).toBeGreaterThanOrEqual(240);
        if (x === 31 || x === 32) expect(v).toBeLessThanOrEqual(60);
        expect(out.data[(y * 64 + x) * 4 + 3]).toBe(255);
      }
  });
});

describe("applyMode", () => {
  it("returns the input itself for colour", () => {
    const p = make(2, 2, () => [1, 2, 3]);
    expect(applyMode(p, "colour")).toBe(p);
    expect(applyMode(p, "grey").data[0]).toBe(applyMode(p, "grey").data[1]);
    expect(applyMode(p, "bw").width).toBe(2);
  });
});
