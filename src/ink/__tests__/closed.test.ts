import { describe, expect, it } from "vitest";
import type { Element } from "../../model/types";
import { isClosedStroke, strokeFill } from "../closed";

const stroke = (pts: [number, number][], over: Partial<Element> = {}): Element => ({
  id: "s",
  pageId: "pg",
  type: "stroke",
  points: pts.map(([x, y], i) => ({ x, y, pressure: 0.5, timestamp: i })),
  color: "#000000",
  width: 2,
  isHighlighter: false,
  createdAt: "",
  updatedAt: "",
  version: 0,
  ...over,
});

describe("closed ink", () => {
  const loop: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100], [2, 4]];
  it("a_stroke_that_returns_to_its_start_is_closed", () => {
    expect(isClosedStroke(stroke(loop))).toBe(true);
    expect(isClosedStroke(stroke([[0, 0], [100, 0], [100, 100]]))).toBe(false);
    expect(isClosedStroke(stroke(loop, { isHighlighter: true }))).toBe(false);
    expect(isClosedStroke(stroke(loop, { type: "shape" }))).toBe(false);
  });
  it("only_a_closed_stroke_with_a_real_colour_has_a_fill", () => {
    expect(strokeFill(stroke(loop, { fillColor: "#FDE047" }))).toBe("#FDE047");
    expect(strokeFill(stroke(loop, { fillColor: "transparent" }))).toBeNull();
    expect(strokeFill(stroke(loop))).toBeNull();
    expect(strokeFill(stroke([[0, 0], [100, 0], [100, 100]], { fillColor: "#FDE047" }))).toBeNull();
  });
});
