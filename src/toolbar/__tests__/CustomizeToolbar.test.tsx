import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

vi.mock("../../ipc/settings", () => ({
  getSettings: vi.fn(),
  patchSettings: vi.fn(async () => {}),
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: {
    enqueueUpsert: vi.fn(),
    enqueueDelete: vi.fn(),
    flushAll: vi.fn(async () => {}),
    pending: () => 0,
    failed: () => 0,
  },
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
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, toolbarLayout: toSaved(rows) },
  });
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
    expect(
      (
        screen.getByRole("button", {
          name: "Move Pens up",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Move Ruler down",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
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
    const box = screen.getByRole("checkbox", {
      name: "Use two rows",
    }) as HTMLInputElement;
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
    expect(
      (
        screen.getByRole("button", {
          name: "Add separator",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
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
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(saved()).not.toBeNull();
    click("Reset to default");
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Reset to default",
      }),
    );
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

  /** jsdom has no layout: stack the sections and their items, 40 px per item, 20 px per heading. */
  const stubLayout = () => {
    let y = 0;
    const at = (el: Element, top: number, bottom: number) => {
      el.getBoundingClientRect = () =>
        ({
          top,
          bottom,
          left: 0,
          right: 100,
          width: 100,
          height: bottom - top,
          x: 0,
          y: top,
        }) as DOMRect;
    };
    for (const section of document.querySelectorAll(".tbc-body > section")) {
      const start = y;
      y += 20;
      for (const li of section.querySelectorAll("li.tbc-item")) {
        at(li, y, y + 38);
        y += 40;
      }
      y += 20;
      at(section, start, y);
    }
    at(document.querySelector(".tbc-body")!, 0, 100000);
  };
  const itemOf = (name: string) =>
    [...document.querySelectorAll("li.tbc-item")].find((l) => l.querySelector(".tbc-label")?.textContent === name)!;
  const itemTop = (name: string) => itemOf(name).getBoundingClientRect().top;
  const handleOf = (name: string) => itemOf(name).querySelector(".tbc-handle")!;
  const dragTo = (name: string, y: number) => {
    const h = handleOf(name);
    fireEvent.pointerDown(h, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 10,
      clientY: itemTop(name) + 10,
    });
    fireEvent.pointerMove(h, {
      pointerId: 1,
      clientX: 10,
      clientY: itemTop(name) + 30,
    });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 10, clientY: y });
    return h;
  };
  const drop = (h: Element, y: number) => fireEvent.pointerUp(h, { pointerId: 1, clientY: y });

  it("dragging_an_item_to_the_hidden_list_hides_it", () => {
    withLayout([["pens", "eraser", "ruler"]]);
    renderDialog();
    stubLayout();
    const y = itemTop("Insert table") + 5;
    const h = dragTo("Ruler", y);
    expect(itemOf("Ruler").className).toContain("tbc-dragging");
    expect(document.querySelector(".tbc-drop-hover")).toBeTruthy();
    drop(h, y);
    expect(saved().rows).toEqual([["pens", "eraser"]]);
    expect(labels("Hidden")).toContain("Ruler");
  });

  it("dragging_pens_to_the_hidden_list_does_nothing", () => {
    withLayout([["pens", "eraser", "ruler"]]);
    renderDialog();
    stubLayout();
    const before = saved();
    const y = itemTop("Insert table") + 5;
    drop(dragTo("Pens", y), y);
    expect(saved()).toBe(before);
  });

  it("dragging_a_separator_to_the_hidden_list_removes_it", () => {
    withLayout([["pens", "sep", "eraser"]]);
    renderDialog();
    stubLayout();
    const y = itemTop("Insert table") + 5;
    drop(dragTo("Separator", y), y);
    expect(saved().rows).toEqual([["pens", "eraser"]]);
  });

  it("dragging_a_hidden_item_into_row_one_saves_it_at_the_drop_slot", () => {
    withLayout([["pens", "eraser", "ruler"]]);
    renderDialog();
    stubLayout();
    const y = itemTop("Eraser") + 5; // top half of Eraser: before it
    const h = dragTo("Insert table", y);
    expect(document.querySelector(".tbc-drop-line")).toBeTruthy();
    drop(h, y);
    expect(saved().rows).toEqual([["pens", "table", "eraser", "ruler"]]);
    expect(labels("Hidden")).not.toContain("Insert table");
  });

  it("dragging_down_within_a_row_lands_after_the_item_it_was_dropped_below", () => {
    withLayout([["pens", "eraser", "ruler", "shape"]]);
    renderDialog();
    stubLayout();
    const y = itemTop("Ruler") + 30; // bottom half of Ruler: after it
    drop(dragTo("Pens", y), y);
    expect(saved().rows).toEqual([["eraser", "ruler", "pens", "shape"]]);
  });

  it("dragging_up_within_a_row_lands_before_the_item", () => {
    withLayout([["pens", "eraser", "ruler", "shape"]]);
    renderDialog();
    stubLayout();
    const y = itemTop("Eraser") + 5;
    drop(dragTo("Shape", y), y);
    expect(saved().rows).toEqual([["pens", "shape", "eraser", "ruler"]]);
  });

  it("dropping_an_item_on_its_own_position_writes_nothing", () => {
    withLayout([["pens", "eraser", "ruler"]]);
    renderDialog();
    stubLayout();
    const before = saved();
    const y = itemTop("Eraser") + 30; // just after Eraser itself
    drop(dragTo("Eraser", y), y);
    expect(saved()).toBe(before);
  });

  it("with_a_hidden_finger_slot_a_drop_uses_real_indices_in_both_directions", () => {
    withLayout([["pens", "finger", "eraser", "ruler", "shape"]]);
    renderDialog();
    stubLayout();
    let y = itemTop("Ruler") + 30; // after Ruler, rendered position 3
    drop(dragTo("Pens", y), y);
    expect(saved().rows).toEqual([["finger", "eraser", "ruler", "pens", "shape"]]);
    cleanup();
    withLayout([["pens", "finger", "eraser", "ruler", "shape"]]);
    renderDialog();
    stubLayout();
    y = itemTop("Eraser") + 5; // before Eraser, which is real index 2
    drop(dragTo("Shape", y), y);
    expect(saved().rows).toEqual([["pens", "finger", "shape", "eraser", "ruler"]]);
  });

  it("an_empty_row_two_accepts_a_drop_and_creates_the_row", () => {
    withLayout([["pens", "eraser", "ruler"]]);
    renderDialog();
    fireEvent.click(screen.getByRole("checkbox", { name: "Use two rows" }));
    stubLayout();
    const second = screen.getByRole("list", { name: "Row 2" }).closest("section")!.getBoundingClientRect();
    const y = second.top + 10;
    drop(dragTo("Ruler", y), y);
    expect(saved().rows).toEqual([["pens", "eraser"], ["ruler"]]);
  });

  it("dragging_between_rows_moves_the_item_to_the_slot", () => {
    withLayout([
      ["pens", "eraser"],
      ["ruler", "shape"],
    ]);
    renderDialog();
    stubLayout();
    const y = itemTop("Shape") + 5;
    drop(dragTo("Eraser", y), y);
    expect(saved().rows).toEqual([["pens"], ["ruler", "eraser", "shape"]]);
  });

  it("escape_during_a_drag_cancels_the_drag_and_keeps_the_dialog", () => {
    const onClose = vi.fn();
    withLayout([["pens", "eraser", "ruler"]]);
    render(<CustomizeToolbar onClose={onClose} />);
    stubLayout();
    const before = saved();
    const y = itemTop("Insert table") + 5;
    const h = dragTo("Ruler", y);
    fireEvent.keyDown(h, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".tbc-dragging")).toBeNull();
    drop(h, y);
    expect(saved()).toBe(before);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a_drag_that_does_not_start_on_a_handle_does_nothing", () => {
    withLayout([["pens", "eraser", "ruler"]]);
    renderDialog();
    stubLayout();
    const li = itemOf("Ruler");
    fireEvent.pointerDown(li, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(li, { pointerId: 1, clientX: 10, clientY: 300 });
    expect(document.querySelector(".tbc-dragging")).toBeNull();
  });

  it("focus_follows_the_item_after_moves_hide_and_show", () => {
    withLayout([["pens", "eraser"], ["ruler"]]);
    renderDialog();
    const focused = () => document.activeElement?.getAttribute("aria-label");
    click("Move Eraser down"); // crosses into row 2, where the same action is still enabled
    expect(focused()).toBe("Move Eraser down");
    click("Move Eraser down"); // now last in row 2: the pressed button is disabled
    expect(focused()).toBe("Move Eraser up");
    click("Hide Eraser"); // the pressed button is gone; the item is in Hidden now
    expect(focused()).toBe("Show Eraser");
    click("Show Eraser");
    expect(focused()).toBe("Move Eraser up");
    click("Move Eraser to the other row");
    expect(focused()).toBe("Move Eraser to the other row");
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
