import { describe, expect, it } from "vitest";
import { BAR_EDGE, BAR_GAP, placeSelectionBar } from "../selectionBarPlace";

const view = { width: 1000, height: 800 };
const bar = { width: 600, height: 44 };

describe("placeSelectionBar", () => {
  it("sits_centred_above_the_selection", () => {
    expect(placeSelectionBar({ x: 400, y: 300, width: 200, height: 100 }, view, bar)).toEqual({ left: 500, top: 300 - BAR_GAP - 44 });
  });

  it("a_wide_bar_stays_whole_inside_the_pane_at_either_side", () => {
    const l = placeSelectionBar({ x: 0, y: 300, width: 40, height: 40 }, view, bar);
    expect(l.left - bar.width / 2).toBeGreaterThanOrEqual(BAR_EDGE);
    const r = placeSelectionBar({ x: 960, y: 300, width: 40, height: 40 }, view, bar);
    expect(r.left + bar.width / 2).toBeLessThanOrEqual(view.width - BAR_EDGE);
    // Wider than the pane: centred (CSS wraps it).
    expect(placeSelectionBar({ x: 0, y: 300, width: 40, height: 40 }, { width: 400, height: 800 }, bar).left).toBe(200);
  });

  it("goes_below_when_there_is_no_room_above_and_never_leaves_the_pane", () => {
    expect(placeSelectionBar({ x: 400, y: 10, width: 200, height: 100 }, view, bar).top).toBe(110 + BAR_GAP);
    // Selection scrolled out above, below, or taller than the pane.
    for (const y of [-900, 2000]) {
      const { top } = placeSelectionBar({ x: 400, y, width: 200, height: 100 }, view, bar);
      expect(top).toBeGreaterThanOrEqual(BAR_EDGE);
      expect(top + bar.height).toBeLessThanOrEqual(view.height);
    }
    const tall = placeSelectionBar({ x: 400, y: -50, width: 200, height: 2000 }, view, { width: 600, height: 92 });
    expect(tall.top + 92).toBeLessThanOrEqual(view.height);
  });
});
