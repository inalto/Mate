import { describe, expect, it } from "vitest";
import { integrate } from "../integral";
import type { PiecewiseFn } from "../pieces";
import { endBehaviour, studyFunction } from "../study";

const plain = (f: (x: number) => number): PiecewiseFn => ({ pieces: [{ f }], piecewise: false });
const win = { xMin: -10, xMax: 10 };
const study = (f: (x: number) => number, w = win) => studyFunction(plain(f), w, { budgetMs: 5000, yRange: 20 });
const spans = (list: { from: number; to: number; fromClosed: boolean; toClosed: boolean }[]) =>
  list.map((s) => `${s.fromClosed ? "[" : "("}${+s.from.toFixed(6)},${+s.to.toFixed(6)}${s.toClosed ? "]" : ")"}`).join(" ");

describe("function study", () => {
  it("a_parabola_has_its_zeros_sign_vertex_and_no_inflection", () => {
    const r = study((x) => x * x - 4);
    expect(spans(r.domain)).toBe("[-10,10]");
    expect(r.intercept).toBe(-4);
    expect(r.zeros).toEqual([-2, 2]);
    expect(spans(r.positive)).toBe("[-10,-2) (2,10]");
    expect(spans(r.negative)).toBe("(-2,2)");
    expect(r.minima).toEqual([{ x: 0, y: -4 }]);
    expect(r.maxima).toEqual([]);
    expect(spans(r.decreasing)).toBe("[-10,0]");
    expect(spans(r.increasing)).toBe("[0,10]");
    expect(spans(r.concaveUp)).toBe("[-10,10]");
    expect(r.concaveDown).toEqual([]);
    expect(r.inflections).toEqual([]);
    expect(r.atPlusInfinity).toEqual({ kind: "infinite", sign: 1 });
    expect(r.partial).toBe(false);
  });

  it("a_double_root_is_a_zero_and_splits_the_sign", () => {
    const r = study((x) => (x - 1) ** 2);
    expect(r.zeros).toEqual([1]);
    expect(spans(r.positive)).toBe("[-10,1) (1,10]");
    expect(r.minima).toEqual([{ x: 1, y: 0 }]);
  });

  it("a_cubic_has_extrema_and_an_inflection", () => {
    const r = study((x) => x ** 3 - 3 * x);
    expect(r.zeros.map((z) => +z.toFixed(6))).toEqual([-1.732051, 0, 1.732051]);
    expect(r.maxima).toEqual([{ x: -1, y: 2 }]);
    expect(r.minima).toEqual([{ x: 1, y: -2 }]);
    expect(r.inflections).toEqual([{ x: 0, y: 0 }]);
    expect(spans(r.concaveDown)).toBe("[-10,0]");
    expect(spans(r.concaveUp)).toBe("[0,10]");
  });

  it("a_straight_line_has_no_extrema_nor_concavity", () => {
    const r = study((x) => 2 * x + 1);
    expect(r.zeros).toEqual([-0.5]);
    expect(spans(r.increasing)).toBe("[-10,10]");
    expect(r.concaveUp).toEqual([]);
    expect(r.concaveDown).toEqual([]);
    expect(r.inflections).toEqual([]);
    expect(r.atPlusInfinity).toEqual({ kind: "oblique", m: 2, q: 1 });
  });

  it("one_over_x_has_a_vertical_and_a_horizontal_asymptote_and_no_zero", () => {
    const r = study((x) => 1 / x);
    expect(r.zeros).toEqual([]);
    expect(r.intercept).toBeNull();
    expect(r.vertical).toEqual([{ x: 0, left: -1, right: 1 }]);
    expect(spans(r.negative)).toBe("[-10,0)");
    expect(spans(r.positive)).toBe("(0,10]");
    expect(r.maxima).toEqual([]);
    expect(r.minima).toEqual([]);
    expect(r.atPlusInfinity).toEqual({ kind: "limit", value: 0 });
    expect(r.atMinusInfinity).toEqual({ kind: "limit", value: 0 });
    expect(spans(r.decreasing)).toBe("[-10,0) (0,10]");
  });

  it("a_pole_off_the_grid_without_sign_change_is_found", () => {
    const r = study((x) => 1 / (x - 0.3) ** 2);
    expect(r.vertical.map((a) => +a.x.toFixed(6))).toEqual([0.3]);
    expect(r.vertical[0]).toMatchObject({ left: 1, right: 1 });
    expect(r.maxima).toEqual([]);
  });

  it("tan_has_poles_not_roots_at_odd_multiples_of_half_pi", () => {
    const r = study(Math.tan, { xMin: -2, xMax: 2 });
    expect(r.zeros).toEqual([0]);
    expect(r.vertical.map((a) => a.x)).toEqual([-Math.PI / 2, Math.PI / 2]);
    expect(r.atPlusInfinity).toEqual({ kind: "none" });
  });

  it("the_domain_of_a_root_and_a_log_and_their_ends", () => {
    const sq = study(Math.sqrt);
    expect(spans(sq.domain)).toBe("[0,10]");
    expect(sq.zeros).toEqual([0]);
    expect(sq.vertical).toEqual([]);
    expect(sq.atMinusInfinity).toEqual({ kind: "undefined" });
    const ln = study(Math.log);
    expect(spans(ln.domain)).toBe("(0,10]");
    expect(ln.vertical).toEqual([{ x: 0, left: 0, right: -1 }]);
    expect(ln.zeros).toEqual([1]);
    expect(ln.atPlusInfinity).toEqual({ kind: "infinite", sign: 1 });
    const shifted = study((x) => Math.sqrt(3 * x - 1));
    expect(spans(shifted.domain)).toBe(`[${+(1 / 3).toFixed(6)},10]`);
  });

  it("a_rational_function_has_an_oblique_asymptote", () => {
    const r = study((x) => (x * x + 1) / (x - 1));
    expect(r.vertical.map((a) => a.x)).toEqual([1]);
    expect(r.atPlusInfinity.kind).toBe("oblique");
    if (r.atPlusInfinity.kind === "oblique") {
      expect(r.atPlusInfinity.m).toBe(1);
      expect(r.atPlusInfinity.q).toBeCloseTo(1, 6);
    }
    expect(r.atMinusInfinity.kind).toBe("oblique");
  });

  it("horizontal_limits_converge_to_their_value", () => {
    const at = endBehaviour(Math.atan, 1, 10);
    expect(at.kind).toBe("limit");
    if (at.kind === "limit") expect(at.value).toBeCloseTo(Math.PI / 2, 9);
    expect(endBehaviour((x) => (2 * x + 1) / (x - 3), -1, 10)).toMatchObject({ kind: "limit" });
    expect(endBehaviour(Math.exp, -1, 10)).toEqual({ kind: "limit", value: 0 });
    expect(endBehaviour(Math.exp, 1, 10)).toEqual({ kind: "infinite", sign: 1 });
    expect(endBehaviour(Math.sin, 1, 10)).toEqual({ kind: "none" });
  });

  it("abs_has_a_corner_minimum", () => {
    const r = study(Math.abs);
    expect(r.minima).toEqual([{ x: 0, y: 0 }]);
    expect(r.zeros).toEqual([0]);
  });

  it("a_piecewise_function_is_studied_per_piece", () => {
    // x + 2 on [−10, 0), x² on [0, 10]: a jump at 0, no extremum there from the formulas.
    const fn: PiecewiseFn = {
      pieces: [
        { f: (x) => x + 2, max: 0 },
        { f: (x) => x * x, min: 0, max: 10, maxClosed: true },
      ],
      piecewise: true,
    };
    const r = studyFunction(fn, win, { budgetMs: 5000, yRange: 20 });
    expect(spans(r.domain)).toBe("[-10,10]");
    expect(r.zeros).toEqual([-2, 0]);
    expect(r.intercept).toBe(0);
    expect(spans(r.positive)).toBe("(-2,0) (0,10]");
    expect(r.atPlusInfinity).toEqual({ kind: "undefined" });
  });

  it("returns_partial_results_when_out_of_time", () => {
    let t = 0;
    const r = studyFunction(plain((x) => x * x), win, { budgetMs: 10, now: () => (t += 1) });
    expect(r.partial).toBe(true);
  });
});

describe("definite integral", () => {
  it("integrates_and_measures_the_area", () => {
    const r = integrate(plain((x) => x), -1, 2);
    expect("value" in r && r.value).toBeCloseTo(1.5, 9);
    expect("area" in r && r.area).toBeCloseTo(2.5, 9);
    const back = integrate(plain((x) => x), 2, -1);
    expect("value" in back && back.value).toBeCloseTo(-1.5, 9);
    const sin = integrate(plain(Math.sin), 0, 2 * Math.PI);
    expect("value" in sin && Math.abs(sin.value)).toBeLessThan(1e-9);
    expect("area" in sin && sin.area).toBeCloseTo(4, 8);
  });

  it("refuses_a_pole_or_a_gap_in_the_domain", () => {
    expect(integrate(plain((x) => 1 / x), -1, 1)).toEqual({ error: "pole" });
    expect(integrate(plain((x) => 1 / (x - 0.3) ** 2), -1, 1)).toEqual({ error: "pole" });
    expect(integrate(plain(Math.sqrt), -1, 1)).toEqual({ error: "domain" });
    const restricted: PiecewiseFn = { pieces: [{ f: () => 1, min: 0, max: 1 }], piecewise: true };
    expect(integrate(restricted, 0, 2)).toEqual({ error: "domain" });
  });

  it("integrates_piece_by_piece", () => {
    const step: PiecewiseFn = {
      pieces: [
        { f: () => 1, max: 0 },
        { f: () => 3, min: 0 },
      ],
      piecewise: true,
    };
    const r = integrate(step, -1, 1);
    expect("value" in r && r.value).toBeCloseTo(4, 12);
  });
});

describe("function study on compiled expressions", () => {
  it("finishes_typical_functions_within_the_default_budget", async () => {
    const { loadEngine } = await import("../engine");
    const { parsePieces } = await import("../pieces");
    await loadEngine();
    for (const src of ["x^3-3x", "\\sin(x)", "\\frac{x^2+1}{x-1}", "\\ln(x)", "e^{-x^2}"]) {
      const p = parsePieces({ latex: src });
      if (!("fn" in p)) throw new Error(src);
      const t0 = performance.now();
      const r = studyFunction(p.fn, win, { yRange: 20 });
      expect(r.partial, `${src} took ${performance.now() - t0} ms`).toBe(false);
    }
    const sin = parsePieces({ latex: "\\sin(x)" });
    if (!("fn" in sin)) throw new Error("sin");
    const r = studyFunction(sin.fn, win, { yRange: 20 });
    expect(r.zeros).toEqual([-3, -2, -1, 0, 1, 2, 3].map((k) => k * Math.PI));
    expect(r.maxima.map((p) => p.x)).toEqual([-1.5, 0.5, 2.5].map((k) => k * Math.PI));
    expect(r.inflections.map((p) => p.x)).toEqual([-3, -2, -1, 0, 1, 2, 3].map((k) => k * Math.PI));
  });
});
