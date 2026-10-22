import { describe, expect, it } from "vitest";
import { detectRealPressure, penParams, strokeDiscs } from "../strokePoints";
import type { Point } from "../types";

const pt = (x: number, y: number, pressure = 0.5, extra: Partial<Point> = {}): Point => ({
  x,
  y,
  pressure,
  timestamp: 0,
  ...extra,
});

describe("detectRealPressure", () => {
  it("default_pressure_is_simulated", () => {
    expect(detectRealPressure([pt(0, 0), pt(1, 0, 0.51)])).toBe(false);
    expect(detectRealPressure([pt(0, 0), pt(1, 0, 0.52)])).toBe(true);
    expect(detectRealPressure([pt(0, 0, 0.5, { tiltX: 12 })])).toBe(true);
  });
});

describe("penParams", () => {
  it("pen_is_constant_width", () => {
    const p = penParams("pen", 4, true);
    expect(p).toMatchObject({ size: 4, thinning: 0, smoothing: 0.5, streamline: 0, simulatePressure: false });
    expect(p.outline).toBe(false);
    expect(p.resampleTolerance).toBe(0.08);
  });

  it("fountain_real_and_simulated", () => {
    const real = penParams("fountain-pen", 6, true);
    expect(real).toMatchObject({ size: 6, thinning: 0.7, smoothing: 0.6, streamline: 0.55, simulatePressure: false });
    expect(real.start?.taper).toBe(5);
    expect(real.end?.taper).toBe(5);
    expect(real.start?.cap).toBe(true);
    expect(real.outline).toBe(true);
    const sim = penParams("fountain-pen", 6, false, 0.45);
    expect(sim).toMatchObject({ thinning: 0.65, smoothing: 0.75, streamline: 0.65, simulatePressure: true });
    expect(sim.start?.taper).toBeCloseTo(10, 12);
    expect(sim.end?.taper).toBeCloseTo(10, 12);
    expect(sim.start?.easing?.(0.5)).toBe(0.125);
    expect(sim.end?.easing?.(0.5)).toBe(0.125);
  });

  it("highlighter_and_pencil", () => {
    expect(penParams("highlighter", 20, false)).toMatchObject({
      size: 20,
      thinning: 0,
      smoothing: 0.5,
      streamline: 0.5,
      outline: true,
    });
    expect(penParams("pencil", 3, false)).toMatchObject({
      size: 3,
      thinning: 0.1,
      smoothing: 0.9,
      streamline: 0.4,
      outline: false,
    });
  });
});

describe("strokeDiscs", () => {
  it("pen_discs_have_half_size_radius", () => {
    const pts = [pt(0, 0), pt(10, 0), pt(20, 0), pt(30, 0)];
    const d = strokeDiscs(pts, penParams("pen", 4, false));
    expect(d.length).toBeGreaterThanOrEqual(2);
    for (const disc of d) expect(disc.r).toBe(2);
    expect(d[0]).toEqual({ x: 0, y: 0, r: 2 });
    expect(d[d.length - 1]).toEqual({ x: 30, y: 0, r: 2 });
  });

  it("thinning_and_point_width", () => {
    const d = strokeDiscs([pt(0, 0, 1), pt(10, 0, 1), pt(20, 0, 1)], penParams("pencil", 4, true));
    // r = size/2 * (1 + 0.1 * (1 - 0.5)) = 2.1
    for (const disc of d) expect(disc.r).toBeCloseTo(2.1, 12);
    const w = strokeDiscs([pt(0, 0, 0.5, { width: 6 }), pt(10, 0, 0.5, { width: 6 })], penParams("pen", 4, false));
    for (const disc of w) expect(disc.r).toBe(3);
    // min radius = min(0.4, size/2)
    const tiny = strokeDiscs([pt(0, 0, 0.01), pt(10, 0, 0.01)], { ...penParams("pencil", 0.2, true), thinning: 1 });
    for (const disc of tiny) expect(disc.r).toBe(0.1);
  });

  it("single_point_one_disc", () => {
    expect(strokeDiscs([pt(5, 6)], penParams("pen", 4, false))).toEqual([{ x: 5, y: 6, r: 2 }]);
  });
});
