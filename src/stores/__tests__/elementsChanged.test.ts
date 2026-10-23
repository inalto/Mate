import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";
import type { ElementsChange } from "../../tutor/types";

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

import { createEditorStore, type EditorStore } from "../editor";
import { useNotebookStore } from "../notebook";

let store: EditorStore;
const s = () => store.getState();

describe("onElementsChanged", () => {
  beforeEach(async () => {
    store = createEditorStore();
    loaded.els = [el("old", [[0, 0], [50, 0]])];
    useNotebookStore.setState({ loaded: true });
    await s().loadPage("pg");
  });

  it("emits_added_updated_removed_from_mutations", () => {
    const changes: ElementsChange[] = [];
    const off = store.onElementsChanged((c) => changes.push(c));
    s().addElement(el("s1", [[0, 100], [40, 100]]));
    s().updateElements([{ ...s().elements.get("s1")!, color: "#ff0000" }]);
    s().removeElements(["old"]);
    expect(changes).toEqual([
      { added: ["s1"], updated: [], removed: [] },
      { added: [], updated: ["s1"], removed: [] },
      { added: [], updated: [], removed: ["old"] },
    ]);
    s().undo();
    expect(changes[3]).toEqual({ added: ["old"], updated: [], removed: [] });
    off();
    s().addElement(el("s2", [[0, 200], [40, 200]]));
    expect(changes).toHaveLength(4);
  });
});
