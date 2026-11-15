import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import type { PenPreset } from "../../model/types";
import { useSettingsStore } from "../../stores/settings";
import PresetMenu from "../PresetMenu";

const cover: PenPreset = { id: "cv", type: "cover", color: "#334155", width: 28, coverShape: "stroke" };
const pen: PenPreset = { id: "pn", type: "pen", color: "#000000", width: 3 };

const mount = (preset: PenPreset) => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, toolbarPresets: [...DEFAULT_SETTINGS.toolbarPresets, preset] } });
  return render(<PresetMenu preset={preset} index={0} count={1} anchorRef={createRef<HTMLElement>()} onClose={() => {}} />);
};
const saved = (id: string) => useSettingsStore.getState().settings.toolbarPresets.find((p) => p.id === id);

describe("PresetMenu", () => {
  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  });

  it("choosing Box then closing persists coverShape box", () => {
    const view = mount(cover);
    const stroke = screen.getByRole("radio", { name: "Stroke" });
    expect(stroke.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Box" }));
    expect(screen.getByRole("radio", { name: "Box" }).getAttribute("aria-checked")).toBe("true");
    view.unmount();
    expect(saved("cv")?.coverShape).toBe("box");
  });

  it("a cover preset offers the cover palette and an 8 to 80 width slider", () => {
    mount(cover);
    expect(screen.getByRole("button", { name: "Colour #FFFFFF" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Colour #C62828" })).toBeNull();
    const width = screen.getByRole("slider", { name: "Width" }) as HTMLInputElement;
    expect([width.min, width.max]).toEqual(["8", "80"]);
  });

  it("a pen preset shows no Stroke/Box control", () => {
    mount(pen);
    expect(screen.queryByRole("radio", { name: "Box" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Stroke" })).toBeNull();
  });
});
