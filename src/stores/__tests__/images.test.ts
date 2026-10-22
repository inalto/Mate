import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "../../model/types";

const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {}),
  pending: () => 0,
  failed: () => 0,
}));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { createEditorStore, type EditorStore } from "../editor";
import { useNotebookStore } from "../notebook";
import { useSettingsStore } from "../settings";

const page: Page = {
  id: "pg",
  sectionId: "s",
  title: "",
  isExpanded: true,
  isFavourite: false,
  depth: 0,
  mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex: 0,
  createdAt: "",
  updatedAt: "",
  version: 0,
};

let store: EditorStore;
const s = () => store.getState();

describe("images in the editor store", () => {
  beforeEach(async () => {
    store = createEditorStore();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [], sections: [], pages: [page] } });
    await s().loadPage("pg");
    store.setState({ camera: { x: 0, y: 0, z: 1 }, viewport: { width: 1000, height: 500 } });
  });

  it("addImage places a large image at the viewport centre, fitted, as one history entry", () => {
    const id = s().addImage("asset-1", { width: 4000, height: 1000 })!;
    const el = s().elements.get(id)!;
    expect(el.type).toBe("image");
    expect(el.imageUrl).toBe("asset-1");
    expect([el.width, el.height]).toEqual([800, 200]);
    expect(el.points[0]).toMatchObject({ x: 100, y: 150 });
    expect(s().selection).toEqual(new Set([id]));
    expect(s().canUndo).toBe(true);
    s().undo();
    expect(s().elements.size).toBe(0);
    expect(s().canUndo).toBe(false);
    s().redo();
    expect(s().elements.has(id)).toBe(true);
  });

  it("addImage centres on a drop point", () => {
    const id = s().addImage("asset-1", { width: 100, height: 50 }, { x: 300, y: 300 })!;
    expect(s().elements.get(id)!.points[0]).toMatchObject({ x: 250, y: 275 });
  });
});
