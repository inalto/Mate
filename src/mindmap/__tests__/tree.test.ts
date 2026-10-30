import { describe, expect, it } from "vitest";
import {
  addChild,
  addSibling,
  findNode,
  type MindNode,
  moveNode,
  newNode,
  newNodeId,
  parentOf,
  removeNode,
  setText,
  toggleCollapsed,
  walk,
} from "../tree";

const n = (id: string, text: string, children: MindNode[] = []): MindNode => ({ id, text, children });

/** root → a (a1, a2), b, c (c1 → c1x) */
const sample = (): MindNode =>
  n("root", "Topic", [n("a", "A", [n("a1", "A1"), n("a2", "A2")]), n("b", "B"), n("c", "C", [n("c1", "C1", [n("c1x", "X")])])]);

const ids = (root: MindNode) => {
  const out: string[] = [];
  walk(root, (node) => out.push(node.id));
  return out;
};

describe("mind-map tree", () => {
  it("creates nodes with unique ids and no children", () => {
    const a = newNode("Hello");
    const b = newNode("Hello");
    expect(a).toMatchObject({ text: "Hello", children: [] });
    expect(a.id).not.toBe(b.id);
    expect(typeof newNodeId()).toBe("string");
  });

  it("walks pre-order with depth and parent", () => {
    const seen: string[] = [];
    walk(sample(), (node, depth, parent) => seen.push(`${node.id}:${depth}:${parent?.id ?? "-"}`));
    expect(seen).toEqual(["root:0:-", "a:1:root", "a1:2:a", "a2:2:a", "b:1:root", "c:1:root", "c1:2:c", "c1x:3:c1"]);
  });

  it("finds nodes and parents", () => {
    const t = sample();
    expect(findNode(t, "c1")?.text).toBe("C1");
    expect(findNode(t, "zz")).toBeNull();
    expect(parentOf(t, "a2")?.id).toBe("a");
    expect(parentOf(t, "root")).toBeNull();
  });

  it("adds children at the end or at an index without mutating", () => {
    const t = sample();
    const before = JSON.stringify(t);
    const t2 = addChild(t, "a", n("new", "N"));
    expect(findNode(t2, "a")?.children.map((c) => c.id)).toEqual(["a1", "a2", "new"]);
    const t3 = addChild(t, "a", n("new", "N"), 0);
    expect(findNode(t3, "a")?.children.map((c) => c.id)).toEqual(["new", "a1", "a2"]);
    expect(JSON.stringify(t)).toBe(before);
    // untouched subtrees are shared
    expect(t2.children[1]).toBe(t.children[1]);
    expect(addChild(t, "missing", n("x", "X"))).toBe(t);
  });

  it("adds siblings after or before, never next to the root", () => {
    const t = sample();
    expect(addSibling(t, "b", n("s", "S")).children.map((c) => c.id)).toEqual(["a", "b", "s", "c"]);
    expect(addSibling(t, "b", n("s", "S"), true).children.map((c) => c.id)).toEqual(["a", "s", "b", "c"]);
    expect(addSibling(t, "root", n("s", "S"))).toBe(t);
  });

  it("removes a subtree but never the root", () => {
    const t = sample();
    const t2 = removeNode(t, "c");
    expect(ids(t2)).toEqual(["root", "a", "a1", "a2", "b"]);
    expect(ids(t)).toContain("c1x");
    expect(removeNode(t, "root")).toBe(t);
  });

  it("moves a node to the end of another parent", () => {
    const t = sample();
    const t2 = moveNode(t, "a2", "b");
    expect(findNode(t2, "a")?.children.map((c) => c.id)).toEqual(["a1"]);
    expect(findNode(t2, "b")?.children.map((c) => c.id)).toEqual(["a2"]);
    expect(findNode(t, "a")?.children).toHaveLength(2);
  });

  it("refuses to move a node into itself, a descendant, or to move the root", () => {
    const t = sample();
    expect(moveNode(t, "c", "c")).toBe(t);
    expect(moveNode(t, "c", "c1x")).toBe(t);
    expect(moveNode(t, "root", "a")).toBe(t);
    expect(moveNode(t, "a", "missing")).toBe(t);
  });

  it("sets text and toggles collapsed immutably", () => {
    const t = sample();
    const t2 = setText(t, "b", "Bee");
    expect(findNode(t2, "b")?.text).toBe("Bee");
    expect(findNode(t, "b")?.text).toBe("B");
    const t3 = toggleCollapsed(t, "a");
    expect(findNode(t3, "a")?.collapsed).toBe(true);
    expect(findNode(t, "a")?.collapsed).toBeUndefined();
    expect(findNode(toggleCollapsed(t3, "a"), "a")?.collapsed).toBeUndefined();
  });
});
