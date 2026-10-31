import { afterEach, describe, expect, it, vi } from "vitest";
import { createPointerAdapter } from "../input";

function setup() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const handlers = { onDown: vi.fn(), onMove: vi.fn(), onUp: vi.fn(), onCancel: vi.fn() };
  createPointerAdapter(el, handlers, {
    palmRejection: "high",
    fingerAction: "pan",
    getCamera: () => ({ x: 0, y: 0, z: 1 }),
  });
  const base = { pointerId: 1, pointerType: "pen" };
  el.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, cancelable: true, ...base, clientX: 1, clientY: 1, button: 0, buttons: 1, pressure: 0.5 }),
  );
  const move = (coalesced?: () => unknown[]) => {
    const ev = new PointerEvent("pointermove", { bubbles: true, cancelable: true, ...base, clientX: 5, clientY: 5, buttons: 1, pressure: 0.5 });
    // jsdom lacks getCoalescedEvents; define it per event (or force it absent).
    Object.defineProperty(ev, "getCoalescedEvents", { value: coalesced, configurable: true });
    el.dispatchEvent(ev);
  };
  return { handlers, move };
}

const mk = (x: number) => new PointerEvent("pointermove", { clientX: x, clientY: x, pointerType: "pen", pressure: 0.5 });

afterEach(() => {
  document.body.innerHTML = "";
});

describe("coalesced event fallback", () => {
  it("yields one point when getCoalescedEvents is undefined", () => {
    const { handlers, move } = setup();
    move(undefined);
    expect(handlers.onMove.mock.calls[0][0]).toHaveLength(1);
  });

  it("yields one point when getCoalescedEvents returns []", () => {
    const { handlers, move } = setup();
    move(() => []);
    expect(handlers.onMove.mock.calls[0][0]).toHaveLength(1);
  });

  it("yields every coalesced point otherwise", () => {
    const { handlers, move } = setup();
    move(() => [mk(2), mk(4)]);
    const pts = handlers.onMove.mock.calls[0][0];
    expect(pts).toHaveLength(2);
    expect(pts[0]).toMatchObject({ x: 2, y: 2 });
  });
});
