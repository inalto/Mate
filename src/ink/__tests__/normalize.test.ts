import { describe, expect, it } from "vitest";
import { normalizePoint } from "../normalize";

describe("normalizePoint", () => {
  it("pressure_nan_becomes_half", () => {
    expect(normalizePoint({ x: 1, y: 2, pressure: NaN, timestamp: 3 }).pressure).toBe(0.5);
    expect(normalizePoint({ x: 1, y: 2, timestamp: 3 }).pressure).toBe(0.5);
  });

  it("pressure_zero_becomes_half", () => {
    expect(normalizePoint({ x: 0, y: 0, pressure: 0, timestamp: 0 }).pressure).toBe(0.5);
    expect(normalizePoint({ x: 0, y: 0, pressure: -0.2, timestamp: 0 }).pressure).toBe(0.5);
  });

  it("pressure_clamped_to_1", () => {
    const p = normalizePoint({ x: 4, y: 5, pressure: 1.7, timestamp: 9, tiltX: 10, tiltY: -5 });
    expect(p).toEqual({ x: 4, y: 5, pressure: 1, timestamp: 9, tiltX: 10, tiltY: -5 });
    expect(normalizePoint({ x: 0, y: 0, pressure: 0.3, timestamp: 0 }).pressure).toBe(0.3);
  });
});
