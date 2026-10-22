import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { useEditorStore } from "../../stores/editor";
import { useSettingsStore } from "../../stores/settings";
import Toolbar from "../Toolbar";

const renderBar = () =>
  render(
    <MemoryRouter>
      <Toolbar />
    </MemoryRouter>,
  );

describe("Toolbar", () => {
  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  });

  it("selects_and_removes_presets", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Pen #C62828" }));
    expect(useEditorStore.getState().preset.id).toBe("preset-2");
    fireEvent.click(screen.getByRole("button", { name: "Eraser" }));
    expect(useEditorStore.getState().tool).toBe("eraser");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Highlighter #FDE047" }));
    expect(useSettingsStore.getState().settings.toolbarPresets.map((p) => p.id)).not.toContain("preset-4");
    expect(screen.queryByRole("button", { name: "Highlighter #FDE047" })).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toHaveProperty("disabled", true);
  });
});
