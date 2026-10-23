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
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { createToolController } from "../../canvas/toolInteractions";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { createEditorStore, type EditorStore } from "../editor";
import { useNotebookStore } from "../notebook";

const box = el("box", [[100, 100]], { type: "text-box", boxWidth: 200, boxHeight: 80, width: 1 });
const ink = el("ink", [[0, 400], [300, 400]]);

let store: EditorStore;
const s = () => store.getState();

async function load(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
}

describe("box editing state", () => {
  beforeEach(() => {
    store = createEditorStore();
  });

  it("begin_and_end_edit", async () => {
    await load([box, ink]);
    expect(s().editingId).toBeNull();
    s().beginEdit("ink"); // strokes have no editor
    expect(s().editingId).toBeNull();
    s().beginEdit("missing");
    expect(s().editingId).toBeNull();
    s().beginEdit("box");
    expect(s().editingId).toBe("box");
    expect([...s().selection]).toEqual(["box"]);
    s().endEdit();
    expect(s().editingId).toBeNull();
  });

  it("edit_ends_when_selection_moves_away_or_element_goes", async () => {
    await load([box, ink]);
    s().beginEdit("box");
    s().select(["box"]);
    expect(s().editingId).toBe("box");
    s().select(["ink"]);
    expect(s().editingId).toBeNull();
    s().beginEdit("box");
    s().removeElements(["box"]);
    expect(s().editingId).toBeNull();
    s().undo();
    s().beginEdit("box");
    await s().loadPage("pg");
    expect(s().editingId).toBeNull();
  });

  it("cursor_click_selects_box_and_double_click_edits", async () => {
    await load([box, ink]);
    store.setState({ tool: "cursor", camera: { x: 0, y: 0, z: 1 } });
    let t = 1000;
    const tools = createToolController({
      store,
      el: document.createElement("div"),
      requestLive: () => {},
      invalidate: () => {},
      renderElement: () => {},
      getSettings: () => DEFAULT_SETTINGS,
      now: () => t,
    });
    tools.down({ x: 150, y: 120 }, "cursor");
    tools.up();
    expect([...s().selection]).toEqual(["box"]);
    expect(s().editingId).toBeNull();
    t += 200;
    tools.down({ x: 152, y: 121 }, "cursor");
    tools.up();
    expect(s().editingId).toBe("box");
    // Too slow: a second click much later is just a click.
    s().endEdit();
    t += 2000;
    tools.down({ x: 150, y: 120 }, "cursor");
    tools.up();
    t += 1000;
    tools.down({ x: 150, y: 120 }, "cursor");
    tools.up();
    expect(s().editingId).toBeNull();
    // Double-clicking a stroke does not start editing.
    t += 2000;
    tools.down({ x: 100, y: 400 }, "cursor");
    tools.up();
    t += 100;
    tools.down({ x: 100, y: 400 }, "cursor");
    tools.up();
    expect(s().editingId).toBeNull();
    tools.dispose();
  });
});
