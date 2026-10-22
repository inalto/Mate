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
});
