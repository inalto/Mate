import { describe, expect, it } from "vitest";
import { inferGraphKind } from "../data";

describe("inferGraphKind", () => {
  it("infers_polar_kind", () => {
    expect(inferGraphKind(String.raw`r=2\cos\theta`)).toBe("2d-polar");
    expect(inferGraphKind(String.raw`\sin(2\theta)`)).toBe("2d-polar");
  });
  it("infers_parametric_kind", () => {
    expect(inferGraphKind(String.raw`x=\cos t, y=\sin t`)).toBe("2d-parametric");
    expect(inferGraphKind(String.raw`(\cos t, \sin t)`)).toBe("2d-parametric");
    expect(inferGraphKind(String.raw`\sin(t)`)).toBe("2d-parametric");
  });
  it("defaults_to_function", () => {
    expect(inferGraphKind("y=x^2")).toBe("2d-function");
    expect(inferGraphKind("x^2+1")).toBe("2d-function");
    expect(inferGraphKind(String.raw`\tan(2)`)).toBe("2d-function");
    expect(inferGraphKind(String.raw`y=\sin(\theta x)`)).toBe("2d-function");
  });
});
