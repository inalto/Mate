import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { useSettingsStore } from "../../stores/settings";
import { createPenInkHaptics, penHaptics, resetPenHaptics } from "../haptics";

const setPlatform = (p: string) => vi.spyOn(navigator, "platform", "get").mockReturnValue(p);
const setHaptics = (on: boolean | undefined) =>
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, penHaptics: on } as typeof s.settings }));

function penDown(el: HTMLElement, pointerId: number, pointerType = "pen") {
  const e = new Event("pointerdown", { bubbles: true }) as PointerEvent;
  Object.assign(e, { pointerId, pointerType });
  el.dispatchEvent(e);
}

describe("pen haptics", () => {
  const initial = useSettingsStore.getState().settings;
  beforeEach(() => {
    invoke.mockClear();
    resetPenHaptics();
    setPlatform("Win32");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({ settings: initial });
  });

  it("haptics_called_once_per_contact_when_enabled", () => {
    setHaptics(true);
    penHaptics("inkStart", 7);
    penHaptics("inkStart", 7);
    penHaptics("inkStop", 7);
    penHaptics("inkStop", 7);
    expect(invoke.mock.calls).toEqual([
      ["pen_haptics_pulse", { pointerId: 7, kind: "inkStart" }],
      ["pen_haptics_pulse", { pointerId: 7, kind: "inkStop" }],
    ]);
  });

  it("defaults_on_when_setting_missing", () => {
    setHaptics(undefined);
    penHaptics("click", 3);
    expect(invoke).toHaveBeenCalledWith("pen_haptics_pulse", { pointerId: 3, kind: "click" });
  });

  it("no_haptics_when_disabled", () => {
    setHaptics(false);
    penHaptics("inkStart", 7);
    penHaptics("click", 7);
    penHaptics("inkStop", 7);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("open_contact_still_stops_after_disabling", () => {
    setHaptics(true);
    penHaptics("inkStart", 7);
    setHaptics(false);
    penHaptics("inkStop", 7);
    expect(invoke).toHaveBeenLastCalledWith("pen_haptics_pulse", { pointerId: 7, kind: "inkStop" });
  });

  it("no_haptics_off_windows", () => {
    setHaptics(true);
    setPlatform("MacIntel");
    penHaptics("inkStart", 7);
    penHaptics("click", 7);
    penHaptics("inkStop", 7);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("canvas_hook_uses_the_pen_pointer_id_and_ignores_other_pointers", () => {
    setHaptics(true);
    const el = document.createElement("div");
    const ink = createPenInkHaptics(el);
    penDown(el, 1, "mouse");
    ink.start("mouse");
    expect(invoke).not.toHaveBeenCalled();
    penDown(el, 4);
    ink.start("pen");
    ink.click();
    ink.stop();
    ink.stop();
    expect(invoke.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      { pointerId: 4, kind: "inkStart" },
      { pointerId: 4, kind: "click" },
      { pointerId: 4, kind: "inkStop" },
    ]);
    penDown(el, 5);
    ink.start("pen");
    ink.dispose();
    expect(invoke).toHaveBeenLastCalledWith("pen_haptics_pulse", { pointerId: 5, kind: "inkStop" });
  });
});
