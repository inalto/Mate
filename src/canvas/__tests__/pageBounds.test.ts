import { describe, expect, it } from "vitest";
import type { SheetStack } from "../camera";
import { clampDeltaToStack, clampToRect, placeInStack, sheetRectAt } from "../pageBounds";

const stack: SheetStack = { width: 1080, height: 1528, count: 3 };

describe("pageBounds", () => {
  it("sheet_lookup_first_second_gap_side_negative", () => {
    expect(sheetRectAt(stack, { x: 10, y: 10 })).toEqual({ x: 0, y: 0, width: 1080, height: 1528 });
    expect(sheetRectAt(stack, { x: 0, y: 1552 })).toEqual({ x: 0, y: 1552, width: 1080, height: 1528 }); // edge inclusive
    expect(sheetRectAt(stack, { x: 1080, y: 1528 })).not.toBeNull();
    expect(sheetRectAt(stack, { x: 10, y: 1540 })).toBeNull(); // gap
    expect(sheetRectAt(stack, { x: -1, y: 10 })).toBeNull();
    expect(sheetRectAt(stack, { x: 1081, y: 10 })).toBeNull();
    expect(sheetRectAt(stack, { x: 10, y: -1 })).toBeNull();
    expect(sheetRectAt(stack, { x: 10, y: 3 * 1552 + 10 })).toBeNull(); // beyond count
  });

  it("clamp_to_rect", () => {
    expect(clampToRect({ x: -5, y: 2000 }, { x: 0, y: 0, width: 1080, height: 1528 })).toEqual({ x: 0, y: 1528 });
  });

  it("move_delta_is_reduced_at_the_edges", () => {
    expect(clampDeltaToStack({ x: 1000, y: 100, width: 100, height: 50 }, { x: 50, y: 0 }, stack)).toEqual({ x: -20, y: 0 });
    expect(clampDeltaToStack({ x: 10, y: 10, width: 100, height: 50 }, { x: -30, y: -30 }, stack)).toEqual({ x: -10, y: -10 });
    expect(clampDeltaToStack({ x: 10, y: 10, width: 100, height: 50 }, { x: 0, y: 5000 }, stack)).toEqual({ x: 0, y: 5000 }); // no lower limit
  });

  it("wider_than_the_sheet_is_left_aligned", () => {
    expect(placeInStack({ x: 300, y: 0, width: 2000, height: 10 }, stack)).toEqual({ x: -300, y: 0 });
  });
});
