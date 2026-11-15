// Reveal state of recall covers: per page, only in the store, never an element change (no history,
// no save, no version bump).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => loaded.els) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { createEditorStore, type EditorStore } from "../editor";
import { useNotebookStore } from "../notebook";

const cover = (id: string, y: number) => el(id, [[0, y], [100, y]], { width: 28, penStyle: "cover", color: "#334155" });
const box = el("box", [[0, 300], [120, 360]], {
  type: "shape", shapeType: "rectangle", penStyle: undefined, boxWidth: 120, boxHeight: 60, fillColor: "#334155", content: { fillOpacity: 1, cover: true },
});
const ink = el("ink", [[0, 500], [100, 500]]);

let store: EditorStore;
const s = () => store.getState();

async function load(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
}

beforeEach(() => {
  store = createEditorStore();
  queue.enqueueUpsert.mockClear();
  queue.enqueueDelete.mockClear();
});

describe("reveal state", () => {
  it("toggleReveal flips membership and changes nothing that is saved or undone", async () => {
    await load([cover("a", 0), cover("b", 100), ink]);
    const before = s().elements.get("a")!;
    s().toggleReveal("a");
    expect([...s().revealed]).toEqual(["a"]);
    expect(s().canUndo).toBe(false);
    expect(s().elements.get("a")).toBe(before);
    expect(s().elements.get("a")).toMatchObject({ updatedAt: before.updatedAt, version: before.version });
    expect(queue.enqueueUpsert).not.toHaveBeenCalled();
    expect(queue.enqueueDelete).not.toHaveBeenCalled();
    s().toggleReveal("a");
    expect(s().revealed.size).toBe(0);
    expect(s().canUndo).toBe(false);
  });

  it("toggleReveal ignores ids that are not live covers", async () => {
    await load([cover("a", 0), ink, { ...cover("gone", 200), deletedAt: "2026-01-02T00:00:00.000Z" }]);
    s().toggleReveal("ink");
    s().toggleReveal("nope");
    s().toggleReveal("gone");
    expect(s().revealed.size).toBe(0);
  });

  it("revealAll and coverAll take every live cover, stroke or box", async () => {
    await load([cover("a", 0), box, ink]);
    s().revealAll();
    expect(new Set(s().revealed)).toEqual(new Set(["a", "box"]));
    s().coverAll();
    expect(s().revealed.size).toBe(0);
    expect(s().canUndo).toBe(false);
  });

  it("opening the same page again starts with every cover covered", async () => {
    await load([cover("a", 0)]);
    s().toggleReveal("a");
    await s().loadPage("pg");
    expect(s().revealed.size).toBe(0);
  });

  it("deleting a revealed cover drops it; undoing the delete brings it back covered", async () => {
    await load([cover("a", 0), cover("b", 100)]);
    s().toggleReveal("a");
    s().toggleReveal("b");
    s().select(["a"]);
    s().deleteSelection();
    expect([...s().revealed]).toEqual(["b"]);
    s().undo();
    expect(s().elements.has("a")).toBe(true);
    expect([...s().revealed]).toEqual(["b"]);
  });

  it("reveal three covers, then undo: the stroke added before them is undone", async () => {
    await load([cover("a", 0), cover("b", 100), cover("c", 200)]);
    s().addElement(ink);
    s().toggleReveal("a");
    s().toggleReveal("b");
    s().toggleReveal("c");
    s().undo();
    expect(s().elements.has("ink")).toBe(false);
    expect(s().canUndo).toBe(false);
    expect(s().revealed.size).toBe(3);
  });
});
