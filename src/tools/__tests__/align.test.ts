import { describe, expect, it } from "vitest";
import { alignElements, distributeElements } from "../align";
import { elementBounds } from "../spatialIndex";
import { el } from "./fixtures";
import type { Element } from "../../model/types";

const box = (id: string, x: number, y: number, w: number, h: number): Element =>
  el(id, [[x, y]], { type: "text-box", boxWidth: w, boxHeight: h });
const b = (e: Element) => elementBounds(e);

describe("align", () => {
  const els = [box("a", 10, 0, 20, 40), box("b", 100, 50, 60, 10), box("c", 50, 200, 10, 30)];

  it("align_left_sets_min_x", () => {
    expect(alignElements(els, "left").map((e) => b(e).x)).toEqual([10, 10, 10]);
  });
  it("aligns_right_center_top_middle_bottom", () => {
    expect(alignElements(els, "right").map((e) => b(e).x + b(e).width)).toEqual([160, 160, 160]);
    expect(alignElements(els, "center").map((e) => b(e).x + b(e).width / 2)).toEqual([85, 85, 85]);
    expect(alignElements(els, "top").map((e) => b(e).y)).toEqual([0, 0, 0]);
    expect(alignElements(els, "bottom").map((e) => b(e).y + b(e).height)).toEqual([230, 230, 230]);
    expect(alignElements(els, "middle").map((e) => b(e).y + b(e).height / 2)).toEqual([115, 115, 115]);
  });
  it("distributes_with_equal_gaps", () => {
    const out = distributeElements([box("a", 0, 0, 10, 10), box("b", 20, 0, 30, 10), box("c", 100, 0, 10, 10)], "horizontal");
    const gaps = [b(out[1]).x - (b(out[0]).x + b(out[0]).width), b(out[2]).x - (b(out[1]).x + b(out[1]).width)];
    expect(gaps[0]).toBeCloseTo(gaps[1]);
    expect(b(out[0]).x).toBe(0);
    expect(b(out[2]).x).toBe(100);
  });
  it("distributes_vertically_and_keeps_input_order", () => {
    const input = [box("c", 0, 300, 10, 10), box("a", 0, 0, 10, 50), box("b", 0, 60, 10, 10)];
    const out = distributeElements(input, "vertical");
    expect(out.map((e) => e.id)).toEqual(["c", "a", "b"]);
    expect(b(out[2]).y).toBeCloseTo(170, 5);
  });
});
