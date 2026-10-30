import { describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
import { mindmapOf } from "../../model/content";
import { addChild, findNode, newNode, removeNode, setText, toggleCollapsed, type MindNode } from "../../mindmap/tree";
import { mindmapView } from "../../mindmap/cache";
import { elementBounds } from "../../tools/spatialIndex";

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

import { useEditorStore } from "../editor";
import { useNotebookStore } from "../notebook";

const s = () => useEditorStore.getState();
const mm = (id: string) => mindmapOf(s().elements.get(id)!)!;

async function load(els: Element[] = []): Promise<void> {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  s().setViewport({ width: 1000, height: 600 });
}

describe("mind-map store", () => {
  it("adds_a_mind_map_with_a_topic_root_at_the_given_point", async () => {
    await load();
    const id = s().addMindmap({ x: 300, y: 200 }, 2)!;
    const el = s().elements.get(id)!;
    expect(el.type).toBe("mindmap");
    expect(el.points[0]).toMatchObject({ x: 300, y: 200 });
    const c = mm(id);
    expect(c.layout).toBe("right");
    expect(c.style).toBe(2);
    expect(c.root.text).toBe("Topic");
    expect(c.root.children).toEqual([]);
    expect([...s().selection]).toEqual([id]);
    expect(s().tool).toBe("cursor");
    expect(s().mindmapFocus).toEqual({ elementId: id, nodeId: c.root.id });
  });

  it("defaults_to_the_view_centre_and_style_1", async () => {
    await load();
    const id = s().addMindmap()!;
    const el = s().elements.get(id)!;
    const cam = s().camera;
    expect(el.points[0].x).toBeCloseTo((500 - cam.x) / cam.z);
    expect(el.points[0].y).toBeCloseTo((300 - cam.y) / cam.z);
    expect(mm(id).style).toBe(1);
  });

  it("add_and_edit_are_two_undo_steps", async () => {
    await load();
    const id = s().addMindmap({ x: 0, y: 0 })!;
    const rootId = mm(id).root.id;
    const before = s().elements.get(id)!.updatedAt;
    expect(s().editMindmap(id, (r) => addChild(r, rootId, newNode("Child")), "Add node")).toBe(true);
    expect(mm(id).root.children.map((c) => c.text)).toEqual(["Child"]);
    expect(s().elements.get(id)!.updatedAt >= before).toBe(true);
    s().undo();
    expect(mm(id).root.children).toEqual([]);
    s().undo();
    expect(s().elements.has(id)).toBe(false);
    s().redo();
    s().redo();
    expect(mm(id).root.children.map((c) => c.text)).toEqual(["Child"]);
  });

  it("a_merge_key_collapses_typing_into_one_entry", async () => {
    await load();
    const id = s().addMindmap({ x: 0, y: 0 })!;
    const rootId = mm(id).root.id;
    for (const t of ["I", "Id", "Ide", "Idea"]) s().editMindmap(id, (r) => setText(r, rootId, t), "Edit node", `mindnode-text:${rootId}`);
    expect(mm(id).root.text).toBe("Idea");
    s().undo();
    expect(mm(id).root.text).toBe("Topic");
    expect(s().elements.has(id)).toBe(true);
  });

  it("an_edit_that_changes_nothing_or_a_locked_map_is_refused", async () => {
    await load();
    const id = s().addMindmap({ x: 0, y: 0 })!;
    expect(s().editMindmap(id, (r) => r, "Nothing")).toBe(false);
    s().lockSelection();
    const rootId = mm(id).root.id;
    expect(s().editMindmap(id, (r) => setText(r, rootId, "X"), "Edit node")).toBe(false);
    expect(s().setMindmapProps(id, { style: 3 })).toBe(false);
    expect(mm(id).root.text).toBe("Topic");
  });

  it("is_read_only_while_presenting", async () => {
    await load();
    const id = s().addMindmap({ x: 0, y: 0 })!;
    const rootId = mm(id).root.id;
    s().addFrame({ x: -200, y: -200, width: 400, height: 400 });
    s().startPresentation();
    expect(s().presenting).not.toBeNull();
    expect(s().editMindmap(id, (r) => setText(r, rootId, "X"), "Edit node")).toBe(false);
    expect(s().setMindmapProps(id, { style: 2 })).toBe(false);
    expect(s().addMindmap({ x: 0, y: 0 })).toBeNull();
    s().stopPresentation();
    expect(mm(id).root.text).toBe("Topic");
  });

  it("sets_layout_and_style_as_one_entry", async () => {
    await load();
    const id = s().addMindmap({ x: 0, y: 0 })!;
    expect(s().setMindmapProps(id, { layout: "balance", style: 4 })).toBe(true);
    expect(mm(id)).toMatchObject({ layout: "balance", style: 4 });
    expect(s().setMindmapProps(id, { layout: "balance" })).toBe(false);
    s().undo();
    expect(mm(id)).toMatchObject({ layout: "right", style: 1 });
  });

  it("imports_a_tree_at_a_point", async () => {
    await load();
    const root: MindNode = { id: "x", text: "Plan", children: [{ id: "y", text: "Step", children: [] }] };
    const id = s().importMindmap(root, { x: 40, y: 60 })!;
    expect(mm(id).root).toEqual(root);
    expect(s().elements.get(id)!.points[0]).toMatchObject({ x: 40, y: 60 });
    expect(mm(id).style).toBe(1);
  });

  it("focus_follows_the_tree_and_clears_when_the_node_goes", async () => {
    await load();
    const id = s().addMindmap({ x: 0, y: 0 })!;
    const rootId = mm(id).root.id;
    const child = newNode("Child");
    s().editMindmap(id, (r) => addChild(r, rootId, child), "Add node");
    s().focusMindNode(id, child.id);
    expect(s().mindmapFocus).toEqual({ elementId: id, nodeId: child.id });
    s().focusMindNode(id, "missing");
    expect(s().mindmapFocus).toEqual({ elementId: id, nodeId: child.id });
    s().editMindmap(id, (r) => removeNode(r, child.id), "Delete node");
    expect(s().mindmapFocus).toBeNull();
    s().focusMindNode(id, rootId);
    s().focusMindNode(id, null);
    expect(s().mindmapFocus).toBeNull();
    s().focusMindNode(id, rootId);
    s().removeElements([id]);
    expect(s().mindmapFocus).toBeNull();
  });

  it("collapsing_an_ancestor_moves_the_focus_to_the_nearest_visible_ancestor", async () => {
    await load();
    const id = s().addMindmap({ x: 0, y: 0 })!;
    const rootId = mm(id).root.id;
    const a = newNode("A");
    const leaf = newNode("Leaf");
    s().editMindmap(id, (r) => addChild(addChild(r, rootId, a), a.id, leaf), "Add nodes");
    s().focusMindNode(id, leaf.id);
    s().editMindmap(id, (r) => toggleCollapsed(r, a.id), "Collapse");
    expect(s().mindmapFocus).toEqual({ elementId: id, nodeId: a.id });
    // Collapsing the root hides `a` too: the focus goes up again.
    s().editMindmap(id, (r) => toggleCollapsed(r, rootId), "Collapse");
    expect(s().mindmapFocus).toEqual({ elementId: id, nodeId: rootId });
    // A focused node outside the collapsed subtree keeps its focus.
    s().undo();
    s().undo();
    s().focusMindNode(id, a.id);
    s().editMindmap(id, (r) => toggleCollapsed(r, leaf.id), "Collapse");
    expect(s().mindmapFocus).toEqual({ elementId: id, nodeId: a.id });
  });

  it("moving_a_mind_map_translates_its_root_centre", async () => {
    await load();
    const id = s().addMindmap({ x: 100, y: 100 })!;
    const rootId = mm(id).root.id;
    s().editMindmap(id, (r) => addChild(r, rootId, newNode("Child")), "Add node");
    const b0 = elementBounds(s().elements.get(id)!);
    s().select([id]);
    s().moveSelection(30, -20);
    const el = s().elements.get(id)!;
    expect(el.points[0]).toMatchObject({ x: 130, y: 80 });
    const b1 = elementBounds(el);
    expect(b1.x).toBeCloseTo(b0.x + 30);
    expect(b1.y).toBeCloseTo(b0.y - 20);
    expect(findNode(mm(id).root, rootId)).not.toBeNull();
    const box = mindmapView(el).layout.nodes.get(rootId)!;
    expect(box.x + box.width / 2).toBeCloseTo(130);
  });
});
