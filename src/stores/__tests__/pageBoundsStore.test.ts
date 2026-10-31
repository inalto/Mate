import { describe, expect, it, vi } from "vitest";
import type { Page } from "../../model/types";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}) },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { elementBounds } from "../../tools/spatialIndex";
import { useEditorStore } from "../editor";
import { useNotebookStore } from "../notebook";
import { useSettingsStore } from "../settings";

const s = () => useEditorStore.getState();

const page = (mode: Page["mode"]): Page => ({
  id: "pg",
  sectionId: "s",
  title: "",
  isExpanded: true,
  isFavourite: false,
  depth: 0,
  mode,
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex: 0,
  createdAt: "",
  updatedAt: "",
  version: 0,
});

async function loadPage(mode: Page["mode"]) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, alignTextToLines: false } });
  useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [], sections: [], pages: [page(mode)] } });
  await s().loadPage("pg");
}

describe("elements stay on the sheet in page mode", () => {
  it("paste_off_the_right_edge_lands_at_the_edge_in_page_mode", async () => {
    await loadPage("page");
    const id = s().addTextBox({ x: 1000, y: 100 })!;
    s().endEdit();
    s().copySelection();
    s().paste();
    const pasted = [...s().selection].map((i) => s().elements.get(i)!);
    expect(pasted).toHaveLength(1);
    expect(pasted[0].id).not.toBe(id);
    const b = elementBounds(pasted[0]);
    expect(b.x + b.width).toBeLessThanOrEqual(1080);
  });

  it("move_cannot_push_a_box_past_the_sheet_edge", async () => {
    await loadPage("page");
    const id = s().addTextBox({ x: 700, y: 100 })!;
    s().endEdit();
    s().moveSelection(500, -500);
    const b = elementBounds(s().elements.get(id)!);
    expect(b.x + b.width).toBe(1080);
    expect(b.y).toBe(0);
  });

  it("canvas_mode_is_not_clamped", async () => {
    await loadPage("canvas");
    const id = s().addTextBox({ x: 1000, y: 100 })!;
    s().endEdit();
    s().moveSelection(500, -500);
    const b = elementBounds(s().elements.get(id)!);
    expect(b.x).toBe(1500);
    expect(b.y).toBe(-400);
  });
});
