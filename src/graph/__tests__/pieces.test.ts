import { describe, expect, it } from "vitest";
import { graphDataOf, validPieces, validStudy, type GraphExpression } from "../data";
import type { ParseResult } from "../expressions";
import { contains, cutsOf, evaluate, isPiecewise, normalizePieces, parsePieces, pieceEnds, piecesOf, runsOf, samplePieces, type PiecewiseFn } from "../pieces";

const fnOf = (pieces: PiecewiseFn["pieces"]): PiecewiseFn => ({ pieces, piecewise: true });
const graph = (expressions: unknown[]) => graphDataOf({ content: { subtype: "graph", graphData: { kind: "2d-function", expressions } } } as never);

describe("stored pieces and study", () => {
  it("reads_pieces_study_and_name_and_keeps_latex_equal_to_the_first_piece", () => {
    const [e] = graph([
      {
        id: "a",
        latex: "old",
        color: "#C62828",
        visible: true,
        name: " g ",
        pieces: [{ latex: "x^2", max: 0 }, { latex: "x", min: 0, minClosed: false, maxClosed: true }],
        study: { zeros: true, extrema: false, area: { from: 3, to: -1 } },
      },
    ]).expressions;
    expect(e.latex).toBe("x^2");
    expect(e.name).toBe("g");
    expect(e.pieces).toEqual([{ latex: "x^2", max: 0 }, { latex: "x", min: 0, minClosed: false, maxClosed: true }]);
    expect(e.study).toEqual({ zeros: true, area: { from: -1, to: 3 } });
  });

  it("drops_malformed_pieces_and_never_throws", () => {
    expect(validPieces([null, { latex: 3 }, { latex: "x", min: 2, max: 1 }, { latex: "x", min: "a", max: Infinity }])).toEqual([{ latex: "x" }]);
    expect(validPieces([])).toBeUndefined();
    expect(validPieces("x")).toBeUndefined();
    expect(validStudy({ zeros: "yes", area: { from: NaN, to: 1 } })).toBeUndefined();
    const [e] = graph([{ id: "a", latex: "x", color: "#C62828", visible: true, pieces: [5], study: 7 }]).expressions;
    expect(e).toEqual({ id: "a", latex: "x", color: "#C62828", visible: true });
  });

  it("an_expression_without_pieces_reads_as_before", () => {
    const [e] = graph([{ id: "a", latex: "x", color: "#C62828", visible: false }]).expressions;
    expect(e).toEqual({ id: "a", latex: "x", color: "#C62828", visible: false });
    expect(piecesOf(e)).toEqual([{ latex: "x" }]);
    expect(isPiecewise(e)).toBe(false);
  });

  it("normalize_folds_a_single_unbounded_piece_back_into_latex", () => {
    const base: GraphExpression = { id: "a", latex: "", color: "#000000", visible: true };
    expect(normalizePieces({ ...base, pieces: [{ latex: "x^3" }] })).toEqual({ ...base, latex: "x^3" });
    const two = normalizePieces({ ...base, pieces: [{ latex: "1", max: 0 }, { latex: "2" }] });
    expect(two.latex).toBe("1");
    expect(two.pieces).toHaveLength(2);
  });
});

describe("piecewise evaluation", () => {
  it("ends_default_to_closed_min_and_open_max", () => {
    expect(contains({ min: 0, max: 1 }, 0)).toBe(true);
    expect(contains({ min: 0, max: 1 }, 1)).toBe(false);
    expect(contains({ min: 0, max: 1, minClosed: false, maxClosed: true }, 0)).toBe(false);
    expect(contains({ min: 0, max: 1, minClosed: false, maxClosed: true }, 1)).toBe(true);
    expect(contains({}, -1e300)).toBe(true);
  });

  it("the_first_piece_holding_x_wins_and_elsewhere_is_undefined", () => {
    const fn = fnOf([
      { f: () => 1, min: 0, max: 2 },
      { f: () => 2, min: 1, max: 3 },
    ]);
    expect(evaluate(fn, 1.5)).toBe(1);
    expect(evaluate(fn, 2)).toBe(2);
    expect(evaluate(fn, 3)).toBeNaN();
    expect(evaluate(fn, -1)).toBeNaN();
  });

  it("parses_each_piece_and_requires_functions_of_x", () => {
    const parse = (s: string): ParseResult => (s === "polar" ? { kind: "polar", r: () => 1 } : s === "bad" ? { error: "bad" } : { kind: "of-x", f: (x) => x });
    const e = { latex: "x", pieces: [{ latex: "x", max: 0 }, { latex: "x", min: 0 }] };
    const ok = parsePieces(e, parse);
    expect("fn" in ok && ok.fn.pieces).toHaveLength(2);
    expect(parsePieces({ ...e, pieces: [{ latex: "x", max: 0 }, { latex: "polar" }] }, parse)).toHaveProperty("error");
    expect(parsePieces({ ...e, pieces: [{ latex: "bad", max: 0 }, { latex: "x" }] }, parse)).toEqual({ error: "bad" });
    expect(parsePieces({ latex: "polar" }, parse)).toHaveProperty("other");
    expect(parsePieces({ latex: "x" }, () => ({ pending: true }))).toEqual({ pending: true });
  });
});

describe("runs, ends and sampling", () => {
  // f(x) = x² for x < 1, 3 − x for 1 ≤ x ≤ 2 (closed), undefined after 2.
  const step = fnOf([
    { f: (x) => x * x, max: 1 },
    { f: (x) => 3 - x, min: 1, max: 2, maxClosed: true },
  ]);

  it("splits_the_window_at_bounds_and_leaves_out_stretches_without_a_piece", () => {
    expect(cutsOf(step, -5, 5)).toEqual([1, 2]);
    expect(runsOf(step, -5, 5)).toEqual([
      { a: -5, b: 1, piece: 0 },
      { a: 1, b: 2, piece: 1 },
    ]);
  });

  it("draws_a_hollow_dot_at_an_open_end_and_a_filled_one_at_a_closed_end", () => {
    const ends = pieceEnds(step, runsOf(step, -5, 5), -5, 5, 1e-9);
    expect(ends).toEqual([
      { x: 1, y: 1, filled: false },
      { x: 1, y: 2, filled: true },
      { x: 2, y: 1, filled: true },
    ]);
  });

  it("a_continuous_junction_gets_no_dots", () => {
    const abs = fnOf([
      { f: (x) => -x, max: 0 },
      { f: (x) => x, min: 0 },
    ]);
    expect(pieceEnds(abs, runsOf(abs, -5, 5), -5, 5, 1e-9)).toEqual([]);
  });

  it("a_point_held_by_another_piece_gets_its_own_dot", () => {
    const hole = fnOf([
      { f: () => 5, min: 0, max: 0, maxClosed: true },
      { f: (x) => x * x },
    ]);
    const runs = runsOf(hole, -1, 1);
    expect(runs).toEqual([
      { a: -1, b: 0, piece: 1 },
      { a: 0, b: 1, piece: 1 },
    ]);
    expect(pieceEnds(hole, runs, -1, 1, 1e-9)).toEqual([
      { x: 0, y: 0, filled: false },
      { x: 0, y: 5, filled: true },
    ]);
  });

  it("samples_each_run_exactly_to_its_ends_without_joining_pieces", () => {
    const branches = samplePieces(step, runsOf(step, -5, 5), -5, 5, { yRange: 10 });
    expect(branches).toHaveLength(2);
    expect(branches[0][0].x).toBe(-5);
    expect(branches[0][branches[0].length - 1]).toEqual({ x: 1, y: 1 });
    expect(branches[1][0]).toEqual({ x: 1, y: 2 });
    expect(branches[1][branches[1].length - 1]).toEqual({ x: 2, y: 1 });
  });

  it("a_plain_function_has_one_run_and_no_dots", () => {
    const plain: PiecewiseFn = { pieces: [{ f: (x) => x }], piecewise: false };
    const runs = runsOf(plain, -1, 1);
    expect(runs).toEqual([{ a: -1, b: 1, piece: 0 }]);
    expect(pieceEnds(plain, runs, -1, 1, 1e-9)).toEqual([]);
  });
});
