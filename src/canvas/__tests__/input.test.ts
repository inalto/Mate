import { afterEach, describe, expect, it, vi } from "vitest";
import { createPointerAdapter, fingerMayDraw, type FingerAction } from "../input";

const camera = () => ({ x: 0, y: 0, z: 1 });

function setup(opts: { palmRejection?: "off" | "low" | "high"; fingerAction?: FingerAction } = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const handlers = { onDown: vi.fn(), onMove: vi.fn(), onUp: vi.fn(), onCancel: vi.fn() };
  const dispose = createPointerAdapter(el, handlers, {
    palmRejection: opts.palmRejection ?? "high",
    fingerAction: opts.fingerAction ?? "pan",
    getCamera: camera,
  });
  return { el, handlers, dispose };
}

const fire = (el: HTMLElement, type: string, init: PointerEventInit) =>
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("pointer adapter", () => {
  it("mouse_down_move_up_calls_handlers", () => {
    const { el, handlers, dispose } = setup();
    const base = { pointerId: 1, pointerType: "mouse" };
    fire(el, "pointerdown", { ...base, clientX: 10, clientY: 20, button: 0, buttons: 1, pressure: 0.5 });
    fire(el, "pointermove", { ...base, clientX: 15, clientY: 25, buttons: 1, pressure: 0.5 });
    fire(el, "pointerup", { ...base, clientX: 20, clientY: 30, button: 0, buttons: 0 });
    expect(handlers.onDown).toHaveBeenCalledTimes(1);
    const [p, info] = handlers.onDown.mock.calls[0];
    expect(p).toMatchObject({ x: 10, y: 20 });
    expect(info).toMatchObject({ pointerType: "mouse", buttons: 1, isBarrel: false, isEraserEnd: false });
    expect(handlers.onMove).toHaveBeenCalledTimes(1);
    expect(handlers.onMove.mock.calls[0][0][0]).toMatchObject({ x: 15, y: 25 });
    expect(handlers.onUp).toHaveBeenCalledTimes(1);
    expect(handlers.onUp.mock.calls[0][0]).toMatchObject({ x: 20, y: 30 });
    expect(handlers.onCancel).not.toHaveBeenCalled();
    dispose();
  });

  it("fingertip_draws_under_high_without_a_stylus", () => {
    const { el, handlers } = setup({ palmRejection: "high", fingerAction: "auto" });
    fire(el, "pointerdown", { pointerId: 2, pointerType: "touch", width: 30, height: 30, buttons: 1, clientX: 5, clientY: 5 });
    fire(el, "pointermove", { pointerId: 2, pointerType: "touch", width: 30, height: 30, buttons: 1, clientX: 9, clientY: 9 });
    fire(el, "pointerup", { pointerId: 2, pointerType: "touch", width: 30, height: 30, clientX: 9, clientY: 9 });
    expect(handlers.onDown).toHaveBeenCalledTimes(1);
    expect(handlers.onDown.mock.calls[0][1]).toMatchObject({ pointerType: "touch" });
    expect(handlers.onMove).toHaveBeenCalledTimes(1);
    expect(handlers.onUp).toHaveBeenCalledTimes(1);
  });

  it("touch_with_large_radius_rejected_when_high_after_a_stylus", () => {
    const at = (el: HTMLElement, type: string, init: PointerEventInit, t: number) => {
      const ev = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(ev, "timeStamp", { value: t });
      el.dispatchEvent(ev);
    };
    const pen = { pointerId: 1, pointerType: "pen", pressure: 0.5 };
    const finger = { pointerId: 2, pointerType: "touch", width: 30, height: 30, buttons: 1, clientX: 5, clientY: 5 };
    const { el, handlers } = setup({ palmRejection: "high", fingerAction: "draw" });
    at(el, "pointermove", { ...pen, buttons: 0 }, 0); // stylus hover
    at(el, "pointerdown", finger, 500);
    expect(handlers.onDown).not.toHaveBeenCalled();
    // The same contact passes with low sensitivity (40 px threshold).
    const low = setup({ palmRejection: "low", fingerAction: "draw" });
    at(low.el, "pointermove", { ...pen, buttons: 0 }, 0);
    at(low.el, "pointerdown", { ...finger, pointerId: 3 }, 500);
    expect(low.handlers.onDown).toHaveBeenCalledTimes(1);
  });

  it("auto_finger_down_calls_onDown", () => {
    const { el, handlers } = setup({ palmRejection: "high", fingerAction: "auto" });
    fire(el, "pointerdown", { pointerId: 5, pointerType: "touch", width: 8, height: 8, buttons: 1, clientX: 5, clientY: 5 });
    expect(handlers.onDown).toHaveBeenCalledTimes(1);
  });

  it("resting_hand_during_a_pen_stroke_is_rejected", () => {
    for (const fingerAction of ["auto", "draw"] as const) {
      const { el, handlers } = setup({ palmRejection: "high", fingerAction });
      fire(el, "pointerdown", { pointerId: 1, pointerType: "pen", buttons: 1, pressure: 0.5, clientX: 0, clientY: 0 });
      fire(el, "pointerdown", { pointerId: 2, pointerType: "touch", width: 60, height: 60, buttons: 1, clientX: 50, clientY: 50 });
      fire(el, "pointermove", { pointerId: 2, pointerType: "touch", width: 60, height: 60, buttons: 1, clientX: 60, clientY: 60 });
      expect(handlers.onDown).toHaveBeenCalledTimes(1);
      expect(handlers.onCancel).not.toHaveBeenCalled();
      expect(handlers.onMove).not.toHaveBeenCalled();
      // A small fingertip during the pen stroke is rejected too.
      fire(el, "pointerdown", { pointerId: 3, pointerType: "touch", width: 8, height: 8, buttons: 1, clientX: 50, clientY: 50 });
      expect(handlers.onDown).toHaveBeenCalledTimes(1);
      expect(handlers.onCancel).not.toHaveBeenCalled();
    }
  });

  it("pan_finger_never_draws", () => {
    const { el, handlers } = setup({ palmRejection: "off", fingerAction: "pan" });
    fire(el, "pointerdown", { pointerId: 5, pointerType: "touch", width: 8, height: 8, buttons: 1, clientX: 5, clientY: 5 });
    expect(handlers.onDown).not.toHaveBeenCalled();
  });

  it("barrel_button_flag_set", () => {
    const { el, handlers } = setup();
    fire(el, "pointerdown", { pointerId: 4, pointerType: "pen", buttons: 1 | 2, pressure: 0.4, clientX: 1, clientY: 1 });
    expect(handlers.onDown).toHaveBeenCalledTimes(1);
    expect(handlers.onDown.mock.calls[0][1]).toMatchObject({ pointerType: "pen", isBarrel: true, isEraserEnd: false });
  });

  const mouse = { pointerId: 1, pointerType: "mouse" };
  const down = (el: HTMLElement, x = 0) =>
    fire(el, "pointerdown", { ...mouse, clientX: x, clientY: 0, button: 0, buttons: 1, pressure: 0.5 });
  const move = (el: HTMLElement, x: number, buttons = 1) =>
    fire(el, "pointermove", { ...mouse, clientX: x, clientY: 0, buttons, pressure: buttons ? 0.5 : 0 });

  it("pointercancel_cancels_stroke", () => {
    const { el, handlers } = setup();
    down(el);
    move(el, 5);
    fire(el, "pointercancel", { ...mouse });
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onUp).not.toHaveBeenCalled();
    move(el, 9);
    expect(handlers.onMove).toHaveBeenCalledTimes(1);
  });

  it("lostpointercapture_cancels_stroke", () => {
    const { el, handlers } = setup();
    down(el);
    fire(el, "lostpointercapture", { ...mouse });
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    down(el, 10);
    expect(handlers.onDown).toHaveBeenCalledTimes(2);
    // After a normal up the trailing lostpointercapture is a no-op.
    fire(el, "pointerup", { ...mouse, clientX: 12, button: 0, buttons: 0 });
    fire(el, "lostpointercapture", { ...mouse });
    expect(handlers.onUp).toHaveBeenCalledTimes(1);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it("hover_move_with_no_buttons_ends_stroke", () => {
    const { el, handlers } = setup();
    down(el);
    move(el, 5);
    move(el, 30, 0); // pointerup was lost; the next move reports no buttons
    expect(handlers.onUp).toHaveBeenCalledTimes(1);
    expect(handlers.onUp.mock.calls[0][0]).toMatchObject({ x: 30 });
    expect(handlers.onMove).toHaveBeenCalledTimes(1);
    move(el, 40, 0);
    expect(handlers.onMove).toHaveBeenCalledTimes(1);
    expect(handlers.onUp).toHaveBeenCalledTimes(1);
  });

  it("new_pointerdown_after_stuck_stroke_starts_fresh", () => {
    const { el, handlers } = setup();
    down(el, 0);
    move(el, 5);
    down(el, 100); // the up for the first stroke never arrived
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onDown).toHaveBeenCalledTimes(2);
    expect(handlers.onDown.mock.calls[1][0]).toMatchObject({ x: 100 });
    fire(el, "pointerup", { ...mouse, clientX: 110, button: 0, buttons: 0 });
    expect(handlers.onUp).toHaveBeenCalledTimes(1);
  });

  it("touch_rejected_within_2s_after_pen_up", () => {
    const { el, handlers } = setup({ palmRejection: "high", fingerAction: "auto" });
    const at = (type: string, init: PointerEventInit, t: number) => {
      const ev = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(ev, "timeStamp", { value: t });
      el.dispatchEvent(ev);
    };
    const pen = { pointerId: 7, pointerType: "pen", pressure: 0.5 };
    const finger = { pointerType: "touch", width: 8, height: 8, buttons: 1 };
    at("pointerdown", { ...pen, buttons: 1 }, 0);
    // Touch during the pen stroke is rejected outright.
    at("pointerdown", { ...finger, pointerId: 8 }, 2500);
    at("pointerup", { ...finger, pointerId: 8 }, 2550);
    at("pointerup", { ...pen, buttons: 0 }, 3000);
    // 4.5 s after pen-down but only 1.5 s after pen-up: still suppressed.
    at("pointerdown", { ...finger, pointerId: 9 }, 4500);
    at("pointerup", { ...finger, pointerId: 9 }, 4550);
    expect(handlers.onDown).toHaveBeenCalledTimes(1);
    // More than 2 s after pen-up: the finger draws.
    at("pointerdown", { ...finger, pointerId: 10 }, 5100);
    expect(handlers.onDown).toHaveBeenCalledTimes(2);
    expect(handlers.onDown.mock.calls[1][1]).toMatchObject({ pointerType: "touch" });
  });

  it("dispose_cancels_open_stroke", () => {
    const { el, handlers, dispose } = setup();
    down(el);
    dispose();
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it("self_released_capture_does_not_end_gesture", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const h = {
      onDown: vi.fn(),
      onMove: vi.fn(),
      onUp: vi.fn(),
      onCancel: vi.fn(),
      onPan: vi.fn(),
      onPanEnd: vi.fn(),
      onPinch: vi.fn(),
    };
    // Real capture semantics (jsdom has none): track captured ids.
    const captured = new Set<number>();
    Object.assign(el, {
      setPointerCapture: (id: number) => captured.add(id),
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => captured.delete(id),
    });
    createPointerAdapter(el, h, { palmRejection: "high", fingerAction: "draw", getCamera: camera });
    const finger = { pointerType: "touch", width: 8, height: 8, buttons: 1 };
    fire(el, "pointerdown", { ...finger, pointerId: 11, clientX: 10, clientY: 10 });
    expect(h.onDown).toHaveBeenCalledTimes(1);
    fire(el, "pointerdown", { ...finger, pointerId: 12, clientX: 60, clientY: 10 });
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    expect(h.onPinch).toHaveBeenCalledWith(expect.objectContaining({ phase: "start" }));
    // The browser later reports the capture we released for the first finger.
    fire(el, "lostpointercapture", { pointerId: 11, pointerType: "touch" });
    expect(h.onPinch).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "end" }));
    expect(h.onPanEnd).not.toHaveBeenCalled();
    fire(el, "pointermove", { ...finger, pointerId: 12, clientX: 110, clientY: 10 });
    expect(h.onPinch).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "move", dist: 100 }));

    // Mouse id re-used after a stale stroke: the old capture's loss must not cancel the new stroke.
    const mouse = { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, pressure: 0.5 };
    fire(el, "pointerup", { ...finger, pointerId: 11, buttons: 0 });
    fire(el, "pointerup", { ...finger, pointerId: 12, buttons: 0 });
    fire(el, "pointerdown", { ...mouse, clientX: 0, clientY: 0 });
    fire(el, "pointerdown", { ...mouse, clientX: 50, clientY: 0 }); // up was lost: cancel + restart
    expect(h.onCancel).toHaveBeenCalledTimes(2);
    fire(el, "lostpointercapture", { pointerId: 1, pointerType: "mouse" });
    expect(h.onCancel).toHaveBeenCalledTimes(2);
    fire(el, "pointerup", { ...mouse, clientX: 60, buttons: 0 });
    expect(h.onUp).toHaveBeenCalledTimes(1);
  });
});

describe("fingerMayDraw", () => {
  const tip = { width: 30, height: 30 };
  const now = 10_000;
  it("fingertip_draws_under_high_with_no_stylus", () => {
    expect(fingerMayDraw(tip, "high", "auto", -Infinity, now)).toBe(true);
  });
  it("auto_finger_pans_after_a_recent_stylus", () => {
    expect(fingerMayDraw(tip, "high", "auto", now - 500, now)).toBe(false);
  });
  it("definite_palm_never_draws", () => {
    expect(fingerMayDraw({ width: 100, height: 100 }, "high", "auto", -Infinity, now)).toBe(false);
    expect(fingerMayDraw({ width: 100, height: 100 }, "high", "draw", -Infinity, now)).toBe(false);
  });
  it("pan_never_draws", () => {
    expect(fingerMayDraw(tip, "high", "pan", -Infinity, now)).toBe(false);
    expect(fingerMayDraw(tip, "off", "pan", -Infinity, now)).toBe(false);
  });
  it("draw_applies_size_thresholds_only_after_a_recent_stylus", () => {
    expect(fingerMayDraw(tip, "high", "draw", -Infinity, now)).toBe(true);
    expect(fingerMayDraw(tip, "high", "draw", now - 500, now)).toBe(false);
    expect(fingerMayDraw(tip, "standard", "draw", now - 500, now)).toBe(true);
    expect(fingerMayDraw({ width: 8, height: 8 }, "high", "draw", now - 500, now)).toBe(true);
  });

  it("one_finger_pan_reports_start_fingers_and_time", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const h = { onDown: vi.fn(), onMove: vi.fn(), onUp: vi.fn(), onCancel: vi.fn(), onPanStart: vi.fn(), onPan: vi.fn(), onPanEnd: vi.fn() };
    createPointerAdapter(el, h, { palmRejection: "high", fingerAction: "pan", getCamera: camera });
    const at = (type: string, init: PointerEventInit, t: number) => {
      const ev = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(ev, "timeStamp", { value: t });
      el.dispatchEvent(ev);
    };
    const finger = { pointerId: 7, pointerType: "touch", width: 8, height: 8, buttons: 1 };
    at("pointerdown", { ...finger, clientX: 200, clientY: 50 }, 10);
    expect(h.onPanStart).toHaveBeenCalledWith({ x: 200, y: 50 }, 10);
    at("pointermove", { ...finger, clientX: 150, clientY: 52 }, 40);
    expect(h.onPan).toHaveBeenLastCalledWith(-50, 2, { fingers: 1, timeStamp: 40 });
    at("pointerdown", { ...finger, pointerId: 8, clientX: 300, clientY: 50 }, 50);
    expect(h.onPanStart).toHaveBeenCalledTimes(1); // a second finger does not restart the pan
    at("pointerup", { ...finger, buttons: 0, clientX: 150, clientY: 52 }, 60);
    at("pointerup", { ...finger, pointerId: 8, buttons: 0, clientX: 300, clientY: 50 }, 60);
    expect(h.onPanEnd).toHaveBeenCalledTimes(1);
    expect(h.onPanEnd).toHaveBeenCalledWith({ cancelled: false, timeStamp: 60, drewMeanwhile: false });
    // Pen input never reports a pan.
    at("pointerdown", { pointerId: 9, pointerType: "pen", buttons: 1, pressure: 0.5, clientX: 0, clientY: 0 }, 70);
    at("pointermove", { pointerId: 9, pointerType: "pen", buttons: 1, pressure: 0.5, clientX: 90, clientY: 0 }, 80);
    expect(h.onPanStart).toHaveBeenCalledTimes(1);
    expect(h.onDown).toHaveBeenCalledTimes(1);
  });

  const gesture = () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const h = { onDown: vi.fn(), onMove: vi.fn(), onUp: vi.fn(), onCancel: vi.fn(), onPanStart: vi.fn(), onPan: vi.fn(), onPanEnd: vi.fn() };
    createPointerAdapter(el, h, { palmRejection: "high", fingerAction: "pan", getCamera: camera });
    const at = (type: string, init: PointerEventInit, t: number) => {
      const ev = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(ev, "timeStamp", { value: t });
      el.dispatchEvent(ev);
    };
    return { h, at };
  };
  const touch = { pointerId: 7, pointerType: "touch", width: 8, height: 8, buttons: 1 };
  const pen = { pointerId: 9, pointerType: "pen", buttons: 1, pressure: 0.5 };

  it("pan_while_the_pen_writes_is_not_swipe_eligible", () => {
    const { h, at } = gesture();
    at("pointerdown", { ...touch, clientX: 400, clientY: 50 }, 10);
    at("pointerdown", { ...pen, clientX: 100, clientY: 100 }, 20); // the hand rests, the pen writes
    at("pointermove", { ...touch, clientX: 200, clientY: 52 }, 60); // the palm flings
    at("pointerup", { ...pen, buttons: 0, clientX: 120, clientY: 100 }, 70);
    at("pointerup", { ...touch, buttons: 0, clientX: 200, clientY: 52 }, 80);
    expect(h.onPanEnd).toHaveBeenCalledWith({ cancelled: false, timeStamp: 80, drewMeanwhile: true });
    // The next gesture starts clean.
    at("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: 0, clientY: 0 }, 5000);
    at("pointerup", { pointerId: 1, pointerType: "mouse", button: 0, buttons: 0, clientX: 0, clientY: 0 }, 5010);
    at("pointerdown", { ...touch, clientX: 400, clientY: 50 }, 5020);
    at("pointerup", { ...touch, buttons: 0, clientX: 200, clientY: 50 }, 5100);
    expect(h.onPanEnd).toHaveBeenLastCalledWith({ cancelled: false, timeStamp: 5100, drewMeanwhile: false });
  });

  it("pen_still_down_when_the_pan_ends_is_not_swipe_eligible", () => {
    const { h, at } = gesture();
    at("pointerdown", { ...touch, clientX: 400, clientY: 50 }, 10);
    at("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: 0, clientY: 0 }, 20);
    at("pointerup", { ...touch, buttons: 0, clientX: 200, clientY: 50 }, 80);
    expect(h.onPanEnd).toHaveBeenCalledWith(expect.objectContaining({ drewMeanwhile: true }));
  });

  it("cancelled_pan_reports_cancelled", () => {
    const { h, at } = gesture();
    at("pointerdown", { ...touch, clientX: 400, clientY: 50 }, 10);
    at("pointermove", { ...touch, clientX: 200, clientY: 50 }, 60);
    at("pointercancel", { ...touch, buttons: 0, clientX: 200, clientY: 50 }, 90);
    expect(h.onPanEnd).toHaveBeenCalledWith({ cancelled: true, timeStamp: 90, drewMeanwhile: false });
  });
});
