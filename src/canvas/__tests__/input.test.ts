import { afterEach, describe, expect, it, vi } from "vitest";
import { createPointerAdapter } from "../input";

const camera = () => ({ x: 0, y: 0, z: 1 });

function setup(opts: { palmRejection?: "off" | "low" | "high"; drawWithFinger?: boolean } = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const handlers = { onDown: vi.fn(), onMove: vi.fn(), onUp: vi.fn(), onCancel: vi.fn() };
  const dispose = createPointerAdapter(el, handlers, {
    palmRejection: opts.palmRejection ?? "high",
    drawWithFinger: opts.drawWithFinger ?? false,
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

  it("touch_with_large_radius_rejected_when_high", () => {
    const { el, handlers } = setup({ palmRejection: "high", drawWithFinger: true });
    fire(el, "pointerdown", { pointerId: 2, pointerType: "touch", width: 30, height: 30, buttons: 1, clientX: 5, clientY: 5 });
    fire(el, "pointermove", { pointerId: 2, pointerType: "touch", width: 30, height: 30, buttons: 1, clientX: 9, clientY: 9 });
    fire(el, "pointerup", { pointerId: 2, pointerType: "touch", width: 30, height: 30, clientX: 9, clientY: 9 });
    expect(handlers.onDown).not.toHaveBeenCalled();
    expect(handlers.onMove).not.toHaveBeenCalled();
    expect(handlers.onUp).not.toHaveBeenCalled();
    // The same contact passes with low sensitivity (40 px threshold).
    const low = setup({ palmRejection: "low", drawWithFinger: true });
    fire(low.el, "pointerdown", { pointerId: 3, pointerType: "touch", width: 30, height: 30, buttons: 1, clientX: 5, clientY: 5 });
    expect(low.handlers.onDown).toHaveBeenCalledTimes(1);
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
    const { el, handlers } = setup({ palmRejection: "high", drawWithFinger: true });
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
});
