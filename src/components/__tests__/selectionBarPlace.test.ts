import { describe, expect, it } from "vitest";
import { BAR_EDGE, BAR_GAP, placeSelectionBar } from "../selectionBarPlace";
import { barClearance, handleSpots, type SelectionHandles } from "../../canvas/toolInteractions";

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

  it("keeps_the_requested_clearance_above_and_below", () => {
    const sel = { x: 400, y: 300, width: 200, height: 100 };
    // The handles reach 40 px out: the bar stays 4 px past them.
    expect(placeSelectionBar(sel, view, bar, { above: 40, below: 0 }).top).toBe(300 - 44 - 44);
    // No room above: below the selection, past the clearance there.
    expect(placeSelectionBar({ ...sel, y: 60 }, view, bar, { above: 40, below: 30 }).top).toBe(160 + 34);
    // A reach shorter than the usual gap keeps the usual gap.
    expect(placeSelectionBar(sel, view, bar, { above: 5, below: 0 }).top).toBe(300 - BAR_GAP - 44);
  });

  describe("never_covers_the_rotate_knob_or_the_move_handle", () => {
    /** The circle (x, y, r) and the bar rectangle overlap. */
    const hits = (c: { x: number; y: number; r: number }, r: { x: number; y: number; width: number; height: number }) => {
      const nx = Math.max(r.x, Math.min(c.x, r.x + r.width));
      const ny = Math.max(r.y, Math.min(c.y, r.y + r.height));
      return Math.hypot(c.x - nx, c.y - ny) < c.r;
    };
    const kinds: [string, SelectionHandles][] = [
      ["rotate and move below", { overlay: false, padPx: 0, rotate: true, scale: true, move: "below" }],
      ["padded lone shape", { overlay: false, padPx: 12, rotate: true, scale: true, move: "below" }],
      ["tiny selection, move beside", { overlay: false, padPx: 0, rotate: true, scale: true, move: "right" }],
      ["overlay box", { overlay: true, padPx: 0, rotate: true, scale: true, move: "below" }],
      ["overlay small box", { overlay: true, padPx: 0, rotate: true, scale: true, move: "right" }],
    ];
    const sels = [
      { x: 400, y: 350, width: 200, height: 100 }, // middle
      { x: 400, y: 30, width: 200, height: 100 }, // near the top
      { x: 400, y: 640, width: 200, height: 100 }, // near the bottom
      { x: 480, y: 400, width: 6, height: 2 }, // tiny, middle
      { x: 480, y: 20, width: 6, height: 2 }, // tiny, near the top
      { x: 480, y: 760, width: 6, height: 2 }, // tiny, near the bottom
    ];
    for (const [name, h] of kinds)
      it(name, () => {
        for (const sel of sels) {
          const place = placeSelectionBar(sel, view, bar, barClearance(sel, h));
          const rect = { x: place.left - bar.width / 2, y: place.top, width: bar.width, height: bar.height };
          for (const spot of handleSpots(sel, h)) expect(hits(spot, rect), `${name} at y=${sel.y}`).toBe(false);
          expect(rect.y).toBeGreaterThanOrEqual(BAR_EDGE);
          expect(rect.y + rect.height).toBeLessThanOrEqual(view.height);
        }
      });
  });
});
