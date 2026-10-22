import { describe, expect, it, vi } from "vitest";
import type { Element, Page } from "../../model/types";

const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {}),
  pending: () => 0,
  failed: () => 0,
}));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
const loadElements = vi.hoisted(() => vi.fn(async (): Promise<Element[]> => []));
vi.mock("../../ipc/elements", () => ({ loadElements }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));

import { hitTest } from "../../canvas/toolInteractions";
import { DEFAULT_SETTINGS, PAGE_WIDTH } from "../../model/constants";
import { isPdfPlacement, PDF_Z_INDEX } from "../../model/content";
import { createEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { eraseAt } from "../eraser";
import { lassoSelect } from "../lasso";
import { SpatialIndex } from "../spatialIndex";
import { renderOrder, reorder } from "../zorder";
import { el, mapOf } from "./fixtures";

const pdf = el("pdf", [[0, 0]], {
  type: "image",
  width: PAGE_WIDTH,
  height: 1400,
  penStyle: undefined,
  content: { pdfSourceKey: "asset-pdf", pdfPageIndex: 1, zIndex: PDF_Z_INDEX },
  createdAt: "2026-02-01T00:00:00.000Z",
});
const ink = el("ink", [[100, 100], [200, 120]], { content: { zIndex: -5 } });
const photo = el("photo", [[300, 300]], { type: "image", imageUrl: "asset-png", width: 100, height: 100, penStyle: undefined });

describe("PDF placements are locked", () => {
  it("is recognised by its pdfSourceKey", () => {
    expect(isPdfPlacement(pdf)).toBe(true);
    expect(isPdfPlacement(photo)).toBe(false);
  });

  it("is skipped by hit-test, lasso and eraser", () => {
    const all = mapOf([pdf, ink, photo]);
    const idx = SpatialIndex.from(all.values());
    expect(hitTest(idx, all, { x: 600, y: 900 }, 4)).toBeNull();
    expect(hitTest(idx, all, { x: 150, y: 110 }, 4)).toBe("ink");
    const square = [{ x: -10, y: -10 }, { x: 2000, y: -10 }, { x: 2000, y: 2000 }, { x: -10, y: 2000 }];
    expect(lassoSelect(all, idx, square).sort()).toEqual(["ink", "photo"]);
    const erased = eraseAt(all, idx, { x: 600, y: 900 }, 50, "stroke", { eraseShapes: true, eraseImages: true });
    expect(erased.removed).toEqual([]);
    expect(eraseAt(all, idx, { x: 350, y: 350 }, 10, "stroke", { eraseShapes: true, eraseImages: true }).removed).toEqual(["photo"]);
  });

  it("is drawn first and never reordered", () => {
    expect(renderOrder([ink, photo, pdf]).map((e) => e.id)).toEqual(["pdf", "ink", "photo"]);
    const back = reorder([pdf, ink, photo], new Set(["photo"]), "back");
    expect(back.map((e) => e.id)).toEqual(["photo"]);
    expect(renderOrder([pdf, ink, ...back]).map((e) => e.id)).toEqual(["pdf", "photo", "ink"]);
    expect(reorder([pdf, ink, photo], new Set(["ink"]), "forward").some((e) => e.id === "pdf")).toBe(false);
    expect(reorder([pdf, ink, photo], new Set(["pdf"]), "front")).toEqual([]);
  });

  it("is never selected by the store", async () => {
    const page: Page = {
      id: "pg", sectionId: "s", title: "", isExpanded: true, isFavourite: false, depth: 0, mode: "page",
      backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 }, thumbnailVersion: 0, orderIndex: 0,
      createdAt: "", updatedAt: "", version: 0,
    };
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [], sections: [], pages: [page] } });
    loadElements.mockResolvedValueOnce([{ ...pdf, pageId: "pg" }, { ...ink, pageId: "pg" }]);
    const store = createEditorStore();
    await store.getState().loadPage("pg");
    store.getState().selectAll();
    expect([...store.getState().selection]).toEqual(["ink"]);
    store.getState().select(["pdf", "ink"]);
    expect([...store.getState().selection]).toEqual(["ink"]);
    store.getState().beginEdit("pdf");
    expect(store.getState().editingId).toBeNull();
  });
});
