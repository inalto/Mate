import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadEngine } from "../engine";
import { parseExpression, parseExpressionSync, tooExpensiveMessage, type ParsedExpr, type ParseResult } from "../expressions";

const parse = (latex: string): ParseResult => {
  const p = parseExpressionSync(latex);
  if ("pending" in p) throw new Error("engine not loaded");
  return p;
};
const ok = (latex: string): ParsedExpr => {
  const p = parse(latex);
  if ("error" in p) throw new Error(`unexpected error for ${latex}: ${p.error}`);
  return p;
};

describe("parseExpression", () => {
  beforeAll(async () => {
    await loadEngine();
  });

  it("classifies_y_of_x", () => {
    const a = ok("y = \\sin(x)");
    expect(a.kind).toBe("of-x");
    if (a.kind !== "of-x") return;
    expect(a.f(0)).toBeCloseTo(0);
    expect(a.f(Math.PI / 2)).toBeCloseTo(1);
    const b = ok("x^2 + 1");
    expect(b.kind).toBe("of-x");
    if (b.kind === "of-x") expect(b.f(3)).toBeCloseTo(10);
    const c = ok("x = y^2");
    expect(c.kind).toBe("of-y");
    if (c.kind === "of-y") expect(c.f(-2)).toBeCloseTo(4);
  });

  it("classifies_polar", () => {
    const p = ok("r = 2\\cos(\\theta)");
    expect(p.kind).toBe("polar");
    if (p.kind === "polar") expect(p.r(0)).toBeCloseTo(2);
  });

  it("classifies_parametric_tuple_and_pair", () => {
    for (const src of ["(\\cos(t), \\sin(t))", "x = \\cos(t), y = \\sin(t)"]) {
      const p = ok(src);
      expect(p.kind).toBe("parametric");
      if (p.kind !== "parametric") continue;
      expect(p.x(0)).toBeCloseTo(1);
      expect(p.y(Math.PI / 2)).toBeCloseTo(1);
    }
  });

  it("non_real_values_are_nan", () => {
    const p = ok("\\sqrt{x}");
    if (p.kind === "of-x") expect(p.f(-1)).toBeNaN();
  });

  it("reports_errors_without_throwing", () => {
    for (const bad of ["\\sqrt{", "y=", "", "   ", "x + a", "\\frac{"]) {
      const p = parse(bad);
      expect("error" in p).toBe(true);
      if ("error" in p) expect(typeof p.error).toBe("string");
    }
    // Junk input of any kind never throws.
    for (const junk of ["\\\\", "}{", "((", "=", "x=y=z", "\\begin{matrix}"]) expect(() => parseExpressionSync(junk)).not.toThrow();
  });

  it("rejects_unbounded_sum", () => {
    const warn = vi.spyOn(console, "warn");
    for (const src of [
      "\\sum_{n=1}^{10^{9}} x",
      "\\sum_{n=1}^{\\infty} \\frac{x}{n^2}",
      "\\prod_{k=1}^{5000} x",
      "\\sum_{n=1}^{x} n",
      "\\sum_{n=1}^{5}\\sum_{m=1}^{5} x",
      "\\int_0^{\\infty} e^{-t x}\\,dt",
    ]) {
      expect(parse(src)).toEqual({ error: tooExpensiveMessage() });
    }
    // Short finite sums and finite integrals still plot.
    const s10 = ok("\\sum_{n=1}^{10} n x");
    if (s10.kind === "of-x") expect(s10.f(1)).toBeCloseTo(55);
    expect(ok("\\int_0^x t\\,dt").kind).toBe("of-x");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reads_an_upright_differential_as_a_differential", () => {
    // Recognisers write `\mathrm{dx}`, which the engine alone takes for a symbol named "dx".
    const p = ok("\\int_0^{2\\cdot\\pi}\\sin(x)\\mathrm{dx}");
    expect(p.kind).toBe("of-x");
    if (p.kind === "of-x") expect(p.f(1)).toBeCloseTo(0);
    const q = ok("\\int_0^x\\sin(t)\\,\\mathrm{dt}");
    if (q.kind === "of-x") expect(q.f(Math.PI)).toBeCloseTo(2);
  });

  it("uncompilable_is_an_error_not_a_slow_fallback", async () => {
    const p = await parseExpression("\\sum_{n=1}^{N} x");
    expect("error" in p).toBe(true);
  });
});
