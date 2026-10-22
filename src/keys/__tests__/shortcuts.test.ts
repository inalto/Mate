import { afterEach, describe, expect, it, vi } from "vitest";
import { bindShortcuts, DEFAULT_SHORTCUTS } from "../shortcuts";

const press = (init: KeyboardEventInit, target: EventTarget = window) => {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

const setPlatform = (value: string) =>
  Object.defineProperty(window.navigator, "platform", { value, configurable: true });

describe("shortcuts", () => {
  let unbind: (() => void) | null = null;
  afterEach(() => {
    unbind?.();
    unbind = null;
    setPlatform("Win32");
    document.body.innerHTML = "";
  });

  it("ctrl_z_dispatches_undo", () => {
    setPlatform("Win32");
    const dispatch = vi.fn();
    unbind = bindShortcuts(DEFAULT_SHORTCUTS, dispatch);
    const e = press({ key: "z", code: "KeyZ", ctrlKey: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toBe("undo");
    expect(e.defaultPrevented).toBe(true);
    press({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true });
    expect(dispatch.mock.calls[1][0]).toBe("redo");
    press({ key: "y", code: "KeyY", ctrlKey: true });
    expect(dispatch.mock.calls[2][0]).toBe("redo");
    // Ignored while typing in a field.
    const input = document.createElement("input");
    document.body.appendChild(input);
    press({ key: "z", code: "KeyZ", ctrlKey: true }, input);
    expect(dispatch).toHaveBeenCalledTimes(3);
    unbind();
    unbind = null;
    press({ key: "z", code: "KeyZ", ctrlKey: true });
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("alt_3_selects_slot_3", () => {
    setPlatform("Win32");
    const dispatch = vi.fn();
    unbind = bindShortcuts(DEFAULT_SHORTCUTS, dispatch);
    press({ key: "3", code: "Digit3", altKey: true });
    expect(dispatch).toHaveBeenCalledWith("preset.slot", expect.objectContaining({ slot: 3 }));
    press({ key: "3", code: "Digit3" }); // plain 3 is not bound
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("mac_uses_meta", () => {
    setPlatform("MacIntel");
    const dispatch = vi.fn();
    unbind = bindShortcuts(DEFAULT_SHORTCUTS, dispatch);
    press({ key: "z", code: "KeyZ", ctrlKey: true });
    expect(dispatch).not.toHaveBeenCalled();
    press({ key: "z", code: "KeyZ", metaKey: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toBe("undo");
  });
});
