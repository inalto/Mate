import { describe, expect, it } from "vitest";
import {
  ITEM_IDS,
  addSeparator,
  defaultRows,
  hideItem,
  moveSlot,
  removeSlot,
  repairLayout,
  resolveLayout,
  setTwoRows,
  showItem,
  toSaved,
  type Slot,
} from "../layout";

const all = [...ITEM_IDS];
const flat = (rows: string[][]) => rows.flat();

describe("resolveLayout", () => {
  it("null_resolves_to_the_platform_default", () => {
    const desktop = resolveLayout(null, false);
    expect(desktop.rows).toEqual(defaultRows(false));
    expect(flat(desktop.rows)).toContain("zoom");
    expect(flat(desktop.rows)).not.toContain("finger");
    const mobile = resolveLayout(null, true);
    expect(flat(mobile.rows)).toContain("finger");
    expect(flat(mobile.rows)).not.toContain("zoom");
    expect(mobile.hidden).toContain("zoom");
    for (const id of ["image", "media", "table", "code", "equation", "graph"]) {
      expect(desktop.hidden).toContain(id);
      expect(mobile.hidden).toContain(id);
    }
  });

  it("unknown_ids_and_duplicates_are_dropped", () => {
    const rows = repairLayout({ rows: [["pens", "nope", "eraser", "eraser"]], known: all }, false);
    expect(rows).toEqual([["pens", "eraser"]]);
  });

  it("an_item_new_since_the_layout_was_saved_is_appended_to_row_one", () => {
    const r = resolveLayout({ rows: [["pens", "eraser"]], known: ["pens", "eraser"] }, true);
    expect(r.rows).toEqual([["pens", "eraser", ...all.filter((i) => i !== "pens" && i !== "eraser")]]);
    expect(r.hidden).toEqual([]);
  });

  it("an_item_the_user_hid_stays_hidden", () => {
    const r = resolveLayout({ rows: [["pens", "eraser"]], known: all }, false);
    expect(r.hidden).toContain("shape");
    expect(r.hidden).not.toContain("finger");
  });

  it("a_missing_pens_block_is_put_back_first", () => {
    const rows = repairLayout({ rows: [["eraser", "lasso"]], known: all }, false);
    expect(rows).toEqual([["pens", "eraser", "lasso"]]);
  });

  it("three_rows_become_two", () => {
    const rows = repairLayout({ rows: [["pens"], ["eraser"], ["lasso"]], known: all }, false);
    expect(rows).toEqual([["pens"], ["eraser", "lasso"]]);
  });

  it("an_empty_second_row_is_dropped", () => {
    expect(repairLayout({ rows: [["pens"], []], known: all }, false)).toEqual([["pens"]]);
    expect(repairLayout({ rows: [["pens"], ["sep"]], known: all }, false)).toEqual([["pens"]]);
  });

  it("stray_separators_are_trimmed", () => {
    const rows = repairLayout({ rows: [["sep", "pens", "sep", "sep", "eraser", "sep"]], known: all }, false);
    expect(rows).toEqual([["pens", "sep", "eraser"]]);
  });

  it("finger_saved_on_mobile_is_not_drawn_on_desktop_and_survives_a_save", () => {
    const saved = { rows: [["pens", "finger", "eraser"]], known: all };
    const r = resolveLayout(saved, false);
    expect(flat(r.rows)).not.toContain("finger");
    expect(r.hidden).not.toContain("finger");
    const next = toSaved(hideItem(repairLayout(saved, false), "zoom"));
    expect(flat(next.rows)).toContain("finger");
    expect(next.known).toEqual(all);
  });

  it("empty_rows_array_falls_back_to_default", () => {
    expect(resolveLayout({ rows: [], known: all }, false)).toEqual(resolveLayout(null, false));
    expect(repairLayout({ rows: [], known: [] }, true)).toEqual(defaultRows(true));
  });
});

describe("edit operations", () => {
  const base: Slot[][] = [["pens", "eraser", "sep", "lasso"], ["shape"]];

  it("toSaved_stamps_the_catalogue_as_known", () => {
    const s = toSaved(base);
    expect(s.rows).toEqual(base);
    expect(s.known).toEqual(all);
    expect(s.known).not.toBe(ITEM_IDS);
  });

  it("moveSlot_reorders_within_a_row", () => {
    expect(moveSlot(base, { row: 0, index: 1 }, { row: 0, index: 2 })).toEqual([
      ["pens", "sep", "eraser", "lasso"],
      ["shape"],
    ]);
  });

  it("moveSlot_moves_across_rows_without_mutating", () => {
    const copy = JSON.parse(JSON.stringify(base));
    expect(moveSlot(base, { row: 0, index: 3 }, { row: 1, index: 0 })).toEqual([
      ["pens", "eraser", "sep"],
      ["lasso", "shape"],
    ]);
    expect(base).toEqual(copy);
  });

  it("moveSlot_clamps_out_of_range_indices", () => {
    expect(moveSlot(base, { row: 1, index: 0 }, { row: 0, index: 99 })).toEqual([
      ["pens", "eraser", "sep", "lasso", "shape"],
      [],
    ]);
  });

  it("hideItem_removes_the_item", () => {
    expect(hideItem(base, "eraser")).toEqual([["pens", "sep", "lasso"], ["shape"]]);
  });

  it("hideItem_leaves_pens_alone", () => {
    expect(hideItem(base, "pens")).toBe(base);
  });

  it("showItem_appends_to_the_given_row_and_defaults_to_the_first", () => {
    expect(showItem(base, "text")).toEqual([["pens", "eraser", "sep", "lasso", "text"], ["shape"]]);
    expect(showItem(base, "text", 1)).toEqual([["pens", "eraser", "sep", "lasso"], ["shape", "text"]]);
  });

  it("showItem_on_a_placed_item_is_a_no_op", () => {
    expect(showItem(base, "lasso")).toEqual(base);
  });

  it("addSeparator_appends_a_separator_to_the_row", () => {
    expect(addSeparator(base, 1)).toEqual([["pens", "eraser", "sep", "lasso"], ["shape", "sep"]]);
  });

  it("removeSlot_removes_separators_only", () => {
    expect(removeSlot(base, { row: 0, index: 2 })).toEqual([["pens", "eraser", "lasso"], ["shape"]]);
    expect(removeSlot(base, { row: 0, index: 1 })).toEqual(base);
  });

  it("setTwoRows_on_adds_an_empty_second_row", () => {
    expect(setTwoRows([["pens", "eraser"]], true)).toEqual([["pens", "eraser"], []]);
    expect(setTwoRows(base, true)).toEqual(base);
  });

  it("setTwoRows_off_appends_row_two_to_row_one", () => {
    expect(setTwoRows(base, false)).toEqual([["pens", "eraser", "sep", "lasso", "shape"]]);
  });
});
