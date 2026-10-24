// Uses the real Compute Engine (a plain dependency), no mocks.
import { describe, expect, it } from "vitest";
import { compute, latexToPlain, localCheck, localCheckMessage, looksLikeEquation } from "../cas";

const flat = (s: string) => s.replace(/\s+/g, "");
const latexOf = (r: { latex: string } | { error: string }): string => {
  if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
  return r.latex;
};

describe("compute", () => {
  it("evaluates_arithmetic", async () => {
    expect(latexOf(await compute("2+3", "evaluate"))).toBe("5");
    expect(latexOf(await compute("\\frac{1}{3}+\\frac{1}{6}", "evaluate"))).toBe("\\frac{1}{2}");
  });

  it("simplifies", async () => {
    expect(flat(latexOf(await compute("\\frac{x^2-1}{x-1}", "simplify")))).toBe("x+1");
  });

  it("expands", async () => {
    const r = latexOf(await compute("(x+1)^2", "expand"));
    expect(r).toContain("x^2");
    expect(flat(r)).toContain("2x");
  });

  it("solves_for_the_single_unknown", async () => {
    expect(flat(latexOf(await compute("2x+4=10", "solve")))).toBe("x=3");
    const two = flat(latexOf(await compute("x^2=4", "solve")));
    expect(two).toContain("x=2");
    expect(two).toContain("x=-2");
  });

  it("solves_for_x_when_there_are_several_unknowns", async () => {
    expect(flat(latexOf(await compute("x+y=3", "solve")))).toBe("x=3-y");
  });

  it("refuses_to_solve_without_an_unknown", async () => {
    expect(await compute("2+3=5", "solve")).toEqual({ error: "Nothing to solve for" });
    expect(await compute("a+b=3", "solve")).toHaveProperty("error");
  });

  it("reports_an_equation_without_solutions", async () => {
    expect(await compute("x+1=x", "solve")).toHaveProperty("error");
  });

  it("gives_a_numeric_value_with_six_significant_digits", async () => {
    expect(latexOf(await compute("\\pi", "numeric"))).toBe("3.14159");
    expect(latexOf(await compute("\\frac{1}{3}", "numeric"))).toBe("0.333333");
  });

  it("applies_the_operation_to_each_side_of_an_equation", async () => {
    expect(flat(latexOf(await compute("(x+1)^2=1+3", "expand")))).toBe("x^2+2x+1=4");
  });

  it("returns_errors_for_blank_or_unreadable_input", async () => {
    expect(await compute("   ", "evaluate")).toEqual({ error: "Nothing to compute" });
    expect(await compute("\\frac{1}{", "simplify")).toHaveProperty("error");
  });

  it("writes_imaginary_units_katex_can_render", async () => {
    const r = latexOf(await compute("x^2+1=0", "solve"));
    expect(r).not.toContain("imaginaryI");
    expect(r).toContain("\\mathrm{i}");
  });
});

describe("localCheck", () => {
  it("agrees_on_an_identity", async () => {
    expect(await localCheck("x^2-1=(x-1)(x+1)")).toEqual({ kind: "agree" });
  });

  it("finds_a_point_where_the_sides_differ", async () => {
    const r = await localCheck("2x=3x");
    expect(r.kind).toBe("differ");
    if (r.kind === "differ") {
      expect(Object.keys(r.at)).toEqual(["x"]);
      expect(r.at.x).not.toBe(0);
    }
  });

  it("is_not_applicable_to_an_expression", async () => {
    expect(await localCheck("x+1")).toEqual({ kind: "notApplicable" });
    expect(await localCheck("")).toEqual({ kind: "notApplicable" });
  });

  it("checks_every_adjacent_pair_of_a_chain", async () => {
    expect(await localCheck("(x+1)^2=x^2+2x+1=1+x(x+2)")).toEqual({ kind: "agree" });
    expect((await localCheck("(x+1)^2=x^2+2x+1=x^2+1")).kind).toBe("differ");
  });

  it("decides_constant_equations", async () => {
    expect(await localCheck("1+1=2")).toEqual({ kind: "agree" });
    expect(await localCheck("2+2=5")).toEqual({ kind: "differ", at: {} });
  });

  it("samples_several_variables", async () => {
    expect(await localCheck("(a+b)^2=a^2+2ab+b^2")).toEqual({ kind: "agree" });
    const r = await localCheck("(a+b)^2=a^2+b^2");
    expect(r.kind).toBe("differ");
    if (r.kind === "differ") expect(Object.keys(r.at).sort()).toEqual(["a", "b"]);
  });

  it("is_undecided_when_no_sample_has_a_real_value", async () => {
    const r = await localCheck("\\sqrt{-1-x^2}=\\sqrt{-2-x^2}");
    expect(r.kind).toBe("undecided");
  });

  it("is_undecided_for_unreadable_input", async () => {
    expect((await localCheck("x=\\frac{1}{")).kind).toBe("undecided");
  });
});

describe("looksLikeEquation", () => {
  it("spots_an_equals_sign", () => {
    expect(looksLikeEquation("2x+3=7")).toBe(true);
    expect(looksLikeEquation("x+1")).toBe(false);
    expect(looksLikeEquation("x \\neq 2")).toBe(false);
    expect(looksLikeEquation("x \\leq 2")).toBe(false);
  });
});

describe("latexToPlain", () => {
  it("gives_a_plain_ascii_form", async () => {
    expect(await latexToPlain("\\frac{x^2}{2}+\\sqrt{3}")).toBe("1/2 * x^2 + sqrt(3)");
    expect(await latexToPlain("2x+4=10")).toBe("2x + 4 = 10");
  });
});

describe("localCheckMessage", () => {
  it("words_each_outcome", () => {
    expect(localCheckMessage({ kind: "agree" })).toBe("Both sides agree");
    expect(localCheckMessage({ kind: "differ", at: { x: 1.5, y: -2 } })).toBe("They differ at x = 1.5, y = -2");
    expect(localCheckMessage({ kind: "differ", at: {} })).toBe("They differ");
    expect(localCheckMessage({ kind: "undecided", reason: "no real values" })).toBe("Could not decide: no real values");
    expect(localCheckMessage({ kind: "notApplicable" })).toBe("Could not decide: this is not an equation");
  });
});
