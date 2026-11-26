import { beforeAll, describe, expect, it } from "vitest";
import { derivativeLatex } from "../derivative";
import { loadEngine } from "../engine";

describe("symbolic derivative", () => {
  beforeAll(async () => {
    await loadEngine();
  });

  it("differentiates_the_body_of_each_form", () => {
    expect(derivativeLatex("x^3", 1)).toBe("3x^2");
    expect(derivativeLatex("y = x^3", 1)).toBe("3x^2");
    expect(derivativeLatex("f(x) = x^3", 2)).toBe("6x");
    expect(derivativeLatex("1/x", 1)).toBe("\\frac{-1}{x^2}");
  });

  it("writes_katex_safe_latex", () => {
    expect(derivativeLatex("e^x", 1)).toBe("\\mathrm{e}^{x}");
  });

  it("gives_null_for_what_it_cannot_differentiate", () => {
    expect(derivativeLatex("x^2 + z", 1)).toBeNull();
    expect(derivativeLatex("r = \\theta", 1)).toBeNull();
    expect(derivativeLatex("\\sqrt{", 1)).toBeNull();
  });
});
