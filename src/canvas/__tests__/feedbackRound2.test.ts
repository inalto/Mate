// Tester feedback round 2: double tap fits the sheet, a held snapped shape follows the pen, and a
// block sent to another page lands on a row of its own.
import { describe, expect, it } from "vitest";
import { PAGE_GAP } from "../../model/constants";
import type { RecognizedShape } from "../../shapes/recognize";
import { doubleTapFit } from "../gestures";
import { ADJUST_ROTATE_DEAD, adjustSnapped } from "../inkSnap";
import { ROW_GAP, rowBelowDelta } from "../pageBounds";

const viewport = { width: 1000, height: 600 };
const stack = { width: 1080, height: 1528, count: 3 };
const fitZ = viewport.width / stack.width;

describe("double tap on a paper page", () => {
  it("zoomed_in_goes_back_to_the_sheet_spanning_the_view", () => {
    const cam = { x: -700, y: -900, z: 2.5 };
    const tap = { x: 400, y: 300 };
    const out = doubleTapFit(cam, tap, viewport, stack);
    expect(out.z).toBeCloseTo(fitZ);
    expect(out.x).toBe(0); // the sheet's left edge on the view's left edge: it spans the width
    // The height tapped stays under the finger.
    const worldY = (tap.y - cam.y) / cam.z;
    expect(worldY * out.z + out.y).toBeCloseTo(tap.y);
  });

  it("smaller_than_the_view_grows_to_span_it", () => {
    const out = doubleTapFit({ x: 230, y: 20, z: 0.5 }, { x: 500, y: 300 }, viewport, stack);
    expect(out.z).toBeCloseTo(fitZ);
    expect(out.x).toBe(0);
  });

  it("already_spanning_the_view_shows_the_whole_sheet_under_the_tap", () => {
    const stride = stack.height + PAGE_GAP;
    // The view is on the second sheet.
    const cam = { x: 0, y: -(stride + 200) * fitZ, z: fitZ };
    const out = doubleTapFit(cam, { x: 500, y: 300 }, viewport, stack);
    const hz = viewport.height / stack.height;
    expect(out.z).toBeCloseTo(hz);
    expect(out.y).toBeCloseTo(-stride * hz); // the second sheet's top at the view's top
    expect(out.x).toBeCloseTo((viewport.width - stack.width * hz) / 2); // centred
    // And from there a double tap spans the width again.
    expect(doubleTapFit(out, { x: 500, y: 300 }, viewport, stack).z).toBeCloseTo(fitZ);
  });
});

describe("a held snapped shape follows the pen", () => {
  const rect: RecognizedShape = { type: "rectangle", score: 1, rect: { x: 0, y: 0, width: 100, height: 60 }, rotation: 0 };
  const grab = { x: 100, y: 30 }; // on the right side, level with the centre (50, 30)

  it("small_pen_jitter_changes_nothing", () => {
    expect(adjustSnapped(rect, grab, { x: 103, y: 32 }, 1)).toBe(rect);
  });

  it("pulling_away_from_the_centre_grows_it_about_the_centre", () => {
    const out = adjustSnapped(rect, grab, { x: 150, y: 30 }, 1);
    expect(out.rect.width).toBeCloseTo(200);
    expect(out.rect.height).toBeCloseTo(120);
    expect(out.rect.x + out.rect.width / 2).toBeCloseTo(50);
    expect(out.rect.y + out.rect.height / 2).toBeCloseTo(30);
    expect(out.rotation).toBe(0);
  });

  it("going_round_the_centre_turns_it", () => {
    const out = adjustSnapped(rect, grab, { x: 50, y: 80 }, 1); // a quarter turn, same distance
    expect(out.rect.width).toBeCloseTo(100);
    expect(out.rotation).toBeCloseTo(Math.PI / 2 - ADJUST_ROTATE_DEAD);
  });

  it("a_curve_turns_and_grows_too", () => {
    const curve: RecognizedShape = {
      type: "line",
      score: 1,
      rect: { x: 0, y: 0, width: 100, height: 0 },
      rotation: 0,
      curve: [{ x: 0, y: 0 }, { x: 50, y: 40 }, { x: 100, y: 0 }],
    };
    const out = adjustSnapped(curve, { x: 100, y: 0 }, { x: 150, y: -20 }, 1);
    // Centre (50, 20); the grabbed end goes from 53.85 to 107.7 away, in the same direction.
    expect(out.curve![2].x).toBeCloseTo(150);
    expect(out.curve![2].y).toBeCloseTo(-20);
    expect(out.rect.x).toBeCloseTo(out.curve![0].x);
    expect(out.rect.x + out.rect.width).toBeCloseTo(150);
  });
});

describe("a block sent to another page", () => {
  it("lands_under_the_content_with_a_gap", () => {
    expect(rowBelowDelta({ x: 300, y: 50, width: 200, height: 100 }, 800)).toBe(800 + ROW_GAP - 50);
  });

  it("starts_at_the_top_of_an_empty_page", () => {
    expect(rowBelowDelta({ x: 300, y: 500, width: 200, height: 100 }, 0)).toBe(ROW_GAP - 500);
  });

  it("skips_to_the_next_sheet_when_it_would_run_over_the_foot", () => {
    const sheet = { height: 1000 };
    const stride = 1000 + PAGE_GAP;
    // 100 left on the first sheet, the block is 300 tall.
    expect(rowBelowDelta({ x: 0, y: 0, width: 10, height: 300 }, 900 - ROW_GAP, sheet)).toBe(stride + ROW_GAP);
    // It fits: it stays on the sheet.
    expect(rowBelowDelta({ x: 0, y: 0, width: 10, height: 50 }, 900 - ROW_GAP, sheet)).toBe(900);
    // Taller than a sheet: it just follows the content.
    expect(rowBelowDelta({ x: 0, y: 0, width: 10, height: 3000 }, 500, sheet)).toBe(500 + ROW_GAP);
  });
});
