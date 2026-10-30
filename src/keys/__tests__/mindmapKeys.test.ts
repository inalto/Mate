import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {}),
  pending: () => 0,
  failed: () => 0,
}));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => [] as Element[]) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../windowBridge", () => ({ openPageInWindow: vi.fn() }));

import { endMindNodeEdit, useMindEdit } from "../../mindmap/editSession";
import { addChild, newNode, type MindNode } from "../../mindmap/tree";
import { mindmapOf } from "../../model/content";
import { useChromeStore } from "../../stores/chrome";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { runEditorShortcut } from "../editorCommands";

const s = () => useEditorStore.getState();
const root = (id: string): MindNode => mindmapOf(s().elements.get(id)!)!.root;

/** Dispatch a keydown on the body (the window capture listener sees it first); the event. */
function press(key: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts });
  document.body.dispatchEvent(e);
  return e;
}

/** A selected mind map with the root focused; the root has children `kids` (texts). */
async function mapWith(kids: string[] = []): Promise<string> {
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  s().setViewport({ width: 1000, height: 600 });
  const id = s().addMindmap({ x: 300, y: 300 })!;
  if (kids.length > 0) {
    s().editMindmap(id, (r) => kids.reduce((t, text) => addChild(t, r.id, { ...newNode(text), id: text }), r), "seed");
  }
  return id;
}

describe("mind-map keys", () => {
  beforeEach(() => {
    useChromeStore.setState({ modalDepth: 0, paletteOpen: false, shortcutsOpen: false });
  });
  afterEach(() => {
    endMindNodeEdit();
    vi.clearAllMocks();
  });

  it("tab_adds_a_child_and_focuses_it", async () => {
    const id = await mapWith();
    const e = press("Tab");
    expect(e.defaultPrevented).toBe(true);
    const kids = root(id).children;
    expect(kids).toHaveLength(1);
    expect(s().mindmapFocus).toEqual({ elementId: id, nodeId: kids[0].id });
    // The new node's editor opens.
    expect(useMindEdit.getState()).toMatchObject({ store: useEditorStore, elementId: id, nodeId: kids[0].id });
  });

  it("delete_on_the_root_is_refused", async () => {
    const id = await mapWith(["a"]);
    const e = press("Delete");
    // Taken (the global Delete must not remove the whole map) and nothing changes.
    expect(e.defaultPrevented).toBe(true);
    expect(s().elements.has(id)).toBe(true);
    expect(root(id).children.map((c) => c.id)).toEqual(["a"]);
    // A child is removed and the focus goes to its parent.
    s().focusMindNode(id, "a");
    press("Backspace");
    expect(root(id).children).toEqual([]);
    expect(s().mindmapFocus).toEqual({ elementId: id, nodeId: root(id).id });
  });

  it("enter_adds_a_sibling_after_and_shift_enter_before", async () => {
    const id = await mapWith(["a"]);
    s().focusMindNode(id, "a");
    press("Enter");
    const after = root(id).children;
    expect(after).toHaveLength(2);
    expect(after[0].id).toBe("a");
    expect(s().mindmapFocus?.nodeId).toBe(after[1].id);
    endMindNodeEdit();
    s().focusMindNode(id, "a");
    press("Enter", { shiftKey: true });
    const before = root(id).children;
    expect(before).toHaveLength(3);
    expect(before[1].id).toBe("a");
    expect(s().mindmapFocus?.nodeId).toBe(before[0].id);
  });

  it("arrows_move_the_focus_and_escape_clears_it", async () => {
    const id = await mapWith(["a", "b"]);
    const r = root(id).id;
    press("ArrowRight");
    const first = s().mindmapFocus?.nodeId;
    expect(["a", "b"]).toContain(first);
    press(first === "a" ? "ArrowDown" : "ArrowUp");
    expect(s().mindmapFocus?.nodeId).toBe(first === "a" ? "b" : "a");
    press("ArrowLeft");
    expect(s().mindmapFocus?.nodeId).toBe(r);
    const e = press("Escape");
    expect(e.defaultPrevented).toBe(true);
    expect(s().mindmapFocus).toBeNull();
    expect(s().selection.has(id)).toBe(true);
  });

  it("a_printable_key_starts_editing_with_that_key_and_f2_edits", async () => {
    const id = await mapWith();
    const r = root(id).id;
    press("x");
    expect(useMindEdit.getState()).toMatchObject({ elementId: id, nodeId: r, initial: "x" });
    endMindNodeEdit();
    press("F2");
    expect(useMindEdit.getState()).toMatchObject({ elementId: id, nodeId: r, initial: null });
    // While an editor is open the keys are left alone.
    expect(press("Tab").defaultPrevented).toBe(false);
  });

  it("keys_are_ignored_without_a_focused_selected_map", async () => {
    const id = await mapWith();
    s().select([]);
    expect(press("Tab").defaultPrevented).toBe(false);
    expect(root(id).children).toEqual([]);
  });

  it("tool_mindmap_adds_a_map_and_opens_the_root_editor", async () => {
    await mapWith();
    s().select([]);
    runEditorShortcut("tool.mindmap", {});
    const f = s().mindmapFocus!;
    expect(s().elements.get(f.elementId)?.type).toBe("mindmap");
    expect(useMindEdit.getState()).toMatchObject({ elementId: f.elementId, nodeId: f.nodeId });
  });
});
