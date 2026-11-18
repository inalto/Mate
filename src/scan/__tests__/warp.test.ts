// Tests for the perspective warp, on plain Pixels objects (no canvas).
import { describe, expect, it } from "vitest";
import { warpPerspective } from "../warp";
import type { Pixels, Quad } from "../types";

function make(w: number, h: number, f: (x: number, y: number) => [number, number, number]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  return { data, width: w, height: h };
}
const px = (p: Pixels, x: number, y: number) => Array.from(p.data.slice((y * p.width + x) * 4, (y * p.width + x) * 4 + 4));
const rect = (w: number, h: number): Quad => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

describe("warpPerspective", () => {
  it("returns equal pixels for the image's own corners", () => {
    const src = make(20, 12, (x, y) => [x * 10, y * 20, (x * y) % 256]);
    const out = warpPerspective(src, rect(20, 12), 20, 12);
    expect(out.width).toBe(20);
    expect(out.height).toBe(12);
    for (let i = 0; i < src.data.length; i++) expect(Math.abs(out.data[i] - src.data[i])).toBeLessThanOrEqual(1);
  });

  it("maps the quadrants of a skewed quad to 32x32 with the right colours", () => {
    const colours: [number, number, number][] = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
    ];
    // Quad (skewed) inside a 64x64 image; paint each quadrant of the quad by mapping back.
    const quad: Quad = [
      { x: 8, y: 6 },
      { x: 56, y: 12 },
      { x: 52, y: 58 },
      { x: 4, y: 50 },
    ];
    const bilerp = (u: number, v: number) => ({
      x: (1 - v) * ((1 - u) * quad[0].x + u * quad[1].x) + v * ((1 - u) * quad[3].x + u * quad[2].x),
      y: (1 - v) * ((1 - u) * quad[0].y + u * quad[1].y) + v * ((1 - u) * quad[3].y + u * quad[2].y),
    });
    // Paint each quadrant of the quad solid by densely sampling it.
    const src = make(64, 64, () => [128, 128, 128]);
    for (let j = 0; j < 200; j++)
      for (let i = 0; i < 200; i++) {
        const u = (i + 0.5) / 200;
        const v = (j + 0.5) / 200;
        const p = bilerp(u, v);
        const c = colours[(v < 0.5 ? 0 : 2) + (u < 0.5 ? 0 : 1)];
        src.data.set([c[0], c[1], c[2], 255], (Math.floor(p.y) * 64 + Math.floor(p.x)) * 4);
      }
    const out = warpPerspective(src, quad, 32, 32);
    const near = (a: number[], b: number[]) => a.slice(0, 3).every((v, k) => Math.abs(v - b[k]) <= 2);
    expect(near(px(out, 8, 8), colours[0])).toBe(true);
    expect(near(px(out, 24, 8), colours[1])).toBe(true);
    expect(near(px(out, 8, 24), colours[2])).toBe(true);
    expect(near(px(out, 24, 24), colours[3])).toBe(true);
    expect(px(out, 5, 5)[3]).toBe(255);
  });

  it("interpolates bilinearly when stretching", () => {
    const src = make(2, 1, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]));
    const out = warpPerspective(src, rect(2, 1), 4, 1);
    const v = [0, 1, 2, 3].map((x) => px(out, x, 0)[0]);
    for (let i = 1; i < 4; i++) expect(v[i]).toBeGreaterThan(v[i - 1]);
  });

  it("throws on a degenerate quad", () => {
    const src = make(4, 4, () => [0, 0, 0]);
    const line: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    expect(() => warpPerspective(src, line, 4, 4)).toThrow("degenerate quad");
  });
});
