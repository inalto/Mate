import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 },
}));

import Toolbar from "../../components/Toolbar";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { setPlatformForTests } from "../../platform";
import ThemeSection from "../../routes/Settings/sections/ThemeSection";
import { useChromeStore } from "../../stores/chrome";
import { useSettingsStore } from "../../stores/settings";
import CustomizeToolbar from "../CustomizeToolbar";
import { ITEM_IDS, toSaved, type Slot } from "../layout";

const withLayout = (rows: Slot[][]) =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, toolbarLayout: toSaved(rows) } });
const saved = () => useSettingsStore.getState().settings.toolbarLayout!;
const renderDialog = () => render(<CustomizeToolbar onClose={() => {}} />);
const list = (name: string) => screen.getByRole("list", { name });
const labels = (name: string) =>
  within(list(name))
    .getAllByRole("listitem")
    .map((li) => li.querySelector(".tbc-label")!.textContent);
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

/** The same conditional mount as `Shell`. */
function Mount() {
  const open = useChromeStore((s) => s.toolbarCustomizeOpen);
  return open ? <CustomizeToolbar onClose={() => useChromeStore.getState().setToolbarCustomizeOpen(false)} /> : null;
}
const renderBarWithDialog = () =>
  render(
    <MemoryRouter>
      <Toolbar />
      <Mount />
    </MemoryRouter>,
  );

describe("CustomizeToolbar", () => {
  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
    useChromeStore.setState({ modalDepth: 0, toolbarCustomizeOpen: false });
    setPlatformForTests(false);
  });

  it("lists_the_default_layout_and_hidden_items", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Customize toolbar" })).toBeTruthy();
    expect(labels("Row 1")[0]).toBe("Pens");
    expect(screen.queryByRole("list", { name: "Row 2" })).toBeNull();
    const hidden = labels("Hidden");
    expect(hidden).toContain("Insert image…");
    expect(hidden).toContain("Insert table");
    expect(hidden).not.toContain("Finger mode");
  });

  it("hide_writes_a_layout_without_the_item", () => {
    renderDialog();
    click("Hide Ruler");
    expect(saved().rows.flat()).not.toContain("ruler");
    expect(saved().known).toEqual([...ITEM_IDS]);
    expect(labels("Hidden")).toContain("Ruler");
    expect(labels("Row 1")).not.toContain("Ruler");
  });

  it("show_appends_to_row_one", () => {
    withLayout([["pens", "eraser"]]);
    renderDialog();
    click("Show Ruler");
    expect(saved().rows).toEqual([["pens", "eraser", "ruler"]]);
    expect(labels("Hidden")).not.toContain("Ruler");
  });

  it("move_up_and_down_reorder", () => {
    withLayout([["pens", "eraser", "ruler"]]);
    renderDialog();
    expect((screen.getByRole("button", { name: "Move Pens up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move Ruler down" }) as HTMLButtonElement).disabled).toBe(true);
    click("Move Ruler up");
    expect(saved().rows).toEqual([["pens", "ruler", "eraser"]]);
    click("Move Pens down");
    expect(saved().rows).toEqual([["ruler", "pens", "eraser"]]);
    expect(labels("Row 1")).toEqual(["Ruler", "Pens", "Eraser"]);
  });

  it("move_down_from_the_end_of_row_one_enters_row_two", () => {
    withLayout([["pens", "eraser"], ["ruler"]]);
    renderDialog();
    click("Move Eraser down");
    expect(saved().rows).toEqual([["pens"], ["eraser", "ruler"]]);
    click("Move Eraser up");
    expect(saved().rows).toEqual([["pens", "eraser"], ["ruler"]]);
  });

  it("two_rows_switch_adds_and_removes_the_second_row", () => {
    withLayout([["pens", "eraser", "ruler"]]);
    renderDialog();
    const box = screen.getByRole("checkbox", { name: "Use two rows" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect(list("Row 2")).toBeTruthy();
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    click("Move Ruler to the other row");
    expect(saved().rows).toEqual([["pens", "eraser"], ["ruler"]]);
    expect(labels("Row 2")).toEqual(["Ruler"]);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    expect(saved().rows).toEqual([["pens", "eraser", "ruler"]]);
    expect(screen.queryByRole("list", { name: "Row 2" })).toBeNull();
  });

  it("move_down_across_the_boundary_fills_a_row_two_that_is_on_but_empty", () => {
    withLayout([["pens", "eraser"]]);
    renderDialog();
    fireEvent.click(screen.getByRole("checkbox", { name: "Use two rows" }));
    click("Move Eraser down");
    expect(saved().rows).toEqual([["pens"], ["eraser"]]);
  });

  it("pens_cannot_be_hidden", () => {
    renderDialog();
    expect((screen.getByRole("button", { name: "Hide Pens" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Hide Ruler" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("add_and_remove_separator", () => {
    withLayout([["pens", "eraser", "ruler"]]);
    renderDialog();
    click("Add separator");
    expect(saved().rows).toEqual([["pens", "eraser", "sep", "ruler"]]);
    expect(labels("Row 1")).toEqual(["Pens", "Eraser", "Separator", "Ruler"]);
    click("Remove separator");
    expect(saved().rows).toEqual([["pens", "eraser", "ruler"]]);
  });

  it("add_separator_needs_two_items_in_the_row", () => {
    withLayout([["pens"]]);
    renderDialog();
    expect((screen.getByRole("button", { name: "Add separator" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a_mobile_only_item_is_kept_in_the_saved_layout_and_real_indices_are_used", () => {
    withLayout([["pens", "finger", "eraser", "ruler"]]);
    renderDialog();
    expect(labels("Row 1")).toEqual(["Pens", "Eraser", "Ruler"]);
    expect(labels("Hidden")).not.toContain("Finger mode");
    const eraser = within(list("Row 1")).getAllByRole("listitem")[1];
    expect(eraser.getAttribute("data-slot-row")).toBe("0");
    expect(eraser.getAttribute("data-slot-index")).toBe("2");
    click("Move Pens down");
    expect(saved().rows).toEqual([["finger", "eraser", "pens", "ruler"]]);
    click("Hide Ruler");
    expect(saved().rows.flat()).toContain("finger");
  });

  it("reset_asks_then_writes_null", () => {
    withLayout([["pens", "eraser"]]);
    renderDialog();
    click("Reset to default");
    expect(screen.getByText("Put the toolbar back to its default layout?")).toBeTruthy();
    expect(saved()).not.toBeNull();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(saved()).not.toBeNull();
    click("Reset to default");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Reset to default" }));
    expect(useSettingsStore.getState().settings.toolbarLayout).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("escape_during_the_reset_question_closes_only_the_question", () => {
    const onClose = vi.fn();
    render(<CustomizeToolbar onClose={onClose} />);
    click("Reset to default");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opened_from_more_and_from_settings", () => {
    renderBarWithDialog();
    fireEvent.click(screen.getByRole("button", { name: "More tools" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Customize toolbar…" }));
    expect(screen.getByRole("dialog", { name: "Customize toolbar" })).toBeTruthy();
    cleanup();
    useChromeStore.setState({ modalDepth: 0, toolbarCustomizeOpen: false });

    render(<ThemeSection />);
    fireEvent.click(screen.getByRole("button", { name: "Customize toolbar…" }));
    expect(useChromeStore.getState().toolbarCustomizeOpen).toBe(true);
  });

  it("escape_closes_and_returns_focus_to_more", () => {
    renderBarWithDialog();
    const more = screen.getByRole("button", { name: "More tools" });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Customize toolbar…" }));
    expect(screen.getByRole("dialog", { name: "Customize toolbar" })).toBeTruthy();
    expect(document.activeElement).not.toBe(more);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Customize toolbar" })).toBeNull();
    expect(useChromeStore.getState().toolbarCustomizeOpen).toBe(false);
    expect(document.activeElement).toBe(more);
  });

  it("every_control_has_an_accessible_name_and_a_title", () => {
    withLayout([["pens", "eraser", "sep", "ruler"], ["shape"]]);
    renderDialog();
    for (const b of screen.getAllByRole("button")) {
      expect(b.getAttribute("aria-label") ?? b.textContent).toBeTruthy();
    }
    for (const b of within(list("Row 1")).getAllByRole("button")) {
      expect(b.getAttribute("title")).toBe(b.getAttribute("aria-label"));
    }
  });
});
