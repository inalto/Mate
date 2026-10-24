// Expression corpus on the real Compute Engine: what a user types in the graph editor's plain text
// box (calculator style, or LaTeX), the kind it must be read as, and spot values of its evaluators.
// `log` is base 10 (the engine's `\log`); `ln` is the natural logarithm.
import { beforeAll, describe, expect, it } from "vitest";
import { loadEngine } from "../engine";
import { parseExpressionSync, type ParsedExpr } from "../expressions";

type Kind = ParsedExpr["kind"];

interface Case {
  input: string;
  kind: Kind;
  /** [argument(s)…, expected]: of-x/of-y/polar take one argument, implicit takes x and y. */
  at?: number[][];
}

const PI = Math.PI;

const CORPUS: Case[] = [
  // Calculator-style functions of x.
  { input: "sin(x)", kind: "of-x", at: [[PI / 2, 1], [0, 0]] },
  { input: "x^10", kind: "of-x", at: [[2, 1024]] },
  { input: "sqrt(x)", kind: "of-x", at: [[9, 3]] },
  { input: "abs(x)", kind: "of-x", at: [[-2, 2]] },
  { input: "ln(x)", kind: "of-x", at: [[Math.E, 1]] },
  { input: "log(x)", kind: "of-x", at: [[100, 2]] },
  { input: "log2(x)", kind: "of-x", at: [[8, 3]] },
  { input: "log_2(x)", kind: "of-x", at: [[8, 3]] },
  { input: "log10(x)", kind: "of-x", at: [[1000, 3]] },
  { input: "exp(-x^2)", kind: "of-x", at: [[0, 1], [1, Math.exp(-1)]] },
  { input: "floor(x)", kind: "of-x", at: [[2.7, 2], [-0.5, -1]] },
  { input: "ceil(x)", kind: "of-x", at: [[2.1, 3]] },
  { input: "pi*x", kind: "of-x", at: [[1, PI]] },
  { input: "2pi x", kind: "of-x", at: [[1, 2 * PI]] },
  { input: "e^x", kind: "of-x", at: [[1, Math.E]] },
  { input: "2^x", kind: "of-x", at: [[3, 8]] },
  { input: "x^(1/3)", kind: "of-x", at: [[8, 2]] },
  { input: "x^-2", kind: "of-x", at: [[2, 0.25]] },
  { input: "x^0.5", kind: "of-x", at: [[16, 4]] },
  { input: "e^(-x^2/2)", kind: "of-x", at: [[0, 1]] },
  { input: "1/x", kind: "of-x", at: [[4, 0.25]] },
  { input: "tan(x)", kind: "of-x", at: [[PI / 4, 1]] },
  { input: "x*sin(1/x)", kind: "of-x", at: [[1 / PI, 0], [2 / PI, 2 / PI]] },
  { input: "sinh(x)", kind: "of-x", at: [[1, Math.sinh(1)]] },
  { input: "cosh(x)", kind: "of-x", at: [[0, 1]] },
  { input: "tanh(x)", kind: "of-x", at: [[0, 0]] },
  { input: "asin(x)", kind: "of-x", at: [[1, PI / 2]] },
  { input: "arccos(x)", kind: "of-x", at: [[1, 0]] },
  { input: "atan(x)", kind: "of-x", at: [[1, PI / 4]] },
  { input: "sec(x)", kind: "of-x", at: [[0, 1]] },
  { input: "cot(x)", kind: "of-x", at: [[PI / 4, 1]] },
  { input: "|x-1|", kind: "of-x", at: [[-1, 2]] },
  { input: "abs(abs(x)-1)", kind: "of-x", at: [[-3, 2]] },
  { input: "3x^2-2x+1", kind: "of-x", at: [[2, 9]] },
  { input: "2sin(x)cos(x)", kind: "of-x", at: [[PI / 4, 1]] },
  { input: "sin(x)^2", kind: "of-x", at: [[PI / 2, 1]] },
  { input: "sin^2(x)", kind: "of-x", at: [[PI / 2, 1]] },
  { input: "sqrt(x^2+1)", kind: "of-x", at: [[0, 1]] },
  { input: "min(x, 1)", kind: "of-x", at: [[3, 1]] },
  { input: "max(x, 1)", kind: "of-x", at: [[3, 3]] },
  { input: "sign(x)", kind: "of-x", at: [[-4, -1]] },
  { input: "(x+1)(x-1)", kind: "of-x", at: [[3, 8]] },
  { input: "x**3", kind: "of-x", at: [[2, 8]] },
  { input: "y = x^2", kind: "of-x", at: [[3, 9]] },
  { input: "y = 2x + 1", kind: "of-x", at: [[1, 3]] },
  { input: "f(x) = x^2", kind: "of-x", at: [[3, 9]] },
  // x as a function of y.
  { input: "x = y^2", kind: "of-y", at: [[-2, 4]] },
  { input: "x = 3", kind: "of-y", at: [[5, 3]] },
  // Polar.
  { input: "r = 1+cos(theta)", kind: "polar", at: [[0, 2]] },
  { input: "r = sin(3θ)", kind: "polar", at: [[PI / 6, 1]] },
  { input: "r = theta", kind: "polar", at: [[2, 2]] },
  // Parametric.
  { input: "(cos(t), sin(t))", kind: "parametric" },
  { input: "x = t^2, y = t", kind: "parametric" },
  // Implicit curves in x and y.
  { input: "x^2+y^2=4", kind: "implicit", at: [[2, 0, 0], [0, 0, -4]] },
  { input: "x^2/9+y^2/4=1", kind: "implicit", at: [[3, 0, 0]] },
  { input: "y^2=x^3-x", kind: "implicit", at: [[1, 0, 0]] },
  { input: "xy=1", kind: "implicit", at: [[2, 0.5, 0]] },
  { input: "x*y = 1", kind: "implicit", at: [[4, 0.25, 0]] },
  { input: "sin(x)+cos(y)=0", kind: "implicit", at: [[0, PI / 2, 0]] },
  { input: "x^2 = y^2", kind: "implicit", at: [[1, -1, 0]] },
  // LaTeX is passed through unchanged.
  { input: "\\sin(x)", kind: "of-x", at: [[PI / 2, 1]] },
  { input: "\\frac{1}{x}", kind: "of-x", at: [[2, 0.5]] },
  { input: "y = \\sqrt{x}", kind: "of-x", at: [[4, 2]] },
  { input: "x^{10}", kind: "of-x", at: [[2, 1024]] },
];

const ERRORS = ["y = z", "sin(", "foo(x)", "x + a", "sqrt(", "x^2 + y^2 = z", "((x)", "y = x)"];

const evalAt = (p: ParsedExpr, args: number[]): number => {
  switch (p.kind) {
    case "of-x":
    case "of-y":
      return p.f(args[0]);
    case "polar":
      return p.r(args[0]);
    case "implicit":
      return p.f(args[0], args[1]);
    case "parametric":
      return NaN;
  }
};

describe("expression corpus", () => {
  beforeAll(async () => {
    await loadEngine();
  });

  it.each(CORPUS)("$input → $kind", ({ input, kind, at }) => {
    const p = parseExpressionSync(input);
    expect("pending" in p).toBe(false);
    if ("error" in p) throw new Error(`${input}: ${p.error}`);
    if ("pending" in p) return;
    expect(p.kind).toBe(kind);
    for (const spot of at ?? []) {
      const expected = spot[spot.length - 1];
      expect(evalAt(p, spot.slice(0, -1)), `${input} at ${spot.slice(0, -1).join(", ")}`).toBeCloseTo(expected, 9);
    }
  });

  it("parametric spot values", () => {
    const circle = parseExpressionSync("(cos(t), sin(t))");
    if (!("kind" in circle) || circle.kind !== "parametric") throw new Error("not parametric");
    expect(circle.x(0)).toBeCloseTo(1);
    expect(circle.y(PI / 2)).toBeCloseTo(1);
    const para = parseExpressionSync("x = t^2, y = t");
    if (!("kind" in para) || para.kind !== "parametric") throw new Error("not parametric");
    expect(para.x(3)).toBeCloseTo(9);
    expect(para.y(3)).toBeCloseTo(3);
  });

  it("errors_are_readable", () => {
    expect(parseExpressionSync("y = z")).toEqual({ error: "Unknown symbol: z" });
    expect(parseExpressionSync("x^2 + y^2 = z")).toEqual({ error: "Unknown symbol: z" });
    expect(parseExpressionSync("sin(")).toEqual({ error: "Unmatched bracket" });
    expect(parseExpressionSync("y = x)")).toEqual({ error: "Unmatched bracket" });
    expect(parseExpressionSync("x^2^3")).toEqual({ error: "Unexpected exponent" });
    expect(parseExpressionSync("r = r*theta")).toEqual({ error: "Implicit equations can only use x and y" });
  });

  it.each(ERRORS)("%s is an error", (input) => {
    const p = parseExpressionSync(input);
    expect("error" in p, input).toBe(true);
    if ("error" in p) expect(p.error.length).toBeGreaterThan(0);
  });
});
