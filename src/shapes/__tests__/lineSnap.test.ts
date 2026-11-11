import { describe, expect, it } from "vitest";
import { snapLineEnd } from "../lineSnap";

describe("snapLineEnd", () => {
  const o = { x: 100, y: 100 };
  it("near_horizontal_and_vertical_lines_land_on_the_axis", () => {
    expect(snapLineEnd(o, { x: 300, y: 106 })).toEqual({ x: 300, y: 100 });
    expect(snapLineEnd(o, { x: -100, y: 95 })).toEqual({ x: -100, y: 100 });
    expect(snapLineEnd(o, { x: 104, y: 300 })).toEqual({ x: 100, y: 300 });
    expect(snapLineEnd(o, { x: 97, y: -200 })).toEqual({ x: 100, y: -200 });
  });
  it("other_angles_and_a_zero_length_line_are_left_alone", () => {
    expect(snapLineEnd(o, { x: 300, y: 140 })).toEqual({ x: 300, y: 140 });
    expect(snapLineEnd(o, { x: 200, y: 200 })).toEqual({ x: 200, y: 200 });
    expect(snapLineEnd(o, o)).toEqual(o);
  });
});
