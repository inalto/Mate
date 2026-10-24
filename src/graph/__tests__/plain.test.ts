import { describe, expect, it } from "vitest";
import { toLatex } from "../plain";

describe("toLatex", () => {
  it.each([
    ["sin(x)", "\\sin(x)"],
    ["y = sin(x)", "y = \\sin(x)"],
    ["sinx", "\\sin x"],
    ["2sin(x)cos(x)", "2\\sin(x)\\cos(x)"],
    ["sinh(x)", "\\sinh(x)"],
    ["asin(x) + arccos(x)", "\\arcsin(x) + \\arccos(x)"],
    ["sin^2(x)", "\\sin^2(x)"],
    ["x^10", "x^{10}"],
    ["x^2", "x^2"],
    ["x^-2", "x^{-2}"],
    ["x^0.5", "x^{0.5}"],
    ["x^(1/3)", "x^{1/3}"],
    ["e^(-x^2/2)", "e^{-x^2/2}"],
    ["e^pi", "e^{\\pi}"],
    ["e^sin(x)", "e^{\\sin(x)}"],
    ["x**3", "x^3"],
    ["sqrt(x^2+1)", "\\sqrt{x^2+1}"],
    ["sqrt x", "\\sqrt{x}"],
    ["√x", "\\sqrt{x}"],
    ["abs(x-1)", "\\left|x-1\\right|"],
    ["floor(x)", "\\left\\lfloor x\\right\\rfloor"],
    ["ceil(x)", "\\left\\lceil x\\right\\rceil"],
    ["ln(x)", "\\ln(x)"],
    ["log(x)", "\\log(x)"],
    ["log2(x)", "\\log_{2}(x)"],
    ["log_2(x)", "\\log_{2}(x)"],
    ["log10(x)", "\\log_{10}(x)"],
    ["exp(-x)", "\\exp(-x)"],
    ["sign(x)", "\\operatorname{sign}(x)"],
    ["min(x, 1)", "\\min(x, 1)"],
    ["pi*x", "\\pi*x"],
    ["2pix", "2\\pi x"],
    ["r = sin(3θ)", "r = \\sin(3\\theta)"],
    ["r = 1+cos(theta)", "r = 1+\\cos(\\theta)"],
    ["x = inf", "x = \\infty"],
    ["2 − x", "2 - x"],
    ["xy=1", "xy=1"],
    ["foo(x)", "foo(x)"],
    ["|x-1|", "|x-1|"],
    ["(cos(t), sin(t))", "(\\cos(t), \\sin(t))"],
  ])("%s → %s", (input, latex) => {
    expect(toLatex(input)).toBe(latex);
  });

  it("passes_latex_through", () => {
    for (const s of ["\\sin(x)", "\\frac{1}{x}", "x^{10}", "y = \\sqrt{x}"]) expect(toLatex(s)).toBe(s);
  });

  it("returns_unbalanced_input_unchanged", () => {
    for (const s of ["sin(", "((x)", "y = x)", "sqrt(x"]) expect(toLatex(s)).toBe(s);
  });

  it("never_throws", () => {
    for (const s of ["", "^", "x^", "sqrt", "log_", "abs()", "()", "**", "…", "sin^", "e^-"]) expect(() => toLatex(s)).not.toThrow();
  });
});
