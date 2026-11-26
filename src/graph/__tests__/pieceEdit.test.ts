import { describe, expect, it } from "vitest";
import type { GraphExpression } from "../data";
import { addPiece, freshName, functionName, orderBounds, removePiece, restrictDomain, setPieceBounds, setPieceLatex } from "../pieceEdit";

const e: GraphExpression = { id: "a", latex: "x^2", color: "#C62828", visible: true };

describe("piece edits", () => {
  it("adding_a_piece_splits_at_zero_then_continues_from_the_last_bound", () => {
    const two = addPiece(e);
    expect(two.pieces).toEqual([{ latex: "x^2", max: 0 }, { latex: "", min: 0 }]);
    expect(two.latex).toBe("x^2");
    const closed = setPieceBounds(two, 1, { max: 3, maxClosed: true });
    expect(addPiece(closed).pieces?.[2]).toEqual({ latex: "", min: 3, minClosed: false });
  });

  it("latex_follows_the_first_piece", () => {
    const two = setPieceLatex(addPiece(e), 0, "x^3");
    expect(two.latex).toBe("x^3");
    expect(setPieceLatex(e, 0, "x").latex).toBe("x");
  });

  it("bounds_can_be_set_and_removed", () => {
    const r = restrictDomain(e);
    expect(r.pieces).toEqual([{ latex: "x^2" }]);
    const b = setPieceBounds(r, 0, { min: -1, minClosed: false });
    expect(b.pieces).toEqual([{ latex: "x^2", min: -1, minClosed: false }]);
    expect(setPieceBounds(b, 0, { min: undefined, minClosed: undefined }).pieces).toEqual([{ latex: "x^2" }]);
  });

  it("removing_down_to_one_unbounded_piece_folds_it_back", () => {
    const two = setPieceLatex(addPiece(e), 1, "x");
    expect(removePiece(two, 0).pieces).toEqual([{ latex: "x", min: 0 }]);
    const unbounded = setPieceBounds(two, 0, { max: undefined });
    const folded = removePiece(unbounded, 1);
    expect(folded.pieces).toBeUndefined();
    expect(folded.latex).toBe("x^2");
  });

  it("bounds_typed_in_the_wrong_order_are_swapped", () => {
    const p = orderBounds({ ...e, pieces: [{ latex: "x", min: 3, max: 1 }] });
    expect(p.pieces).toEqual([{ latex: "x", min: 1, max: 3, minClosed: false, maxClosed: true }]);
  });

  it("names_functions_f_g_h", () => {
    expect([0, 1, 2].map((i) => functionName({}, i))).toEqual(["f", "g", "h"]);
    expect(functionName({}, 8)).toBe("f₂");
    expect(functionName({ name: "k" }, 0)).toBe("k");
    expect(freshName([e, { ...e, name: "g" }])).toBe("h");
  });
});
