import { describe, expect, it } from "vitest";
import { layoutMindmap, nodeSize } from "../layout";
import type { MindNode } from "../tree";

const n = (id: string, text: string, children: MindNode[] = [], collapsed = false): MindNode =>
  collapsed ? { id, text, children, collapsed } : { id, text, children };
/** Fixed-width stub: 8 px per character, whatever the font size. */
const measure = (s: string) => s.length * 8;
const three = () => n("root", "Topic", [n("a", "A"), n("b", "B"), n("c", "C")]);

describe("mind-map node size", () => {
  it("pads, clamps and wraps", () => {
    expect(nodeSize("A", 16, measure)).toEqual({ width: 60, height: 36, lines: ["A"] });
    expect(nodeSize("Topic", 20, measure)).toEqual({ width: 64, height: 41, lines: ["Topic"] });
    const long = nodeSize("word ".repeat(20).trim(), 16, measure);
    expect(long.width).toBeLessThanOrEqual(264);
    expect(long.lines.length).toBeGreaterThan(1);
    expect(long.height).toBe(long.lines.length * 20 + 16);
    expect(nodeSize("", 16, measure)).toMatchObject({ width: 60, height: 36 });
  });
});

describe("layoutMindmap", () => {
  it("stacks three children with 12 px gaps, centred on the root, 72 px to the right", () => {
    const l = layoutMindmap({ layout: "right", root: three() }, { x: 0, y: 0 }, measure);
    const root = l.nodes.get("root")!;
    expect(root).toMatchObject({ x: -32, y: -20.5, width: 64, height: 41, depth: 0, branch: -1 });
    const [a, b, c] = ["a", "b", "c"].map((id) => l.nodes.get(id)!);
    for (const box of [a, b, c]) {
      expect(box.x).toBe(32 + 72);
      expect(box.side).toBe("right");
      expect(box.depth).toBe(1);
    }
    expect(b.y - (a.y + a.height)).toBe(12);
    expect(c.y - (b.y + b.height)).toBe(12);
    expect((a.y + c.y + c.height) / 2).toBe(0);
    expect([a.branch, b.branch, c.branch]).toEqual([0, 1, 2]);
  });

  it("mirrors to the left for layout left", () => {
    const l = layoutMindmap({ layout: "left", root: three() }, { x: 0, y: 0 }, measure);
    const a = l.nodes.get("a")!;
    expect(a.side).toBe("left");
    expect(a.x + a.width).toBe(-32 - 72);
  });

  it("alternates first-level children right/left for balance", () => {
    const root = n("root", "Topic", [n("a", "A"), n("b", "B"), n("c", "C"), n("d", "D")]);
    const l = layoutMindmap({ layout: "balance", root }, { x: 0, y: 0 }, measure);
    expect(["a", "b", "c", "d"].map((id) => l.nodes.get(id)!.side)).toEqual(["right", "left", "right", "left"]);
    // each side is centred on the root on its own
    const a = l.nodes.get("a")!;
    const c = l.nodes.get("c")!;
    expect((a.y + c.y + c.height) / 2).toBe(0);
  });

  it("places grandchildren 48 px further out and centres parents on their children", () => {
    const root = n("root", "Topic", [n("a", "A", [n("a1", "A1"), n("a2", "A2")]), n("b", "B")]);
    const l = layoutMindmap({ layout: "right", root }, { x: 100, y: 50 }, measure);
    const a = l.nodes.get("a")!;
    const a1 = l.nodes.get("a1")!;
    const a2 = l.nodes.get("a2")!;
    expect(a1.x).toBe(a.x + a.width + 48);
    expect(a1.depth).toBe(2);
    expect(a1.branch).toBe(0);
    expect(a.y + a.height / 2).toBe((a1.y + a2.y + a2.height) / 2);
    // subtree a spans 36+12+36 = 84, then 12 gap, then b (36)
    const b = l.nodes.get("b")!;
    expect(b.y).toBe(a1.y + 84 + 12);
  });

  it("lets a collapsed subtree contribute its own box only", () => {
    const root = n("root", "Topic", [n("a", "A", [n("a1", "A1"), n("a2", "A2"), n("a3", "A3")], true), n("b", "B")]);
    const l = layoutMindmap({ layout: "right", root }, { x: 0, y: 0 }, measure);
    expect(l.nodes.has("a1")).toBe(false);
    expect(l.nodes.size).toBe(3);
    const a = l.nodes.get("a")!;
    const b = l.nodes.get("b")!;
    expect(b.y - (a.y + a.height)).toBe(12);
    expect(l.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["root>a", "root>b"]);
  });

  it("draws flattened cubic edges from outer to inner edge midpoints", () => {
    const l = layoutMindmap({ layout: "balance", root: n("root", "Topic", [n("a", "A"), n("b", "B")]) }, { x: 0, y: 0 }, measure);
    const root = l.nodes.get("root")!;
    const toA = l.edges.find((e) => e.to === "a")!;
    const a = l.nodes.get("a")!;
    expect(toA.path).toHaveLength(17);
    expect(toA.path[0]).toEqual({ x: root.x + root.width, y: 0 });
    expect(toA.path[16]).toEqual({ x: a.x, y: a.y + a.height / 2 });
    const toB = l.edges.find((e) => e.to === "b")!;
    const b = l.nodes.get("b")!;
    expect(toB.path[0]).toEqual({ x: root.x, y: 0 });
    expect(toB.path[16]).toEqual({ x: b.x + b.width, y: b.y + b.height / 2 });
    // the curve stays monotonic in x between its ends
    for (let i = 1; i < 17; i++) expect(toA.path[i].x).toBeGreaterThanOrEqual(toA.path[i - 1].x);
  });

  it("bounds is the union of node rects", () => {
    const l = layoutMindmap({ layout: "balance", root: three() }, { x: 0, y: 0 }, measure);
    const boxes = [...l.nodes.values()];
    const minX = Math.min(...boxes.map((b) => b.x));
    const maxX = Math.max(...boxes.map((b) => b.x + b.width));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxY = Math.max(...boxes.map((b) => b.y + b.height));
    expect(l.bounds).toEqual({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
  });

  it("a lone root is centred on rootCentre", () => {
    const l = layoutMindmap({ layout: "right", root: n("root", "Topic") }, { x: 10, y: 20 }, measure);
    expect(l.bounds).toEqual({ x: -22, y: -0.5, width: 64, height: 41 });
    expect(l.edges).toEqual([]);
  });
});
