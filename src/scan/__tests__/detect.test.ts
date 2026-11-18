import { describe, expect, it } from "vitest";
import { detectQuad, downscale } from "../detect";
import type { Pixels, Point, Quad } from "../types";

const W = 512;
const H = 384;

/** mulberry32: a tiny seeded PRNG so the noise is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inside a convex polygon (either winding): every edge cross product has the same sign. */
function inside(poly: readonly Point[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (c === 0) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** A dark (40) ground with light (230) convex polygons, plus mild seeded noise. */
function paint(polys: readonly (readonly Point[])[], ground = 40, light = 230, w = W, h = H, seed = 7): Pixels {
  const rnd = prng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lit = polys.some((p) => inside(p, x + 0.5, y + 0.5));
      const v = (lit ? light : ground) + Math.round((rnd() - 0.5) * 24);
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

function uniform(v: number, w = W, h = H): Pixels {
  const data = new Uint8ClampedArray(w * h * 4).fill(v);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width: w, height: h };
}

function expectCorners(found: Quad | null, truth: Quad, tol = 6) {
  expect(found).not.toBeNull();
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot(found![i].x - truth[i].x, found![i].y - truth[i].y);
    expect(d, `corner ${i}: ${JSON.stringify(found![i])} vs ${JSON.stringify(truth[i])}`).toBeLessThanOrEqual(tol);
  }
}

function rotated(cx: number, cy: number, hw: number, hh: number, deg: number): Quad {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const at = (dx: number, dy: number): Point => ({ x: cx + dx * c - dy * s, y: cy + dx * s + dy * c });
  return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
}

describe("downscale", () => {
  it("returns the input itself when already small enough", () => {
    const p = uniform(100, 200, 100);
    expect(downscale(p, 256)).toBe(p);
  });

  it("box-averages to the long side cap, keeping the aspect", () => {
    const p = uniform(0, 512, 384);
    for (let x = 0; x < 512; x += 2) for (let y = 0; y < 384; y++) p.data[(y * 512 + x) * 4] = 200;
    const d = downscale(p, 256);
    expect(d.width).toBe(256);
    expect(d.height).toBe(192);
    expect(d.data[0]).toBe(100); // black|white columns average out
    expect(d.data[3]).toBe(255);
  });
});

describe("detectQuad", () => {
  it("finds an upright rectangle", () => {
    const truth: Quad = [
      { x: 100, y: 60 },
      { x: 400, y: 60 },
      { x: 400, y: 330 },
      { x: 100, y: 330 },
    ];
    expectCorners(detectQuad(paint([truth])), truth);
  });

  it("finds a perspective-skewed quad", () => {
    const truth: Quad = [
      { x: 140, y: 50 },
      { x: 390, y: 80 },
      { x: 450, y: 340 },
      { x: 60, y: 300 },
    ];
    expectCorners(detectQuad(paint([truth])), truth);
  });

  it("finds a quad rotated about 30 degrees", () => {
    const truth = rotated(256, 192, 120, 80, 30);
    // Rotating by 30° moves the geometric top-left; compare against the same ordering detection uses.
    const found = detectQuad(paint([truth]));
    expect(found).not.toBeNull();
    const ordered = [...truth].sort((a, b) => a.x + a.y - (b.x + b.y));
    expect(Math.hypot(found![0].x - ordered[0].x, found![0].y - ordered[0].y)).toBeLessThanOrEqual(6);
    for (const corner of truth) {
      const best = Math.min(...found!.map((f) => Math.hypot(f.x - corner.x, f.y - corner.y)));
      expect(best).toBeLessThanOrEqual(6);
    }
  });

  it("returns null on a uniform grey image", () => {
    expect(detectQuad(paint([], 128))).toBeNull();
    expect(detectQuad(uniform(128))).toBeNull();
  });

  it("returns null on an all-white image", () => {
    expect(detectQuad(uniform(255))).toBeNull();
  });

  it("returns null when the light blob covers less than 10 % of the frame", () => {
    const small: Quad = [
      { x: 200, y: 150 },
      { x: 280, y: 150 },
      { x: 280, y: 230 },
      { x: 200, y: 230 },
    ];
    expect(detectQuad(paint([small]))).toBeNull();
  });

  it("returns null when the light quad touches all four borders", () => {
    const fills: Quad = [
      { x: 256, y: -20 },
      { x: 540, y: 192 },
      { x: 256, y: 404 },
      { x: -28, y: 192 },
    ];
    expect(detectQuad(paint([fills]))).toBeNull();
  });

  it("prefers the larger quad over a smaller light patch", () => {
    const big: Quad = [
      { x: 60, y: 50 },
      { x: 330, y: 70 },
      { x: 320, y: 340 },
      { x: 70, y: 320 },
    ];
    const patch: Quad = [
      { x: 390, y: 100 },
      { x: 480, y: 100 },
      { x: 480, y: 200 },
      { x: 390, y: 200 },
    ];
    expectCorners(detectQuad(paint([big, patch])), big);
  });

  it("works on a larger photo, returning source-pixel corners", () => {
    const truth: Quad = [
      { x: 300, y: 200 },
      { x: 1700, y: 260 },
      { x: 1650, y: 1300 },
      { x: 250, y: 1250 },
    ];
    // At 2000 px the 256 copy is ~7.8x smaller, so 3 px there is ~24 px here.
    expectCorners(detectQuad(paint([truth], 40, 230, 2000, 1500)), truth, 24);
  });
});
