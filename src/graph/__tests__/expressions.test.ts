import { describe, expect, it } from "vitest";
import { parseExpression, type ParsedExpr } from "../expressions";

const ok = (latex: string): ParsedExpr => {
  const p = parseExpression(latex);
  if ("error" in p) throw new Error(`unexpected error for ${latex}: ${p.error}`);
  return p;
};

describe("parseExpression", () => {
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
      const p = parseExpression(bad);
      expect("error" in p).toBe(true);
      if ("error" in p) expect(typeof p.error).toBe("string");
    }
    // Junk input of any kind never throws.
    for (const junk of ["\\\\", "}{", "((", "=", "x=y=z", "\\begin{matrix}"]) expect(() => parseExpression(junk)).not.toThrow();
  });
});
