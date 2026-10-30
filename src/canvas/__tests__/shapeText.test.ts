import { afterEach, describe, expect, it, vi } from "vitest";
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

import { startShapeTyping } from "../../keys/editorCommands";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { shapeElement, shapeFromDrag } from "../../shapes/geometry";
import { shapeLabelOf } from "../../shapes/label";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { createToolController } from "../toolInteractions";

const STAMP = "2026-01-01T00:00:00.000Z";
const style = { shapeType: "rectangle" as const, color: "#000000", fillColor: "transparent", width: 2, fillOpacity: 1 };
const shape = (id: string, type: "rectangle" | "line" = "rectangle", content?: unknown): Element => {
  const el = shapeElement({ ...style, shapeType: type }, shapeFromDrag(type, { x: 0, y: 0 }, { x: 200, y: 100 }, false), "pg", id, STAMP);
  return content ? { ...el, content } : el;
};
const s = () => useEditorStore.getState();

async function ready(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  useEditorStore.setState({ viewport: { width: 1000, height: 800 }, camera: { x: 0, y: 0, z: 1 } });
  s().setTool("cursor");
}

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: k, cancelable: true, bubbles: true, ...init });

describe("shape text interactions", () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
    s().endEdit();
  });

  it("double_click_on_a_closed_shape_begins_editing", async () => {
    await ready([shape("a")]);
    let now = 0;
    const tools = createToolController({
      store: useEditorStore,
      el: document.createElement("div"),
      requestLive: () => {},
      invalidate: () => {},
      renderElement: () => {},
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      now: () => now,
    });
    dispose = tools.dispose;
    tools.down({ x: 100, y: 50 }, "cursor");
    tools.up();
    expect(s().editingId).toBeNull();
    now = 100;
    tools.down({ x: 101, y: 50 }, "cursor");
    tools.up();
    expect(s().editingId).toBe("a");
  });

  it("set_shape_label_is_one_history_entry_and_empty_text_removes_it", async () => {
    await ready([shape("a")]);
    expect(s().setShapeLabel("a", { text: "hi", fontSize: 16, color: "#000000", align: "center" })).toBe(true);
    expect(shapeLabelOf(s().elements.get("a")!)?.text).toBe("hi");
    s().undo();
    expect(shapeLabelOf(s().elements.get("a")!)).toBeNull();
    s().redo();
    s().setShapeLabel("a", { text: "", fontSize: 16, color: "#000000", align: "center" });
    expect(shapeLabelOf(s().elements.get("a")!)).toBeNull();
    s().setShapeLabel("a", { text: "hi", fontSize: 16, color: "#000000", align: "center" });
    s().setShapeLabel("a", { text: "   ", fontSize: 16, color: "#000000", align: "center" });
    expect(shapeLabelOf(s().elements.get("a")!)).toBeNull(); // whitespace-only removes it too
  });

  it("typing_a_printable_key_with_one_closed_shape_selected_starts_editing", async () => {
    await ready([shape("a"), shape("l", "line")]);
    s().select(["a"]);
    const e = key("x");
    expect(startShapeTyping(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(s().editingId).toBe("a");
  });

  it("typing_does_not_start_editing_for_ctrl_keys_lines_locked_shapes_or_many", async () => {
    await ready([shape("a"), shape("b"), shape("l", "line"), shape("k", "rectangle", { locked: true })]);
    s().select(["a"]);
    expect(startShapeTyping(key("c", { ctrlKey: true }))).toBe(false);
    expect(startShapeTyping(key("Enter"))).toBe(false);
    expect(startShapeTyping(key(" "))).toBe(false);
    s().select(["l"]);
    expect(startShapeTyping(key("x"))).toBe(false);
    s().select(["k"]);
    expect(startShapeTyping(key("x"))).toBe(false);
    s().select(["a", "b"]);
    expect(startShapeTyping(key("x"))).toBe(false);
    expect(s().editingId).toBeNull();
  });
});
