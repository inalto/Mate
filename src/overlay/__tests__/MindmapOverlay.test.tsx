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
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => [] as Element[]) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { mindmapView } from "../../mindmap/cache";
import { beginMindNodeEdit, endMindNodeEdit, useMindEdit } from "../../mindmap/editSession";
import { addChild, findNode, newNode, parentOf, type MindNode } from "../../mindmap/tree";
import { mindmapOf } from "../../model/content";
import { createEditorStore, useEditorStore, type EditorStore } from "../../stores/editor";
import "../../keys/editorCommands"; // the window mind-map keys, as in the app
import { useNotebookStore } from "../../stores/notebook";
import MindmapOverlay from "../MindmapOverlay";
import MindNodeEditor from "../MindNodeEditor";

let store: EditorStore;
const s = () => store.getState();
const root = (id: string): MindNode => mindmapOf(s().elements.get(id)!)!.root;

/** A selected mind map: root → a, b (ids "a", "b"); the root is focused. */
async function load(): Promise<string> {
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  store.setState({ viewport: { width: 1000, height: 800 }, camera: { x: 0, y: 0, z: 1 } });
  const id = s().addMindmap({ x: 300, y: 300 })!;
  s().editMindmap(id, (r) => addChild(addChild(r, r.id, { ...newNode("A"), id: "a" }), r.id, { ...newNode("B"), id: "b" }), "seed");
  return id;
}

const centreOf = (id: string, nodeId: string) => {
  const b = mindmapView(s().elements.get(id)!).layout.nodes.get(nodeId)!;
  return { clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 };
};

/** The overlay in a pane next to a stand-in canvas (the pointer target), as in the editor. */
function mount(id: string) {
  const utils = render(
    <div className="pane">
      <div className="canvas-view" data-testid="canvas" />
      <div className="overlay-clip">
        <div className="overlay-layer">
          <MindmapOverlay el={s().elements.get(id)!} store={store} />
        </div>
      </div>
    </div>,
  );
  const canvas = utils.getByTestId("canvas");
  const reached = vi.fn();
  canvas.addEventListener("pointerdown", reached);
  return { ...utils, canvas, reached };
}

describe("MindmapOverlay", () => {
  beforeEach(() => {
    store = createEditorStore();
  });
  afterEach(() => {
    endMindNodeEdit();
    cleanup();
  });

  it("drag_drop_re_parents", async () => {
    const id = await load();
    const { canvas, reached, container } = mount(id);
    const from = centreOf(id, "b");
    const to = centreOf(id, "a");
    act(() => void fireEvent.pointerDown(canvas, { ...from, pointerId: 1, button: 0, isPrimary: true }));
    // A non-root node takes the press (the canvas does not move the map) and gets the focus.
    expect(reached).not.toHaveBeenCalled();
    expect(s().mindmapFocus).toEqual({ elementId: id, nodeId: "b" });
    act(() => void fireEvent.pointerMove(canvas, { ...to, pointerId: 1, isPrimary: true }));
    expect(container.querySelector('[data-mindmap-drop="a"]')).not.toBeNull();
    act(() => void fireEvent.pointerUp(canvas, { ...to, pointerId: 1, isPrimary: true }));
    const r = root(id);
    expect(r.children.map((c) => c.id)).toEqual(["a"]);
    expect(parentOf(r, "b")?.id).toBe("a");
    expect(container.querySelector("[data-mindmap-drop]")).toBeNull();
  });

  it("escape_cancels_a_node_drag_before_the_mind_map_keys_see_it", async () => {
    store = useEditorStore; // the focused pane's store, which the window mind-map keys act on
    const id = await load();
    const { canvas, container } = mount(id);
    const to = centreOf(id, "a");
    act(() => void fireEvent.pointerDown(canvas, { ...centreOf(id, "b"), pointerId: 1, button: 0, isPrimary: true }));
    act(() => void fireEvent.pointerMove(canvas, { ...to, pointerId: 1, isPrimary: true }));
    expect(container.querySelector('[data-mindmap-drop="a"]')).not.toBeNull();
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void document.body.dispatchEvent(esc));
    expect(esc.defaultPrevented).toBe(true);
    expect(container.querySelector("[data-mindmap-drop]")).toBeNull();
    // The drag is dropped, the focus stays on the pressed node.
    expect(s().mindmapFocus).toEqual({ elementId: id, nodeId: "b" });
    expect(s().dragging).toBe(false);
    act(() => void fireEvent.pointerUp(canvas, { ...to, pointerId: 1, isPrimary: true }));
    expect(parentOf(root(id), "b")?.id).toBe(root(id).id);
    // With the drag over, Escape is the mind-map key again (it clears the focus).
    act(() => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(s().mindmapFocus).toBeNull();
  });

  it("a_drop_inside_the_dragged_subtree_shows_no_indicator_and_changes_nothing", async () => {
    const id = await load();
    s().editMindmap(id, (r) => addChild(r, "a", { ...newNode("C"), id: "c" }), "seed");
    const { canvas, container } = mount(id);
    act(() => void fireEvent.pointerDown(canvas, { ...centreOf(id, "a"), pointerId: 1, button: 0, isPrimary: true }));
    act(() => void fireEvent.pointerMove(canvas, { ...centreOf(id, "c"), pointerId: 1, isPrimary: true }));
    expect(container.querySelector("[data-mindmap-drop]")).toBeNull();
    const before = root(id);
    act(() => void fireEvent.pointerUp(canvas, { ...centreOf(id, "c"), pointerId: 1, isPrimary: true }));
    expect(root(id)).toBe(before);
  });

  it("a_press_on_the_root_is_left_to_the_canvas", async () => {
    const id = await load();
    const r = root(id).id;
    s().focusMindNode(id, "a");
    const { canvas, reached } = mount(id);
    act(() => void fireEvent.pointerDown(canvas, { ...centreOf(id, r), pointerId: 1, button: 0, isPrimary: true }));
    expect(reached).toHaveBeenCalledTimes(1);
    expect(s().mindmapFocus).toEqual({ elementId: id, nodeId: r });
  });

  it("plus_buttons_add_a_child_and_a_sibling", async () => {
    const id = await load();
    s().focusMindNode(id, "a");
    const { container } = mount(id);
    fireEvent.click(container.querySelector('[data-mindmap-add="child"]')!);
    expect(findNode(root(id), "a")!.children).toHaveLength(1);
    endMindNodeEdit();
    act(() => s().focusMindNode(id, "a"));
    fireEvent.click(container.querySelector('[data-mindmap-add="sibling"]')!);
    expect(root(id).children.map((c) => c.id).slice(0, 1)).toEqual(["a"]);
    expect(root(id).children).toHaveLength(3);
  });

  it("buttons_have_8px_of_slop_and_stay_off_the_node_box", async () => {
    const id = await load();
    s().focusMindNode(id, "a");
    const { container } = mount(id);
    const nodes = mindmapView(s().elements.get(id)!).layout.nodes;
    const rect = (node: globalThis.Element | null) => {
      const st = (node as HTMLElement).style;
      return { x: parseFloat(st.left), y: parseFloat(st.top), w: parseFloat(st.width), h: parseFloat(st.height) };
    };
    const overlaps = (a: ReturnType<typeof rect>, b: { x: number; y: number; width: number; height: number }) =>
      a.x < b.x + b.width && b.x < a.x + a.w && a.y < b.y + b.height && b.y < a.y + a.h;
    const buttons = [...container.querySelectorAll("button[data-mindmap-ui]")];
    expect(buttons.length).toBeGreaterThanOrEqual(3); // root toggle, "+" child, "+" sibling
    for (const b of buttons) {
      const r = rect(b);
      const dot = rect(b.querySelector("span"));
      expect(r.w).toBeGreaterThanOrEqual(dot.w + 16);
      expect(r.h).toBeGreaterThanOrEqual(dot.h + 16);
      // A toggle stays off its own node, a "+" off the focused node.
      const owner = nodes.get(b.getAttribute("data-mindmap-toggle") ?? "a")!;
      expect(overlaps(r, owner)).toBe(false);
    }
  });

  it("the_collapse_toggle_hides_the_children", async () => {
    const id = await load();
    const r = root(id).id;
    const { container } = mount(id);
    fireEvent.click(container.querySelector(`[data-mindmap-toggle="${r}"]`)!);
    expect(root(id).collapsed).toBe(true);
  });
});

describe("MindNodeEditor", () => {
  beforeEach(() => {
    store = createEditorStore();
  });
  afterEach(() => {
    endMindNodeEdit();
    cleanup();
  });

  const editor = (id: string) => render(<MindNodeEditor el={s().elements.get(id)!} store={store} />);

  it("escape restores text", async () => {
    const id = await load();
    expect(beginMindNodeEdit(store, id, "a")).toBe(true);
    const { container, rerender } = editor(id);
    const area = container.querySelector("textarea")!;
    expect(area.value).toBe("A");
    fireEvent.change(area, { target: { value: "Apples" } });
    expect(findNode(root(id), "a")!.text).toBe("Apples");
    rerender(<MindNodeEditor el={s().elements.get(id)!} store={store} />);
    fireEvent.keyDown(area, { key: "Escape" });
    expect(findNode(root(id), "a")!.text).toBe("A");
    expect(useMindEdit.getState().store).toBeNull();
  });

  it("enter_commits_and_typing_is_one_history_entry", async () => {
    const id = await load();
    beginMindNodeEdit(store, id, "a");
    const { container } = editor(id);
    const area = container.querySelector("textarea")!;
    fireEvent.change(area, { target: { value: "Ap" } });
    fireEvent.change(area, { target: { value: "Apple" } });
    fireEvent.keyDown(area, { key: "Enter", shiftKey: true });
    expect(useMindEdit.getState().store).toBe(store);
    fireEvent.keyDown(area, { key: "Enter" });
    expect(useMindEdit.getState().store).toBeNull();
    expect(findNode(root(id), "a")!.text).toBe("Apple");
    s().undo();
    expect(findNode(root(id), "a")!.text).toBe("A");
  });

  it("escape_after_typing_leaves_no_undo_step", async () => {
    const id = await load();
    beginMindNodeEdit(store, id, "a");
    const { container } = editor(id);
    const area = container.querySelector("textarea")!;
    fireEvent.change(area, { target: { value: "Apples" } });
    fireEvent.keyDown(area, { key: "Escape" });
    expect(findNode(root(id), "a")!.text).toBe("A");
    expect(s().canRedo).toBe(false);
    // The next undo is the seeding edit, not an empty step.
    s().undo();
    expect(findNode(root(id), "a")).toBeNull();
  });

  it("escape_with_a_starting_key_restores_the_text_and_leaves_no_step", async () => {
    const id = await load();
    beginMindNodeEdit(store, id, "a", "z");
    const { container } = editor(id);
    expect(findNode(root(id), "a")!.text).toBe("z");
    fireEvent.keyDown(container.querySelector("textarea")!, { key: "Escape" });
    expect(findNode(root(id), "a")!.text).toBe("A");
    s().undo();
    expect(findNode(root(id), "a")).toBeNull();
  });

  it("two_editing_sessions_on_one_node_are_two_undo_steps", async () => {
    const id = await load();
    beginMindNodeEdit(store, id, "a");
    let r = editor(id);
    fireEvent.change(r.container.querySelector("textarea")!, { target: { value: "Apple" } });
    fireEvent.keyDown(r.container.querySelector("textarea")!, { key: "Enter" });
    r.unmount();
    beginMindNodeEdit(store, id, "a");
    r = editor(id);
    fireEvent.change(r.container.querySelector("textarea")!, { target: { value: "Apples" } });
    fireEvent.keyDown(r.container.querySelector("textarea")!, { key: "Enter" });
    expect(findNode(root(id), "a")!.text).toBe("Apples");
    s().undo();
    expect(findNode(root(id), "a")!.text).toBe("Apple");
    s().undo();
    expect(findNode(root(id), "a")!.text).toBe("A");
  });

  it("tab_commits_and_adds_a_child_without_moving_the_browser_focus", async () => {
    const id = await load();
    beginMindNodeEdit(store, id, "a");
    const { container } = editor(id);
    const area = container.querySelector("textarea")!;
    fireEvent.change(area, { target: { value: "Apple" } });
    const notPrevented = fireEvent.keyDown(area, { key: "Tab" });
    expect(notPrevented).toBe(false);
    const a = findNode(root(id), "a")!;
    expect(a.text).toBe("Apple");
    expect(a.children).toHaveLength(1);
    const child = a.children[0].id;
    expect(useMindEdit.getState()).toMatchObject({ store, elementId: id, nodeId: child });
    expect(s().mindmapFocus).toEqual({ elementId: id, nodeId: child });
  });

  it("shift_tab_commits_and_focuses_the_parent", async () => {
    const id = await load();
    beginMindNodeEdit(store, id, "a");
    const { container } = editor(id);
    const area = container.querySelector("textarea")!;
    fireEvent.change(area, { target: { value: "Apple" } });
    expect(fireEvent.keyDown(area, { key: "Tab", shiftKey: true })).toBe(false);
    expect(findNode(root(id), "a")!.text).toBe("Apple");
    expect(useMindEdit.getState().store).toBeNull();
    expect(s().mindmapFocus).toEqual({ elementId: id, nodeId: root(id).id });
  });

  it("a_starting_key_replaces_the_text", async () => {
    const id = await load();
    beginMindNodeEdit(store, id, "a", "z");
    editor(id);
    expect(findNode(root(id), "a")!.text).toBe("z");
  });
});

describe("mind-map lasso and eraser", () => {
  beforeEach(() => {
    store = createEditorStore();
  });

  /** Empty space of the map: right of the root, between the root box and its children's column. */
  const gap = (id: string) => {
    const nodes = mindmapView(s().elements.get(id)!).layout.nodes;
    const r = nodes.get(root(id).id)!;
    const a = nodes.get("a")!;
    const b = nodes.get("b")!;
    return { x: (r.x + r.width + a.x) / 2, y: (a.y + a.height + b.y) / 2 };
  };
  const square = (c: { x: number; y: number }, h: number) => [
    { x: c.x - h, y: c.y + h },
    { x: c.x + h, y: c.y + h },
    { x: c.x + h, y: c.y - h },
    { x: c.x - h, y: c.y - h },
  ];

  it("a_touch_lasso_picks_the_map_on_a_node_not_on_empty_space", async () => {
    const id = await load();
    const { lassoSelect } = await import("../../tools/lasso");
    const a = centreOf(id, "a");
    // Anticlockwise (screen y down) loops are "touch" lassos.
    expect(lassoSelect(s().elements, store.spatialIndex(), square({ x: a.clientX, y: a.clientY }, 3), "touch")).toEqual([id]);
    expect(lassoSelect(s().elements, store.spatialIndex(), square(gap(id), 1), "touch")).toEqual([]);
  });

  it("the_eraser_hits_a_node_box_but_not_the_empty_space", async () => {
    const id = await load();
    const { eraseAt } = await import("../../tools/eraser");
    const opts = { eraseShapes: true, eraseImages: false };
    const a = centreOf(id, "a");
    expect(eraseAt(s().elements, store.spatialIndex(), { x: a.clientX, y: a.clientY }, 2, "stroke", opts).removed).toEqual([id]);
    expect(eraseAt(s().elements, store.spatialIndex(), gap(id), 1, "stroke", opts).removed).toEqual([]);
    expect(eraseAt(s().elements, store.spatialIndex(), { x: a.clientX, y: a.clientY }, 2, "stroke", { ...opts, eraseShapes: false }).removed).toEqual([]);
  });
});
