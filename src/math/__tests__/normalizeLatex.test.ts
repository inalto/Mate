import { describe, expect, it } from "vitest";
import { normalizeLatex } from "../normalizeLatex";

describe("normalizeLatex", () => {
  it("unwraps_an_upright_differential", () => {
    expect(normalizeLatex("\\int_0^{2\\cdot\\pi}\\sin(x)\\mathrm{dx}")).toBe("\\int_0^{2\\cdot\\pi}\\sin(x)dx");
    expect(normalizeLatex("\\int_0^1 t\\,\\text{dt}")).toBe("\\int_0^1 t\\,dt");
    expect(normalizeLatex("\\int f(u)\\operatorname{du}")).toBe("\\int f(u)du");
    expect(normalizeLatex("\\mathrm{ d x }")).toBe("dx");
  });

  it("unwraps_a_lone_upright_d", () => {
    expect(normalizeLatex("\\frac{\\mathrm{d}}{\\mathrm{d}x}x^2")).toBe("\\frac{d}{dx}x^2");
    expect(normalizeLatex("\\frac{\\mathrm{d}y}{\\mathrm{dx}}")).toBe("\\frac{dy}{dx}");
  });

  it("leaves_other_upright_text_and_plain_input_alone", () => {
    expect(normalizeLatex("\\mathrm{e}^{x}+\\mathrm{i}")).toBe("\\mathrm{e}^{x}+\\mathrm{i}");
    expect(normalizeLatex("\\text{dog}")).toBe("\\text{dog}");
    expect(normalizeLatex("\\mathrm{dxy}")).toBe("\\mathrm{dxy}");
    expect(normalizeLatex("sin(x) dx")).toBe("sin(x) dx");
    expect(normalizeLatex("")).toBe("");
  });
});
