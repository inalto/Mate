import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {}),
  pending: () => 0,
  failed: () => 0,
}));
const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => loaded.els) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { TABLE_LIMIT_TOAST } from "../../stores/pageLimit";
import { addColumn, addRow, canAddColumn, canAddRow, deleteRow, MAX_TABLE_CELLS, tableElement, tableRowsOf } from "../../text/tableCode";
import { isTypingTarget } from "../../keys/shortcuts";
import { hasEditor, registerEditor } from "../editorRegistry";
import OverlayLayer from "../OverlayLayer";
import TableEditor from "../TableEditor";

registerEditor("table", TableEditor);

let store: EditorStore;
const s = () => store.getState();
const rowsOf = (id: string) => tableRowsOf(s().elements.get(id)!);

async function load(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
}
const cell = (c: HTMLElement, r: number, k: number) => c.querySelector(`[data-r="${r}"][data-c="${k}"]`) as HTMLElement;
const typeIn = (el: HTMLElement, text: string) => {
  el.textContent = text;
  fireEvent.input(el);
};

describe("TableEditor", () => {
  beforeEach(async () => {
    store = createEditorStore();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    await load([]);
  });
  afterEach(cleanup);

  it("is_registered_for_tables", () => expect(hasEditor("table")).toBe(true));

  it("insert_places_table_at_viewport_centre_as_one_entry", () => {
    act(() => store.setState({ viewport: { width: 1000, height: 600 }, camera: { x: 0, y: 0, z: 1 } }));
    const { container } = render(<OverlayLayer store={store} />);
    let id = "";
    act(() => {
      id = s().addTable()!;
    });
    const t = s().elements.get(id)!;
    expect([t.points[0].x, t.points[0].y, t.boxWidth, t.boxHeight]).toEqual([300, 200, 400, 200]);
    expect(s().editingId).toBe(id);
    expect(isTypingTarget(cell(container, 0, 0))).toBe(true);
    act(() => s().undo());
    expect(s().elements.has(id)).toBe(false);
    expect(s().canUndo).toBe(false);
  });

  it("tab_moves_to_next_cell", () => {
    const { container } = render(<OverlayLayer store={store} />);
    act(() => void s().addTable());
    expect(document.activeElement).toBe(cell(container, 0, 0));
    fireEvent.keyDown(cell(container, 0, 0), { key: "Tab" });
    expect(document.activeElement).toBe(cell(container, 0, 1));
    fireEvent.keyDown(cell(container, 0, 1), { key: "Tab" });
    fireEvent.keyDown(cell(container, 0, 2), { key: "Tab" });
    expect(document.activeElement).toBe(cell(container, 1, 0)); // wraps to the next row
    fireEvent.keyDown(cell(container, 1, 0), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cell(container, 0, 2));
    fireEvent.keyDown(cell(container, 0, 2), { key: "Enter" });
    expect(document.activeElement).toBe(cell(container, 1, 2));
    // Shift+Tab from the first cell wraps to the last; Tab from the last wraps to the first.
    fireEvent.keyDown(cell(container, 1, 2), { key: "Escape" });
    act(() => void s().beginEdit(s().selection.values().next().value!));
    fireEvent.keyDown(cell(container, 0, 0), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cell(container, 2, 2));
    fireEvent.keyDown(cell(container, 2, 2), { key: "Tab" });
    expect(document.activeElement).toBe(cell(container, 0, 0));
  });

  it("escape_persists_edits_as_one_history_entry", () => {
    const { container, getByLabelText } = render(<OverlayLayer store={store} />);
    let id = "";
    act(() => {
      id = s().addTable()!;
    });
    act(() => typeIn(cell(container, 0, 0), "a<b"));
    act(() => typeIn(cell(container, 1, 1), "mid"));
    act(() => void fireEvent.click(getByLabelText("Add column")));
    act(() => typeIn(cell(container, 2, 3), "new"));
    expect(rowsOf(id)[0][0]).toBe(""); // nothing is written while editing
    act(() => void fireEvent.keyDown(cell(container, 2, 3), { key: "Escape" }));
    expect(s().editingId).toBeNull();
    expect(rowsOf(id)).toEqual([["a<b", "", "", ""], ["", "", "mid", ""], ["", "", "", "new"]]);
    act(() => s().undo()); // the whole edit session
    expect(rowsOf(id)[0]).toEqual(["", "", ""]);
    expect(s().elements.has(id)).toBe(true);
  });

  it("unchanged_session_records_nothing", () => {
    render(<OverlayLayer store={store} />);
    let id = "";
    act(() => {
      id = s().addTable()!;
    });
    act(() => s().endEdit());
    act(() => s().undo()); // undoes the insertion itself
    expect(s().elements.has(id)).toBe(false);
  });

  it("toolbar_adds_and_deletes_rows_and_columns", () => {
    const { container, getByLabelText } = render(<OverlayLayer store={store} />);
    let id = "";
    act(() => {
      id = s().addTable()!;
    });
    act(() => void fireEvent.click(getByLabelText("Add row")));
    act(() => void fireEvent.click(getByLabelText("Delete column")));
    expect(container.querySelectorAll("tr")).toHaveLength(4);
    expect(container.querySelectorAll("tr:first-child td")).toHaveLength(2);
    act(() => s().endEdit());
    expect(rowsOf(id)).toHaveLength(4);
    expect(rowsOf(id)[0]).toHaveLength(2);
  });

  it("cell_limit_enforced", () => {
    const wide = MAX_TABLE_CELLS / 250;
    const rows = Array.from({ length: 250 }, () => Array.from({ length: wide }, () => ""));
    expect(canAddRow(rows)).toBe(false);
    expect(canAddColumn(rows)).toBe(false);
    expect(addRow(rows, 0)).toBeNull();
    expect(addColumn(rows, 0)).toBeNull();
    expect(deleteRow(rows, 0)).not.toBeNull();
    expect(canAddRow(rows.slice(1))).toBe(true);
  });

  it("over_limit_table_update_is_clamped_and_flagged", () => {
    const t = tableElement("pg", "big", "2026-01-01T00:00:00.000Z", { x: 0, y: 0 }, "#000000");
    act(() => store.setState({ elements: new Map([["big", t]]) }));
    const wide = MAX_TABLE_CELLS / 250;
    const rows = Array.from({ length: 251 }, (_, r) => Array.from({ length: wide }, () => String(r)));
    const over = { ...t, content: { subtype: "table", tableData: { rows } } } as Element;
    act(() => s().updateElements([over]));
    const got = rowsOf("big");
    expect(got).toHaveLength(250);
    expect(got[0]).toHaveLength(wide);
    expect(got[249][0]).toBe("249");
    expect(s().limitReached).toBe(true);
    expect(s().limitKind).toBe("table");
    expect(TABLE_LIMIT_TOAST).toBe("Table is at its size limit (50 000 cells)");
  });
});
