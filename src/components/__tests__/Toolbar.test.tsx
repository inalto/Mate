import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 },
}));

const pick = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../images/insert", () => ({ pickAndInsertImage: pick }));

import { patchSettings } from "../../ipc/settings";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Page } from "../../model/types";
import { useChromeStore } from "../../stores/chrome";
import { endMindNodeEdit } from "../../mindmap/editSession";
import { mindmapOf } from "../../model/content";
import { useToastStore } from "../Toast";
import { MINDMAP_IMPORT_MAX_BYTES } from "../MindmapMenu";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useTabsStore } from "../../stores/tabs";
import { flushSettings, useSettingsStore } from "../../stores/settings";
import { setPlatformForTests } from "../../platform";
import { wheelToScroll } from "../DockPopover";
import Toolbar from "../Toolbar";

const renderBar = () =>
  render(
    <MemoryRouter>
      <Toolbar />
    </MemoryRouter>,
  );

const realUpdate = useSettingsStore.getState().update;

describe("Toolbar", () => {
  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS, update: realUpdate });
    useChromeStore.getState().setPaperPickerOpen(false);
    setPlatformForTests(false);
  });

  it("finger_toggle_only_on_mobile_and_cycles_draw_pan", () => {
    setPlatformForTests(false);
    renderBar();
    expect(screen.queryByRole("button", { name: /^Fingers/ })).toBeNull();
    cleanup();
    setPlatformForTests(true);
    try {
      renderBar();
      const btn = () => screen.getByRole("button", { name: /^Fingers/ });
      expect(btn().getAttribute("aria-label")).toBe("Fingers: automatic");
      fireEvent.click(btn());
      expect(useSettingsStore.getState().settings.fingerAction).toBe("draw");
      expect(btn().getAttribute("aria-label")).toBe("Fingers draw");
      fireEvent.click(btn());
      expect(useSettingsStore.getState().settings.fingerAction).toBe("pan");
      expect(btn().getAttribute("aria-label")).toBe("Fingers pan");
      fireEvent.click(btn());
      expect(useSettingsStore.getState().settings.fingerAction).toBe("draw");
    } finally {
      setPlatformForTests(false);
    }
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

  it("insert_space_button_selects_tool_and_opens_options", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Insert space" }));
    expect(useEditorStore.getState().tool).toBe("insert-space");
    fireEvent.click(screen.getByRole("button", { name: "Insert space" }));
    fireEvent.click(screen.getByRole("radio", { name: "Remove" }));
    expect(useEditorStore.getState().spaceMode).toBe("remove");
    fireEvent.click(screen.getByRole("checkbox", { name: "Cut images" }));
    expect(useEditorStore.getState().spaceCutImages).toBe(true);
  });

  it("insert_image_button_opens_the_picker", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Insert image…" }));
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it("insert_table_and_code_buttons", () => {
    const addTable = vi.fn();
    const addCodespace = vi.fn();
    useEditorStore.setState({ addTable, addCodespace });
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Insert table" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert code" }));
    expect(addTable).toHaveBeenCalledTimes(1);
    expect(addCodespace).toHaveBeenCalledTimes(1);
  });

  it("insert_equation_button", () => {
    const addMathBox = vi.fn();
    useEditorStore.setState({ addMathBox });
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Insert equation" }));
    expect(addMathBox).toHaveBeenCalledTimes(1);
  });

  it("data_dock_follows_the_setting_and_vertical_docks_set_orientation", () => {
    const { rerender } = renderBar();
    const bar = () => screen.getByRole("toolbar", { name: "Editor tools" });
    expect(bar().getAttribute("data-dock")).toBe("top");
    expect(bar().getAttribute("aria-orientation")).toBe("horizontal");
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, toolbarDock: "left" } });
    rerender(
      <MemoryRouter>
        <Toolbar />
      </MemoryRouter>,
    );
    expect(bar().getAttribute("data-dock")).toBe("left");
    expect(bar().getAttribute("aria-orientation")).toBe("vertical");
  });

  it("vertical_docks_fall_back_to_top_on_mobile", () => {
    setPlatformForTests(true);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, toolbarDock: "right" } });
    renderBar();
    expect(screen.getByRole("toolbar", { name: "Editor tools" }).getAttribute("data-dock")).toBe("top");
    fireEvent.click(screen.getByRole("button", { name: "Move toolbar" }));
    expect(screen.queryByRole("menuitemradio", { name: "Left" })).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "Bottom" })).toBeTruthy();
  });

  it("dock_menu_lists_four_positions_and_writes_the_setting", () => {
    const update = vi.fn(async () => {});
    useSettingsStore.setState({ update });
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Move toolbar" }));
    const menu = screen.getByRole("menu", { name: "Toolbar position" });
    expect(within(menu).getAllByRole("menuitemradio").map((e) => e.textContent)).toEqual(["Top", "Bottom", "Left", "Right"]);
    expect(within(menu).getByRole("menuitemradio", { name: "Top" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Bottom" }));
    expect(update).toHaveBeenCalledWith({ toolbarDock: "bottom" });
    expect(screen.queryByRole("menu", { name: "Toolbar position" })).toBeNull();
  });

  it("paper_button_toggles_the_picker_popover_for_the_focused_page", () => {
    const STAMP = "2026-01-01T00:00:00.000Z";
    const page: Page = {
      id: "p1",
      sectionId: "s1",
      title: "P",
      isExpanded: false,
      isFavourite: false,
      depth: 0,
      mode: "page",
      backgroundConfig: { type: "ruled", spacing: 40, dotRadius: 1.5 },
      thumbnailVersion: 0,
      orderIndex: 0,
      createdAt: STAMP,
      updatedAt: STAMP,
      version: 0,
    };
    useNotebookStore.setState((s) => ({ tree: { ...s.tree, pages: [page] } }));
    useTabsStore.setState({
      tabs: [{ id: "t1", panes: [{ pageId: "p1" }], focusedPaneIndex: 0 }],
      activeTabId: "t1",
    } as never);
    renderBar();
    const btn = () => screen.getByRole("button", { name: "Paper" });
    expect(screen.queryByRole("dialog", { name: /paper/i })).toBeNull();
    fireEvent.click(btn());
    expect(useChromeStore.getState().paperPickerOpen).toBe(true);
    const dlg = screen.getByRole("dialog", { name: /paper/i });
    expect(dlg.closest(".tb-portal")).not.toBeNull();
    expect(within(dlg).getByRole("button", { name: "Ruled" })).toBeTruthy();
    expect(dlg.contains(document.activeElement)).toBe(true); // focus moved in although placement is pending
    // A dialog opening on top closes the popover.
    act(() => useChromeStore.getState().pushModal());
    expect(useChromeStore.getState().paperPickerOpen).toBe(false);
    act(() => useChromeStore.getState().popModal());
    fireEvent.click(btn());
    fireEvent.click(btn());
    expect(useChromeStore.getState().paperPickerOpen).toBe(false);
    expect(screen.queryByRole("dialog", { name: /paper/i })).toBeNull();
  });

  it("text_tool_button", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    expect(useEditorStore.getState().tool).toBe("text");
    expect(screen.getByRole("button", { name: "Text" }).getAttribute("aria-pressed")).toBe("true");
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
    expect(patchSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Shape" })); // closes and saves
    expect(screen.queryByRole("dialog", { name: "Shape options" })).toBeNull();
    await flushSettings();
    expect(patchSettings).toHaveBeenCalledWith(expect.objectContaining({ defaultShapeType: "star", defaultShapeStrokeWidth: 6.5 }));
  });

  it("wheel_to_scroll_maps_vertical_wheels_only", () => {
    expect(wheelToScroll({ deltaX: 0, deltaY: 40, deltaMode: 0 })).toBe(40);
    expect(wheelToScroll({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toBe(48);
    expect(wheelToScroll({ deltaX: 30, deltaY: 5, deltaMode: 0 })).toBe(0);
  });
});

describe("Toolbar mind-map button", () => {
  const maps = () => [...useEditorStore.getState().elements.values()].filter((e) => e.type === "mindmap");
  async function emptyPage(): Promise<void> {
    useNotebookStore.setState({ loaded: true });
    await useEditorStore.getState().loadPage("pg");
    useEditorStore.getState().setViewport({ width: 1000, height: 600 });
    useToastStore.getState().dismiss();
  }
  afterEach(() => {
    endMindNodeEdit();
    cleanup();
  });
  const fileInput = () => document.querySelector("input[data-mindmap-import]") as HTMLInputElement;
  const choose = (file: { name: string; size: number; text: () => Promise<string> }) => {
    const input = fileInput();
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
  };

  it("click_places_a_map_and_the_caret_opens_the_menu_without_a_selected_map", async () => {
    await emptyPage();
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Mind map options" }));
    expect(maps()).toHaveLength(0);
    const menu = screen.getByRole("menu", { name: "Mind map" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Filled/ }));
    expect(maps()).toHaveLength(1);
    expect(mindmapOf(maps()[0])!.style).toBe(2);
    expect(screen.queryByRole("menu")).toBeNull();
    // The main button places a map (in the last picked style), also with a map selected.
    endMindNodeEdit();
    fireEvent.click(screen.getByRole("button", { name: "Mind map" }));
    expect(maps()).toHaveLength(2);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Mind map" }).hasAttribute("aria-haspopup")).toBe(false);
  });

  it("import_opens_the_picker_and_inserts_the_file", async () => {
    await emptyPage();
    renderBar();
    const click = vi.spyOn(fileInput(), "click").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "Mind map options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Import…" }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(maps()).toHaveLength(0);
    await act(async () => choose({ name: "plan.mm", size: 60, text: async () => '<map><node TEXT="Plan"><node TEXT="Step"/></node></map>' }));
    expect(maps()).toHaveLength(1);
    const root = mindmapOf(maps()[0])!.root;
    expect(root.text).toBe("Plan");
    expect(root.children.map((c) => c.text)).toEqual(["Step"]);
  });

  it("refuses_a_file_over_2_mb_with_a_toast", async () => {
    await emptyPage();
    renderBar();
    const text = vi.fn(async () => "<map/>");
    await act(async () => choose({ name: "big.mm", size: MINDMAP_IMPORT_MAX_BYTES + 1, text }));
    expect(text).not.toHaveBeenCalled();
    expect(maps()).toHaveLength(0);
    expect(useToastStore.getState().message).toBe("The file is larger than 2 MB");
  });

  it("a_file_that_does_not_parse_shows_the_import_failed_toast", async () => {
    await emptyPage();
    renderBar();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => choose({ name: "bad.opml", size: 20, text: async () => "<opml><body>" }));
    expect(maps()).toHaveLength(0);
    expect(useToastStore.getState().message).toBe("Could not import this file");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
