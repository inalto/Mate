import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 },
}));

import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Page } from "../../model/types";
import { setPlatformForTests } from "../../platform";
import { useChromeStore } from "../../stores/chrome";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import Toolbar from "../../components/Toolbar";
import { ITEM_IDS, toSaved, type Slot } from "../layout";
import MoreMenu from "../MoreMenu";

const realUpdate = useSettingsStore.getState().update;

const withLayout = (rows: Slot[][]) =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, toolbarLayout: toSaved(rows) } });
const renderBar = () =>
  render(
    <MemoryRouter>
      <Toolbar />
    </MemoryRouter>,
  );
const openMore = () => fireEvent.click(screen.getByRole("button", { name: "More tools" }));
const tray = () => screen.queryByRole("group", { name: "Hidden tools" });

describe("MoreMenu", () => {
  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS, update: realUpdate });
    useChromeStore.setState({ modalDepth: 0, toolbarCustomizeOpen: false, paperPickerOpen: false });
    useEditorStore.setState({ ruler: { on: false, pose: null } });
    setPlatformForTests(false);
  });

  it("hidden_items_appear_in_the_tray_and_work", () => {
    withLayout([["pens", "eraser"]]);
    renderBar();
    expect(screen.queryByRole("button", { name: "Ruler" })).toBeNull();
    openMore();
    const group = tray()!;
    expect(group.className).toContain("tb-tray");
    fireEvent.click(within(group).getByRole("button", { name: "Ruler" }));
    expect(useEditorStore.getState().ruler.on).toBe(true);
  });

  it("a_hidden_tools_options_open_from_the_tray_without_closing_it", () => {
    withLayout([["pens", "ruler"]]);
    renderBar();
    openMore();
    const eraser = within(tray()!).getByRole("button", { name: "Eraser" });
    fireEvent.click(eraser);
    fireEvent.click(eraser);
    const options = screen.getByRole("dialog", { name: "Eraser options" });
    expect(tray()).not.toBeNull();
    fireEvent.pointerDown(within(options).getAllByRole("radio")[0]);
    expect(screen.queryByRole("dialog", { name: "Eraser options" })).not.toBeNull();
    expect(tray()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Eraser options" })).toBeNull();
    expect(tray()).toBeNull();
  });

  it("escape_closes_a_nested_popover_and_the_tray", () => {
    withLayout([["pens", "ruler"]]);
    renderBar();
    openMore();
    const eraser = within(tray()!).getByRole("button", { name: "Eraser" });
    fireEvent.click(eraser);
    fireEvent.click(eraser);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Eraser options" })).toBeNull();
    expect(tray()).toBeNull();
  });

  it("a_real_dialog_opening_on_top_still_closes_the_popover", () => {
    renderBar();
    openMore();
    expect(tray()).not.toBeNull();
    act(() => useChromeStore.getState().pushModal());
    expect(tray()).toBeNull();
  });

  it("paper_opens_from_the_tray_and_the_tray_stays", () => {
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
    useTabsStore.setState({ tabs: [{ id: "t1", panes: [{ pageId: "p1" }], focusedPaneIndex: 0 }], activeTabId: "t1" } as never);
    withLayout([["pens"]]);
    renderBar();
    openMore();
    fireEvent.click(within(tray()!).getByRole("button", { name: "Paper" }));
    expect(screen.getByRole("dialog", { name: /paper/i })).toBeTruthy();
    expect(tray()).not.toBeNull();
    // Closing More (a pointer-down outside) takes the picker with it and clears the flag.
    fireEvent.pointerDown(document.body);
    expect(tray()).toBeNull();
    expect(useChromeStore.getState().paperPickerOpen).toBe(false);
    expect(useChromeStore.getState().modalDepth).toBe(0);
  });

  it("dock_position_moved_into_more", () => {
    const update = vi.fn(async () => {});
    useSettingsStore.setState({ update });
    renderBar();
    openMore();
    const menu = screen.getByRole("menu", { name: "Toolbar position" });
    expect(within(menu).getAllByRole("menuitemradio").map((e) => e.textContent)).toEqual(["Top", "Bottom", "Left", "Right"]);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Bottom" }));
    expect(update).toHaveBeenCalledWith({ toolbarDock: "bottom" });
    expect(screen.queryByRole("menu", { name: "Toolbar position" })).toBeNull();
  });

  it("mobile_offers_only_top_and_bottom", () => {
    setPlatformForTests(true);
    renderBar();
    openMore();
    expect(screen.queryByRole("menuitemradio", { name: "Left" })).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "Bottom" })).toBeTruthy();
  });

  it("no_tray_when_nothing_is_hidden", () => {
    withLayout([[...ITEM_IDS.filter((id) => id !== "finger")]]);
    renderBar();
    openMore();
    expect(tray()).toBeNull();
    expect(screen.getByRole("menu", { name: "Toolbar position" })).toBeTruthy();
  });

  it("a_tray_whose_tools_render_nothing_is_empty_so_css_hides_it", () => {
    withLayout([[...ITEM_IDS.filter((id) => id !== "finger" && id !== "covers")]]);
    renderBar();
    openMore();
    expect(tray()!.matches(":empty")).toBe(true); // Covers without covers: `.tb-tray:empty` hides the box
  });

  it("customize_entry_calls_back_and_closes", () => {
    const onCustomize = vi.fn();
    render(<MoreMenu onCustomize={onCustomize} />);
    openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "Customize toolbar…" }));
    expect(onCustomize).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "Customize toolbar…" })).toBeNull();
  });

  it("the_toolbar_asks_the_chrome_store_to_open_the_customize_dialog", () => {
    renderBar();
    openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "Customize toolbar…" }));
    expect(useChromeStore.getState().toolbarCustomizeOpen).toBe(true);
  });
});
