import { describe, expect, it } from "vitest";
import { PAGE_WIDTH } from "../../model/constants";
import {
  MIN_TICK_PX,
  UNITS_PER_INCH,
  UNITS_PER_MM,
  edgeSystems,
  formatLength,
  lengthSnapUnits,
  tickStep,
  ticks,
} from "../scale";

describe("ruler scale", () => {
  it("maps 1080 page units to 210 mm", () => {
    expect(UNITS_PER_MM * 210).toBeCloseTo(PAGE_WIDTH, 9);
    expect(UNITS_PER_INCH).toBeCloseTo(UNITS_PER_MM * 25.4, 9);
  });

  it("picks the metric step from the zoom", () => {
    expect(tickStep("metric", 2)).toBeCloseTo(UNITS_PER_MM, 9);
    expect(tickStep("metric", 0.5)).toBeCloseTo(5 * UNITS_PER_MM, 9);
    expect(tickStep("metric", 0.1)).toBeCloseTo(10 * UNITS_PER_MM, 9);
  });

  it("walks the imperial steps as the zoom falls and keeps ticks apart on screen", () => {
    const inch = UNITS_PER_INCH;
    expect(tickStep("imperial", 2)).toBeCloseTo(inch / 16, 9);
    expect(tickStep("imperial", 0.5)).toBeCloseTo(inch / 8, 9);
    expect(tickStep("imperial", 0.2)).toBeCloseTo(inch / 4, 9);
    expect(tickStep("imperial", 0.1)).toBeCloseTo(inch, 9);
    for (const system of ["metric", "imperial"] as const) {
      for (let z = 0.02; z <= 8; z *= 1.07) {
        const step = tickStep(system, z);
        // The coarsest step is the fallback, so only check where a finer one cannot fit.
        if (z >= 0.05) expect(step * z).toBeGreaterThanOrEqual(MIN_TICK_PX);
      }
    }
  });

  it("emits metric ticks with absolute centimetre labels and ranks", () => {
    const t = ticks("metric", 1, -12 * UNITS_PER_MM, 23 * UNITS_PER_MM);
    const at = (mm: number) => t.find((x) => Math.abs(x.at - mm * UNITS_PER_MM) < 1e-6);
    expect(at(0)).toMatchObject({ rank: 2, label: "0" });
    expect(at(10)).toMatchObject({ rank: 2, label: "1" });
    expect(at(20)).toMatchObject({ rank: 2, label: "2" });
    expect(at(-10)).toMatchObject({ rank: 2, label: "1" });
    expect(at(5)).toMatchObject({ rank: 1 });
    expect(at(5)?.label).toBeUndefined();
    expect(at(-5)).toMatchObject({ rank: 1 });
    expect(at(3)).toMatchObject({ rank: 0 });
    expect(at(-12)).toBeDefined();
    expect(at(23)).toBeDefined();
    expect(t.every((x) => x.at >= -12 * UNITS_PER_MM - 1e-6 && x.at <= 23 * UNITS_PER_MM + 1e-6)).toBe(true);
  });

  it("labels whole inches and marks half inches", () => {
    const t = ticks("imperial", 1, -UNITS_PER_INCH, 2.5 * UNITS_PER_INCH);
    const at = (inches: number) => t.find((x) => Math.abs(x.at - inches * UNITS_PER_INCH) < 1e-6);
    expect(at(0)).toMatchObject({ rank: 2, label: "0" });
    expect(at(1)).toMatchObject({ rank: 2, label: "1" });
    expect(at(-1)).toMatchObject({ rank: 2, label: "1" });
    expect(at(2)).toMatchObject({ rank: 2, label: "2" });
    expect(at(0.5)).toMatchObject({ rank: 1 });
    expect(at(1.5)?.label).toBeUndefined();
    expect(at(1 / 16)).toMatchObject({ rank: 0 });
  });

  it("only emits multiples of a coarse step and bounds the tick count", () => {
    const t = ticks("metric", 0.1, 0, 10000);
    expect(t.length).toBeLessThan(400);
    const step = tickStep("metric", 0.1);
    for (const x of t) expect(Math.abs(x.at / step - Math.round(x.at / step))).toBeLessThan(1e-6);
    expect(ticks("imperial", 0.1, 0, 10000).length).toBeLessThan(400);
    expect(ticks("metric", 0.02, 0, 10000).length).toBeLessThan(400);
  });

  it("chooses the edge systems", () => {
    expect(edgeSystems("both")).toEqual(["metric", "imperial"]);
    expect(edgeSystems("metric")).toEqual(["metric", "metric"]);
    expect(edgeSystems("imperial")).toEqual(["imperial", "imperial"]);
    // A bad setting falls back to both, so the painter never meets an unknown system.
    expect(edgeSystems("cubits" as never)).toEqual(["metric", "imperial"]);
  });

  it("converts length snaps to page units", () => {
    expect(lengthSnapUnits("off")).toBe(0);
    expect(lengthSnapUnits("1mm")).toBeCloseTo(UNITS_PER_MM, 9);
    expect(lengthSnapUnits("5mm")).toBeCloseTo(5 * UNITS_PER_MM, 9);
    expect(lengthSnapUnits("1cm")).toBeCloseTo(10 * UNITS_PER_MM, 9);
    expect(lengthSnapUnits("1/8in")).toBe(UNITS_PER_INCH / 8);
    expect(lengthSnapUnits("1/4in")).toBe(UNITS_PER_INCH / 4);
  });

  it("formats lengths", () => {
    expect(formatLength(UNITS_PER_MM * 125, "both")).toBe("12.5 cm");
    expect(formatLength(UNITS_PER_MM * 125, "metric")).toBe("12.5 cm");
    expect(formatLength(UNITS_PER_MM * 30, "both")).toBe("3 cm");
    expect(formatLength(UNITS_PER_INCH * 4.92, "imperial")).toBe("4.92 in");
    expect(formatLength(UNITS_PER_INCH * 2, "imperial")).toBe("2.00 in");
  });
});
