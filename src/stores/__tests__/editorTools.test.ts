import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";

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
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));

import { useEditorStore } from "../editor";
import { useNotebookStore } from "../notebook";
import { useSettingsStore } from "../settings";

const a = el("a", [[0, 0], [100, 0], [200, 0]]);
const b = el("b", [[0, 300], [200, 300]]);

async function load(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await useEditorStore.getState().loadPage("pg");
  queue.enqueueUpsert.mockClear();
  queue.enqueueDelete.mockClear();
}

describe("editor store tools", () => {
  beforeEach(() => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, defaultEraserType: "partial", defaultEraserWidth: 20 },
    }));
    useEditorStore.setState({ camera: { x: 0, y: 0, z: 1 } });
  });

  it("erase_drag_is_one_entry_and_undo_restores_persistence", async () => {
    await load([a, b]);
    const s = () => useEditorStore.getState();
    s().eraser({ x: 100, y: 0 }); // splits a into two parts
    expect(s().elements.has("a")).toBe(false);
    expect(s().elements.size).toBe(3);
    s().eraser({ x: 10, y: 0 }); // cuts into the first part
    s().endEraser();
    expect(queue.enqueueDelete).toHaveBeenCalledWith("a");
    expect(s().canUndo).toBe(true);

    s().undo();
    expect([...s().elements.keys()].sort()).toEqual(["a", "b"]);
    expect(s().elements.get("a")).toEqual(a);
    expect(queue.enqueueUpsert).toHaveBeenLastCalledWith(a);
    expect(s().canUndo).toBe(false);
    expect(s().canRedo).toBe(true);

    s().redo();
    expect(s().elements.has("a")).toBe(false);
    expect(s().elements.size).toBe(3);
  });

  it("move_scale_and_delete_selection_undo", async () => {
    await load([a, b]);
    const s = () => useEditorStore.getState();
    s().select(["b"]);
    s().moveSelection(10, 5);
    expect(s().elements.get("b")!.points[0]).toMatchObject({ x: 10, y: 305 });
    s().scaleSelection({ x: 10, y: 305 }, 2, 2);
    expect(s().elements.get("b")!.points[1]).toMatchObject({ x: 410, y: 305 });
    s().deleteSelection();
    expect(s().elements.has("b")).toBe(false);
    s().undo();
    s().undo();
    s().undo();
    expect(s().elements.get("b")!.points).toEqual(b.points);
    expect(queue.enqueueUpsert.mock.lastCall![0].points).toEqual(b.points);
  });

  it("duplicate_offsets_and_arrange_sets_zindex", async () => {
    await load([a, b]);
    const s = () => useEditorStore.getState();
    s().select(["a"]);
    s().duplicateSelection();
    const [copyId] = [...s().selection];
    expect(copyId).not.toBe("a");
    expect(s().elements.get(copyId)!.points[0]).toMatchObject({ x: 20, y: 20 });
    s().select(["a"]);
    s().toFront();
    expect((s().elements.get("a")!.content as { zIndex: number }).zIndex).toBe(1);
    s().undo();
    expect(s().elements.get("a")!.content).toBeUndefined();
  });
});
