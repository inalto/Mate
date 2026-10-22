import { describe, expect, it } from "vitest";
import { inferGraphKind } from "../data";

describe("inferGraphKind", () => {
  it("infers_polar_kind", () => {
    expect(inferGraphKind("r=2\cos\theta")).toBe("2d-polar");
    expect(inferGraphKind("\sin(2\theta)")).toBe("2d-polar");
  });
  it("infers_parametric_kind", () => {
    expect(inferGraphKind("x=\cos t, y=\sin t")).toBe("2d-parametric");
    expect(inferGraphKind("(\cos t, \sin t)")).toBe("2d-parametric");
  });
  it("defaults_to_function", () => {
    expect(inferGraphKind("y=x^2")).toBe("2d-function");
    expect(inferGraphKind("x^2+1")).toBe("2d-function");
  });
});
