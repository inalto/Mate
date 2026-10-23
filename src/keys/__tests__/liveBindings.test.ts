import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { useSettingsStore } from "../../stores/settings";
import { bindLiveShortcuts, bindShortcuts, DEFAULT_SHORTCUTS } from "../shortcuts";

const press = (init: KeyboardEventInit, target: EventTarget = window) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

const setKeybindings = (keybindings: { action: string; keys: string }[]) =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, keybindings } });

afterEach(() => {
  setKeybindings([]);
  document.body.innerHTML = "";
});

describe("live bindings", () => {
  it("bindings_ignore_typing_targets", () => {
    const dispatch = vi.fn();
    const unbind = bindShortcuts(DEFAULT_SHORTCUTS, dispatch);
    for (const el of [document.createElement("input"), document.createElement("textarea")]) {
      document.body.appendChild(el);
      press({ key: "p", code: "KeyP" }, el);
      press({ key: "?", code: "Slash", shiftKey: true }, el);
      press({ key: "s", code: "KeyS", ctrlKey: true }, el);
    }
    expect(dispatch).not.toHaveBeenCalled();
    press({ key: "?", code: "Slash", shiftKey: true });
    expect(dispatch.mock.calls[0][0]).toBe("help.shortcuts");
    unbind();
  });

  it("rebinds_when_overrides_change", () => {
    const dispatch = vi.fn();
    const unbind = bindLiveShortcuts(dispatch);
    press({ key: "z", code: "KeyZ", ctrlKey: true });
    expect(dispatch.mock.calls.at(-1)?.[0]).toBe("undo");
    setKeybindings([{ action: "undo", keys: "Ctrl+J" }]);
    dispatch.mockClear();
    press({ key: "z", code: "KeyZ", ctrlKey: true });
    expect(dispatch).not.toHaveBeenCalled();
    press({ key: "j", code: "KeyJ", ctrlKey: true });
    expect(dispatch.mock.calls[0][0]).toBe("undo");
    setKeybindings([]);
    press({ key: "z", code: "KeyZ", ctrlKey: true });
    expect(dispatch.mock.calls.at(-1)?.[0]).toBe("undo");
    unbind();
  });

  it("new_defaults_dispatch", () => {
    const dispatch = vi.fn();
    const unbind = bindShortcuts(DEFAULT_SHORTCUTS, dispatch);
    const cases: [KeyboardEventInit, string][] = [
      [{ key: "s", code: "KeyS", ctrlKey: true }, "save"],
      [{ key: "g", code: "KeyG", ctrlKey: true }, "group"],
      [{ key: "G", code: "KeyG", ctrlKey: true, shiftKey: true }, "ungroup"],
      [{ key: "A", code: "KeyA", ctrlKey: true, shiftKey: true }, "deselect"],
      [{ key: "a", code: "KeyA", ctrlKey: true }, "selectAll"],
      [{ key: "]", code: "BracketRight", ctrlKey: true }, "arrange.forward"],
      [{ key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true }, "arrange.front"],
      [{ key: "=", code: "Equal", ctrlKey: true }, "zoom.in"],
      [{ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }, "zoom.in"],
      [{ key: "-", code: "Minus", ctrlKey: true }, "zoom.out"],
      [{ key: "0", code: "Digit0", ctrlKey: true }, "zoom.reset"],
      [{ key: "PageUp", code: "PageUp", ctrlKey: true }, "page.prev"],
      [{ key: "PageDown", code: "PageDown", ctrlKey: true }, "page.next"],
      [{ key: "N", code: "KeyN", ctrlKey: true, shiftKey: true }, "window.openPage"],
      [{ key: "k", code: "KeyK", ctrlKey: true }, "palette.open"],
    ];
    for (const [init, action] of cases) {
      dispatch.mockClear();
      press(init);
      expect(dispatch.mock.calls[0]?.[0], action).toBe(action);
    }
    unbind();
  });
});
