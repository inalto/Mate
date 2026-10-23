import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { createDismissPress, createTutorGestures, HOLD_ASK_MS, hitHandle, pointerTool, scaleFromDrag, TAP_MS, type TutorGestureDeps } from "../toolInteractions";

const b = { x: 0, y: 0, width: 100, height: 50 };
const info = { pointerType: "pen", buttons: 1, isBarrel: false, isEraserEnd: false };

describe("toolInteractions", () => {
  it("corner_drag_scales_about_opposite_corner", () => {
    expect(scaleFromDrag(b, "se", { x: 200, y: 75 }, false)).toEqual({ origin: { x: 0, y: 0 }, sx: 2, sy: 1.5 });
    expect(scaleFromDrag(b, "nw", { x: 50, y: 25 }, false)).toEqual({ origin: { x: 100, y: 50 }, sx: 0.5, sy: 0.5 });
    expect(scaleFromDrag(b, "se", { x: 200, y: 75 }, true)).toMatchObject({ sx: 2, sy: 2 });
  });

  it("handle_hit_is_zoom_compensated", () => {
    expect(hitHandle(b, { x: 104, y: 54 }, 1)).toBe("se");
    expect(hitHandle(b, { x: 104, y: 54 }, 4)).toBeNull();
    expect(hitHandle(b, { x: 50, y: 25 }, 1)).toBeNull();
  });

  it("pen_buttons_map_to_temporary_tools", () => {
    const cfg = { ...DEFAULT_SETTINGS, penBarrelButtonAction: "lasso", penEraserButtonAction: "eraser" };
    expect(pointerTool("pen", false, info, cfg)).toEqual({ tool: "pen", temp: null });
    expect(pointerTool("pen", false, { ...info, isBarrel: true }, cfg)).toEqual({ tool: "lasso", temp: "lasso" });
    expect(pointerTool("pen", false, { ...info, isEraserEnd: true }, cfg)).toEqual({ tool: "eraser", temp: "eraser" });
    expect(pointerTool("pen", true, info, cfg).tool).toBe("pan");
    expect(pointerTool("lasso", false, { ...info, pointerType: "mouse", buttons: 4 }, cfg).tool).toBe("pan");
  });
});

function gestures(over: Partial<TutorGestureDeps> = {}) {
  let t = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let n = 0;
  const deps: TutorGestureDeps = {
    active: () => true,
    markerAt: vi.fn(() => null),
    inkAt: vi.fn(() => true),
    inkUnder: vi.fn(() => "e"),
    sameGroup: vi.fn((a: string, b: string) => a === b),
    openCard: vi.fn(),
    openAsk: vi.fn(),
    getSettings: () => DEFAULT_SETTINGS,
    now: () => t,
    setTimer: (fn, ms) => {
      timers.push({ at: t + ms, fn, id: ++n });
      return n;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    ...over,
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.fn();
    }
    t = end;
  };
  const g = createTutorGestures(deps);
  /** A quick pen tap at screen `s` (world = screen here). */
  const tap = (s: { x: number; y: number }) => {
    g.inkDown(s, s, vi.fn());
    advance(60);
    return g.inkUp();
  };
  return { g, deps, advance, tap };
}

const at = { x: 10, y: 10 };

describe("tutor gestures", () => {
  it("gestures_inactive_without_consent", () => {
    const { g, deps, advance, tap } = gestures({ active: () => false, markerAt: vi.fn(() => "m"), inkAt: vi.fn(() => false) });
    expect(tap(at)).toBe("commit"); // even a tap on a marker's blank area stays ink
    advance(100);
    expect(tap(at)).toBe("commit");
    const abort = vi.fn();
    g.inkDown(at, at, abort);
    advance(HOLD_ASK_MS * 3);
    expect(g.inkUp()).toBe("commit");
    expect(abort).not.toHaveBeenCalled();
    expect(g.selectDown(at, at)).toBe(false);
    expect(deps.openCard).not.toHaveBeenCalled();
    expect(deps.openAsk).not.toHaveBeenCalled();
    expect(deps.inkUnder).not.toHaveBeenCalled();
  });

  it("pen_tap_on_a_marker_blank_area_opens_the_card", () => {
    const { deps, tap, g } = gestures({ markerAt: vi.fn(() => "m"), inkAt: vi.fn(() => false), inkUnder: vi.fn(() => null) });
    expect(tap(at)).toBe("discard");
    expect(deps.openCard).toHaveBeenCalledWith("m");
    // The pen uses the marker's own area only (no slop).
    expect(deps.markerAt).toHaveBeenCalledWith(at, 0);
    // A stroke that starts on the marker and moves is just ink.
    vi.mocked(deps.openCard).mockClear();
    g.inkDown(at, at, vi.fn());
    g.inkMove({ x: 40, y: 10 });
    expect(g.inkUp()).toBe("commit");
    expect(deps.openCard).not.toHaveBeenCalled();
  });

  it("pen_dot_on_marker_area_over_ink_is_kept", () => {
    const { deps, tap } = gestures({ markerAt: vi.fn(() => "m"), inkAt: vi.fn(() => true), inkUnder: vi.fn(() => null) });
    expect(tap(at)).toBe("commit");
    expect(deps.openCard).not.toHaveBeenCalled();
  });

  it("select_drag_from_squiggle_band_does_not_open_card", () => {
    const { g, deps } = gestures({ markerAt: vi.fn(() => "m") });
    expect(g.selectDown(at, at)).toBe(true);
    expect(deps.openCard).not.toHaveBeenCalled(); // decided on up
    expect(g.selectMove({ x: 12, y: 11 })).toBe(false);
    expect(g.selectMove({ x: 60, y: 10 })).toBe(true); // becomes a normal drag
    g.selectUp();
    expect(deps.openCard).not.toHaveBeenCalled();
    // A press that never moves opens the card on up.
    g.selectDown(at, at);
    g.selectUp();
    expect(deps.openCard).toHaveBeenCalledWith("m");
    expect(gestures().g.selectDown(at, at)).toBe(false);
  });

  it("tap_then_stroke_keeps_both_unit", () => {
    const { g, deps, advance, tap } = gestures();
    expect(tap(at)).toBe("commit");
    advance(100);
    g.inkDown(at, at, vi.fn());
    g.inkMove({ x: 30, y: 12 });
    advance(50);
    expect(g.inkUp()).toBe("commit");
    expect(deps.openAsk).not.toHaveBeenCalled();
  });

  it("hold_still_opens_ask_but_a_moving_hold_is_a_stroke", () => {
    const { g, deps, advance } = gestures();
    const abort = vi.fn();
    g.inkDown(at, at, abort);
    g.inkMove({ x: 12, y: 12 }); // jitter within the slop
    advance(HOLD_ASK_MS - 1);
    expect(abort).not.toHaveBeenCalled();
    advance(1);
    // The contact (no ink yet) is cancelled; existing strokes are untouched.
    expect(abort).toHaveBeenCalledTimes(1);
    expect(deps.openAsk).toHaveBeenCalledWith("e", []);
    expect(g.inkUp()).toBe("commit"); // nothing pending; caller has no stroke left

    const m = gestures();
    const abort2 = vi.fn();
    m.g.inkDown(at, at, abort2);
    m.advance(300);
    m.g.inkMove({ x: 30, y: 10 });
    m.advance(HOLD_ASK_MS * 2);
    expect(abort2).not.toHaveBeenCalled();
    expect(m.deps.openAsk).not.toHaveBeenCalled();
    expect(m.g.inkUp()).toBe("commit");

    // Off, or not on ink: no hold.
    const off = gestures({ getSettings: () => ({ ...DEFAULT_SETTINGS, tutorHoldToAsk: false }) });
    const abort3 = vi.fn();
    off.g.inkDown(at, at, abort3);
    off.advance(HOLD_ASK_MS * 2);
    const blank = gestures({ inkUnder: vi.fn(() => null) });
    blank.g.inkDown(at, at, abort3);
    blank.advance(HOLD_ASK_MS * 2);
    expect(abort3).not.toHaveBeenCalled();
  });

  it("select_tap_on_ink_inside_marker_area_selects_the_ink", () => {
    // The marker's slop area covers the ink, its own tight area does not.
    const markerAt = vi.fn((_p: { x: number; y: number }, slop?: number) => (slop === 0 ? null : "m"));
    const overInk = gestures({ markerAt, inkAt: vi.fn(() => true) });
    expect(overInk.g.selectDown(at, at)).toBe(false); // ink wins: the select tool selects it
    expect(markerAt).toHaveBeenCalledWith(at, 0);
    const blank = gestures({ markerAt, inkAt: vi.fn(() => false) });
    expect(blank.g.selectDown(at, at)).toBe(true);
  });
});

describe("closing the tutor card with the pen", () => {
  it("dismissing_card_keeps_the_stroke", () => {
    let t = 0;
    const d = createDismissPress(() => t);
    // A real stroke that starts by closing the card: it is committed like any other.
    d.down({ x: 10, y: 10 });
    expect(d.active()).toBe(true);
    t = 40;
    d.move({ x: 60, y: 12 });
    t = 120;
    expect(d.up()).toBe("commit");
    expect(d.active()).toBe(false);
    // A still press held longer than a tap is ink too (a dot the user meant to make).
    d.down({ x: 10, y: 10 });
    t += TAP_MS + 1;
    expect(d.up()).toBe("commit");
    // Only a bare quick tap, the press that just closed the card, is dropped.
    d.down({ x: 10, y: 10 });
    d.move({ x: 13, y: 12 });
    t += 80;
    expect(d.up()).toBe("discard");
    // Ordinary strokes (no dismissing press) are never affected.
    expect(d.up()).toBe("commit");
    d.down({ x: 0, y: 0 });
    d.cancel();
    expect(d.up()).toBe("commit");
  });
});
