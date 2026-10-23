import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { createTutorGestures, DOUBLE_TAP_MS, HOLD_ASK_MS, hitHandle, pointerTool, scaleFromDrag, type TutorGestureDeps } from "../toolInteractions";

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
    markerAt: vi.fn(() => null),
    groupAt: vi.fn(() => "g"),
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
  return { g: createTutorGestures(deps), deps, advance };
}

const at = { x: 10, y: 10 };

describe("tutor gestures", () => {
  it("marker_tap_opens_the_card_without_a_stroke", () => {
    const { g, deps, advance } = gestures({ markerAt: vi.fn(() => "m") });
    // Select tools: on pointer-down.
    expect(g.markerDown(at)).toBe(true);
    expect(deps.openCard).toHaveBeenCalledWith("m");
    // Pen: a quick tap on the marker opens the card and drops the dot.
    vi.mocked(deps.openCard).mockClear();
    expect(g.inkDown(at, at, vi.fn())).toBe(false);
    advance(100);
    expect(g.inkUp(vi.fn())).toBe("discard");
    expect(deps.openCard).toHaveBeenCalledWith("m");
    // A stroke that starts on the marker and moves is just ink.
    vi.mocked(deps.openCard).mockClear();
    g.inkDown(at, at, vi.fn());
    g.inkMove({ x: 40, y: 10 });
    expect(g.inkUp(vi.fn())).toBe("commit");
    expect(deps.openCard).not.toHaveBeenCalled();
    // No marker under the pointer: select tools carry on.
    expect(gestures().g.markerDown(at)).toBe(false);
  });

  it("double_tap_on_ink_opens_ask", () => {
    const { g, deps, advance } = gestures();
    const first = vi.fn();
    g.inkDown(at, at, vi.fn());
    advance(80);
    expect(g.inkUp(first)).toBe("defer");
    advance(150);
    expect(g.inkDown(at, { x: 12, y: 11 }, vi.fn())).toBe(true);
    expect(deps.openAsk).toHaveBeenCalledWith("g");
    // The first tap's dot is never drawn.
    advance(DOUBLE_TAP_MS * 2);
    expect(first).not.toHaveBeenCalled();
  });

  it("single_tap_on_ink_is_drawn_after_the_double_tap_window", () => {
    const { g, deps, advance } = gestures();
    const commit = vi.fn();
    g.inkDown(at, at, vi.fn());
    advance(50);
    expect(g.inkUp(commit)).toBe("defer");
    advance(DOUBLE_TAP_MS);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(deps.openAsk).not.toHaveBeenCalled();
    // Off: taps are committed at once.
    const off = gestures({ getSettings: () => ({ ...DEFAULT_SETTINGS, tutorDoubleTapAsk: false }) });
    off.g.inkDown(at, at, vi.fn());
    expect(off.g.inkUp(vi.fn())).toBe("commit");
    // A new stroke elsewhere commits the waiting tap first.
    const h = gestures();
    const dot = vi.fn();
    h.g.inkDown(at, at, vi.fn());
    h.g.inkUp(dot);
    vi.mocked(h.deps.groupAt).mockReturnValue(null);
    expect(h.g.inkDown({ x: 500, y: 500 }, { x: 500, y: 500 }, vi.fn())).toBe(false);
    expect(dot).toHaveBeenCalledTimes(1);
  });

  it("hold_still_opens_ask_but_a_moving_hold_is_a_stroke", () => {
    const { g, deps, advance } = gestures();
    const abort = vi.fn();
    g.inkDown(at, at, abort);
    advance(HOLD_ASK_MS - 1);
    expect(abort).not.toHaveBeenCalled();
    advance(1);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(deps.openAsk).toHaveBeenCalledWith("g");

    const m = gestures();
    const abort2 = vi.fn();
    m.g.inkDown(at, at, abort2);
    m.advance(300);
    m.g.inkMove({ x: 30, y: 10 });
    m.advance(HOLD_ASK_MS * 2);
    expect(abort2).not.toHaveBeenCalled();
    expect(m.deps.openAsk).not.toHaveBeenCalled();
    expect(m.g.inkUp(vi.fn())).toBe("commit");

    // Off, or not on ink: no hold.
    const off = gestures({ getSettings: () => ({ ...DEFAULT_SETTINGS, tutorHoldToAsk: false }) });
    const abort3 = vi.fn();
    off.g.inkDown(at, at, abort3);
    off.advance(HOLD_ASK_MS * 2);
    expect(abort3).not.toHaveBeenCalled();
    const blank = gestures({ groupAt: vi.fn(() => null) });
    blank.g.inkDown(at, at, abort3);
    blank.advance(HOLD_ASK_MS * 2);
    expect(abort3).not.toHaveBeenCalled();
  });
});
