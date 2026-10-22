import { describe, expect, it } from "vitest";
import { resampleInkPoints, simplifyEpsForZoom, simplifyPolylineXY } from "../resample";
import type { Point } from "../types";

const pt = (x: number, y: number, pressure = 0.5, timestamp = 0): Point => ({ x, y, pressure, timestamp });

describe("resampleInkPoints", () => {
  it("straight_line_keeps_endpoints_and_is_dense", () => {
    const out = resampleInkPoints([pt(0, 0, 0.2, 0), pt(100, 0, 0.8, 10)]);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0]).toEqual(pt(0, 0, 0.2, 0));
    expect(out[out.length - 1]).toEqual(pt(100, 0, 0.8, 10));
    for (const p of out) expect(Math.abs(p.y)).toBeLessThan(1e-9);
  });

  it("curve_is_subdivided_within_tolerance", () => {
    // quarter circle of radius 50, sampled coarsely
    const src: Point[] = [];
    for (let i = 0; i <= 4; i++) {
      const a = (i / 4) * (Math.PI / 2);
      src.push(pt(50 * Math.cos(a), 50 * Math.sin(a), 0.5, i * 10));
    }
    const out = resampleInkPoints(src);
    expect(out.length).toBeGreaterThan(src.length);
    expect(out[0]).toEqual(src[0]);
    expect(out[out.length - 1]).toEqual(src[4]);
    // every output point stays close to the circle
    for (const p of out) expect(Math.abs(Math.hypot(p.x, p.y) - 50)).toBeLessThan(0.5);
    // no direction change between consecutive output segments exceeds 6 degrees (+ slack)
    for (let i = 1; i < out.length - 1; i++) {
      const a1 = Math.atan2(out[i].y - out[i - 1].y, out[i].x - out[i - 1].x);
      const a2 = Math.atan2(out[i + 1].y - out[i].y, out[i + 1].x - out[i].x);
      let d = Math.abs(a2 - a1);
      if (d > Math.PI) d = 2 * Math.PI - d;
      expect(d).toBeLessThan((8 * Math.PI) / 180);
    }
    // timestamps interpolated monotonically
    for (let i = 1; i < out.length; i++) expect(out[i].timestamp).toBeGreaterThanOrEqual(out[i - 1].timestamp);
  });

  it("sharp_corner_is_preserved", () => {
    const out = resampleInkPoints([pt(0, 0), pt(50, 0), pt(50, 50)]);
    expect(out.some((p) => p.x === 50 && p.y === 0)).toBe(true);
    // with flat tangents at the corner, the first leg stays on y = 0
    for (const p of out) if (p.x < 50) expect(Math.abs(p.y)).toBeLessThan(1e-9);
  });
});

describe("simplifyPolylineXY", () => {
  it("rdp_collinear_collapses", () => {
    const src = Array.from({ length: 10 }, (_, i) => pt(i * 3, i * 2, 0.1 * i, i));
    const out = simplifyPolylineXY(src, 0.1);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(src[0]);
    expect(out[1]).toEqual(src[9]);
  });

  it("rdp_keeps_corner", () => {
    const src = [pt(0, 0), pt(5, 0), pt(10, 0), pt(10, 5), pt(10, 10)];
    expect(simplifyPolylineXY(src, 0.1).map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });
});

describe("simplifyEpsForZoom", () => {
  it("eps_uses_pow2_bucket", () => {
    expect(simplifyEpsForZoom(1)).toBe(0.25);
    expect(simplifyEpsForZoom(1.5)).toBe(0.125);
    expect(simplifyEpsForZoom(0.3)).toBe(0.5);
    expect(simplifyEpsForZoom(10000)).toBe(0.25 / 256);
    expect(simplifyEpsForZoom(0.0001)).toBe(0.25 * 256);
  });
});
