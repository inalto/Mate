import { describe, expect, it } from "vitest";
import { formatNumber, formatPoint, formatSpans, parseBound } from "../format";

describe("study number format", () => {
  it("shows_exact_looking_values_cleanly", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(1e-15)).toBe("0");
    expect(formatNumber(1)).toBe("1");
    expect(formatNumber(-3)).toBe("−3");
    expect(formatNumber(0.5)).toBe("0.5");
    expect(formatNumber(1.75)).toBe("1.75");
    expect(formatNumber(2.0000000000001)).toBe("2");
  });

  it("recognises_simple_fractions_and_multiples_of_pi", () => {
    expect(formatNumber(1 / 3)).toBe("1/3");
    expect(formatNumber(-2 / 7)).toBe("−2/7");
    expect(formatNumber(Math.PI)).toBe("π");
    expect(formatNumber(Math.PI / 2)).toBe("π/2");
    expect(formatNumber((-3 * Math.PI) / 4)).toBe("−3π/4");
    expect(formatNumber(2 * Math.PI)).toBe("2π");
  });

  it("keeps_up_to_four_decimals_otherwise", () => {
    expect(formatNumber(Math.SQRT2)).toBe("1.4142");
    expect(formatNumber(-0.123456)).toBe("−0.1235");
    expect(formatNumber(1234567)).toBe("1.235e6");
    expect(formatNumber(Infinity)).toBe("+∞");
  });

  it("writes_intervals_and_points", () => {
    expect(formatSpans([])).toBeNull();
    expect(
      formatSpans([
        { from: -10, to: 0, fromClosed: true, toClosed: false },
        { from: 0, to: Infinity, fromClosed: false, toClosed: true },
      ]),
    ).toBe("[−10, 0) ∪ (0, +∞)");
    expect(formatPoint(0.5, -1)).toBe("(0.5, −1)");
  });

  it("reads_typed_bounds", () => {
    expect(parseBound("2")).toBe(2);
    expect(parseBound(" -1.5 ")).toBe(-1.5);
    expect(parseBound("pi/2")).toBeCloseTo(Math.PI / 2);
    expect(parseBound("-2pi")).toBeCloseTo(-2 * Math.PI);
    expect(parseBound("3*pi/4")).toBeCloseTo((3 * Math.PI) / 4);
    expect(parseBound("π")).toBeCloseTo(Math.PI);
    expect(parseBound("sqrt(2)")).toBeCloseTo(Math.SQRT2);
    expect(parseBound("1/3")).toBeCloseTo(1 / 3);
    expect(parseBound("")).toBeNull();
    expect(parseBound("x")).toBeNull();
    expect(parseBound("pi*")).toBeNull();
  });
});
