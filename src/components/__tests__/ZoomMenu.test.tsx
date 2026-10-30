import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));

import ZoomIndicator from "../../canvas/ZoomIndicator";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useSettingsStore } from "../../stores/settings";

let store: EditorStore;
const resetCamera = vi.fn();
const fitPage = vi.fn();
const fitSelection = vi.fn();

describe("zoom menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, showZoomIndicator: true } });
    store = createEditorStore();
    store.setState({ camera: { x: 0, y: 0, z: 1.25 }, resetCamera, fitPage, fitSelection });
  });
  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  });

  const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Zoom options" }));

  it("badge_click_still_resets", () => {
    render(<ZoomIndicator store={store} />);
    fireEvent.click(screen.getByRole("button", { name: /Zoom 125%/ }));
    expect(resetCamera).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("caret_opens_the_menu_with_the_percentage_header", () => {
    render(<ZoomIndicator store={store} />);
    openMenu();
    const menu = screen.getByRole("menu");
    expect(menu.textContent).toContain("125%");
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["100 %", "Fit page", "Fit selection"]);
  });

  it("fit_selection_is_disabled_without_a_selection", () => {
    render(<ZoomIndicator store={store} />);
    openMenu();
    expect((screen.getByRole("menuitem", { name: "Fit selection" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => store.setState({ selection: new Set(["x"]) }));
    expect((screen.getByRole("menuitem", { name: "Fit selection" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("menuitem", { name: "Fit selection" }));
    expect(fitSelection).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("items_call_reset_and_fit_page", () => {
    render(<ZoomIndicator store={store} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Fit page" }));
    expect(fitPage).toHaveBeenCalledTimes(1);
    // A right-click on the badge opens the menu too.
    fireEvent.contextMenu(screen.getByRole("button", { name: /Zoom 125%/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "100 %" }));
    expect(resetCamera).toHaveBeenCalledTimes(1);
  });
});
