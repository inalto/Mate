import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));

const pick = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../images/insert", () => ({ pickAndInsertImage: pick }));

import { setSettings } from "../../ipc/settings";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { useEditorStore } from "../../stores/editor";
import { flushSettings, useSettingsStore } from "../../stores/settings";
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

  it("insert_image_button_opens_the_picker", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Insert image…" }));
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it("text_tool_button", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Text (T)" }));
    expect(useEditorStore.getState().tool).toBe("text");
    expect(screen.getByRole("button", { name: "Text (T)" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shape_tool_menu_sets_and_persists_shape_defaults", async () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Shape" }));
    expect(useEditorStore.getState().tool).toBe("shape");
    expect(screen.queryByRole("dialog", { name: "Shape options" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Shape" })); // second click opens the menu
    const menu = screen.getByRole("dialog", { name: "Shape options" });
    expect(within(menu).getAllByRole("radio")).toHaveLength(11);
    fireEvent.click(within(menu).getByRole("radio", { name: "Star" }));
    fireEvent.click(within(menu).getByRole("button", { name: "Stroke #C62828" }));
    fireEvent.click(within(menu).getByRole("button", { name: "Fill #1565C0" }));
    fireEvent.change(within(menu).getByRole("slider", { name: "Fill opacity" }), { target: { value: "0.25" } });
    fireEvent.change(within(menu).getByRole("slider", { name: "Stroke width" }), { target: { value: "6.5" } });
    const cfg = () => useSettingsStore.getState().settings;
    expect(cfg()).toMatchObject({
      defaultShapeType: "star",
      defaultShapeStrokeColor: "#C62828",
      defaultShapeFillColor: "#1565C0",
      defaultShapeFillOpacity: 0.25,
      defaultShapeStrokeWidth: 6.5,
    });
    fireEvent.click(within(menu).getByRole("button", { name: "No fill" }));
    expect(cfg().defaultShapeFillColor).toBe("transparent");
    expect(setSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Shape" })); // closes and saves
    expect(screen.queryByRole("dialog", { name: "Shape options" })).toBeNull();
    await flushSettings();
    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ defaultShapeType: "star", defaultShapeStrokeWidth: 6.5 }));
  });
});
