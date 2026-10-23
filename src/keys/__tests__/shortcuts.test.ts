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

  it("shortcuts_fire_when_range_input_focused", () => {
    setPlatform("Win32");
    const dispatch = vi.fn();
    unbind = bindShortcuts(DEFAULT_SHORTCUTS, dispatch);
    for (const type of ["range", "checkbox", "radio", "color", "button"]) {
      const input = document.createElement("input");
      input.type = type;
      document.body.appendChild(input);
      press({ key: "z", code: "KeyZ", ctrlKey: true }, input);
    }
    expect(dispatch).toHaveBeenCalledTimes(5);
    expect(dispatch.mock.calls.every((c) => c[0] === "undo")).toBe(true);
  });

  it("shortcuts_ignored_when_text_input_focused", () => {
    setPlatform("Win32");
    const dispatch = vi.fn();
    unbind = bindShortcuts(DEFAULT_SHORTCUTS, dispatch);
    const targets: HTMLElement[] = ["text", "search", "email", "url", "tel", "password", "number"].map((type) => {
      const input = document.createElement("input");
      input.type = type;
      return input;
    });
    targets.push(document.createElement("input")); // no type attribute
    targets.push(document.createElement("textarea"));
    targets.push(document.createElement("select"));
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true"); // jsdom lacks the contentEditable setter
    targets.push(editable);
    for (const t of targets) {
      document.body.appendChild(t);
      press({ key: "e", code: "KeyE" }, t);
      press({ key: "z", code: "KeyZ", ctrlKey: true }, t);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("editor_chrome_shortcuts_map_to_actions", () => {
    setPlatform("Win32");
    const dispatch = vi.fn();
    unbind = bindShortcuts(DEFAULT_SHORTCUTS, dispatch);
    const cases: [KeyboardEventInit, string][] = [
      [{ key: "t", code: "KeyT", ctrlKey: true }, "tab.new"],
      [{ key: "t", code: "KeyT" }, "tool.text"],
      [{ key: "n", code: "KeyN" }, "tool.insertSpace"],
      [{ key: "w", code: "KeyW", ctrlKey: true }, "tab.close"],
      [{ key: "ArrowLeft", code: "ArrowLeft", altKey: true, shiftKey: true }, "tab.move.left"],
      [{ key: "ArrowRight", code: "ArrowRight", altKey: true, shiftKey: true }, "tab.move.right"],
      [{ key: "\\", code: "Backslash", ctrlKey: true }, "sidebar.toggle"],
      [{ key: "F2", code: "F2" }, "page.rename"],
      [{ key: "ArrowUp", code: "ArrowUp", altKey: true }, "page.move.up"],
      [{ key: "ArrowDown", code: "ArrowDown", altKey: true }, "page.move.down"],
      [{ key: "ArrowLeft", code: "ArrowLeft", altKey: true }, "page.promote"],
      [{ key: "ArrowRight", code: "ArrowRight", altKey: true }, "page.demote"],
    ];
    for (const [init, action] of cases) {
      dispatch.mockClear();
      press(init);
      expect(dispatch.mock.calls[0]?.[0], action).toBe(action);
    }
  });
});
