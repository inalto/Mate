import { describe, expect, it } from "vitest";
import type { Element, Page } from "../../model/types";
import type { MindmapContent } from "../../model/content";
import { elementBounds, SpatialIndex } from "../../tools/spatialIndex";
import { renderToPdf, type PdfDeps, type PdfExportOptions } from "../../export/renderToPdf";
import { hitTest } from "../../canvas/toolInteractions";
import { layoutMindmap } from "../../mindmap/layout";
import { measureFor, mindmapView } from "../../mindmap/cache";
import { hitMindNode, mindmapHit } from "../../mindmap/hit";
import type { MindNode } from "../../mindmap/tree";
import "../builtins";
import { drawElement, elementSvg } from "../registry";
import { mindmapScene } from "../mindmap";
import { contrastText } from "../../mindmap/styles";

const STAMP = "2026-01-01T00:00:00.000Z";

const tree = (): MindNode => ({
  id: "r",
  text: "Topic",
  children: [
    { id: "a", text: "Alpha", children: [{ id: "a1", text: "Leaf <one>", children: [] }] },
    { id: "b", text: "Beta", children: [] },
  ],
});

const mindmap = (over: Partial<MindmapContent> = {}, at = { x: 0, y: 0 }, id = "m1"): Element => ({
  id,
  pageId: "pm",
  type: "mindmap",
  points: [{ x: at.x, y: at.y, pressure: 0.5, timestamp: 0 }],
  color: "#000000",
  width: 1,
  isHighlighter: false,
  content: { layout: "right", style: 1, root: tree(), ...over },
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
});

const count = (s: string, tag: string) => s.split(`<${tag} `).length - 1 + (s.split(`<${tag}>`).length - 1);

function stubCtx() {
  const calls: string[] = [];
  const rec = (name: string) => () => void calls.push(name);
  const ctx = {
    save: rec("save"),
    restore: rec("restore"),
    beginPath: rec("beginPath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    arc: rec("arc"),
    closePath: rec("closePath"),
    stroke: rec("stroke"),
    fill: rec("fill"),
    setLineDash: rec("setLineDash"),
    fillText: (text: string) => void calls.push(`fillText:${text}`),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("mind-map renderer", () => {
  it("svg_has_one_rect_and_text_per_node_and_one_path_per_edge", () => {
    const svg = elementSvg(mindmap(), { theme: "light", zoomBucket: 1 });
    expect(count(svg, "rect")).toBe(4);
    expect(count(svg, "text")).toBe(4);
    expect(count(svg, "path")).toBe(3);
    expect(svg).toContain("Leaf &lt;one&gt;");
    expect(svg).toContain('font-weight="600"');
  });

  it("every_style_renders_and_minimal_has_no_fill", () => {
    for (const style of [1, 2, 3, 4] as const) {
      const svg = elementSvg(mindmap({ style }), { theme: "dark", zoomBucket: 1 });
      expect(count(svg, "path")).toBe(3);
    }
    const minimal = elementSvg(mindmap({ style: 3 }), { theme: "light", zoomBucket: 1 });
    expect(minimal).toContain('fill="none"');
    expect(minimal).toContain("<line");
    expect(elementSvg(mindmap({ style: 4 }), { theme: "light", zoomBucket: 1 })).toContain("stroke-dasharray");
  });

  it("collapsed_nodes_hide_their_subtree_and_show_a_count_badge", () => {
    const root = tree();
    root.children[0] = { ...root.children[0], collapsed: true };
    const svg = elementSvg(mindmap({ root }), { theme: "light", zoomBucket: 1 });
    expect(svg).not.toContain("Leaf");
    expect(count(svg, "path")).toBe(2);
    expect(svg).toContain("<circle");
    expect(svg).toMatch(/>1<\/text>/);
  });

  it("badges_are_filled_with_the_branch_colour_in_every_style_and_theme", () => {
    const root = tree();
    root.children[0] = { ...root.children[0], collapsed: true };
    for (const theme of ["light", "sepia", "dark", "high-contrast"] as const) {
      for (const style of [1, 2, 3, 4] as const) {
        const scene = mindmapScene(mindmap({ root, style }), theme);
        const node = scene.nodes.find((x) => x.box.id === "a")!;
        expect(scene.badges).toHaveLength(1);
        const badge = scene.badges[0];
        expect(badge.fill).toBe(node.paint.stroke);
        expect(badge.text).toBe(contrastText(badge.fill));
        if (style === 4) expect(badge.fill).not.toBe(node.paint.fill);
      }
    }
    const svg = elementSvg(mindmap({ root, style: 4 }), { theme: "light", zoomBucket: 1 });
    const soft = mindmapScene(mindmap({ root, style: 4 }), "light");
    const fill = soft.nodes.find((x) => x.box.id === "a")!.paint.fill;
    expect(svg).toMatch(new RegExp(`<circle [^>]*fill="${soft.badges[0].fill}"`));
    expect(svg).not.toMatch(new RegExp(`<circle [^>]*fill="${fill}"`));
  });

  it("draws_edges_nodes_and_text", () => {
    const { ctx, calls } = stubCtx();
    drawElement(ctx, mindmap(), { theme: "sepia", zoomBucket: 1 });
    expect(calls).toContain("fillText:Topic");
    expect(calls).toContain("fillText:Beta");
    expect(calls.indexOf("stroke")).toBeLessThan(calls.indexOf("fillText:Topic"));
  });

  it("bounds_are_the_layout_bounds_padded_by_2", () => {
    const el = mindmap({}, { x: 100, y: 50 });
    const view = mindmapView(el, "estimate");
    const expected = layoutMindmap({ layout: "right", root: tree() }, { x: 100, y: 50 }, measureFor("estimate")).bounds;
    expect(view.layout.bounds).toEqual(expected);
    const b = elementBounds(el);
    const kind = mindmapView(el).layout.bounds;
    expect(b).toEqual({ x: kind.x - 2, y: kind.y - 2, width: kind.width + 4, height: kind.height + 4 });
    // The root is centred on points[0].
    const root = view.layout.nodes.get("r")!;
    expect(root.x + root.width / 2).toBeCloseTo(100);
    expect(root.y + root.height / 2).toBeCloseTo(50);
  });

  it("memoises_the_layout_until_the_element_changes", () => {
    const el = mindmap();
    const v = mindmapView(el, "estimate");
    expect(mindmapView({ ...el }, "estimate")).toBe(v);
    expect(mindmapView({ ...el, updatedAt: "2026-01-02T00:00:00.000Z" }, "estimate")).not.toBe(v);
    const moved = mindmapView({ ...el, points: [{ x: 10, y: 0, pressure: 0.5, timestamp: 0 }] }, "estimate");
    expect(moved.layout.nodes.get("r")!.x).toBeCloseTo(v.layout.nodes.get("r")!.x + 10);
  });

  it("hits_nodes_and_edges_but_not_empty_space", () => {
    const el = mindmap();
    const view = mindmapView(el);
    const b = view.layout.nodes.get("b")!;
    expect(hitMindNode(el, { x: b.x + b.width / 2, y: b.y + b.height / 2 })).toBe("b");
    expect(hitMindNode(el, { x: b.x - 30, y: b.y - 300 })).toBeNull();
    const edge = view.layout.edges.find((e) => e.to === "b")!;
    const mid = edge.path[Math.floor(edge.path.length / 2)];
    expect(hitMindNode(el, mid)).toBeNull();
    expect(mindmapHit(el, { x: mid.x, y: mid.y + 3 }, 4)).toBe(true);
    expect(mindmapHit(el, { x: mid.x, y: mid.y + 20 }, 4)).toBe(false);

    const elements = new Map([[el.id, el]]);
    const index = SpatialIndex.from(elements.values());
    expect(hitTest(index, elements, { x: b.x + 4, y: b.y + 4 }, 8, 1)).toBe("m1");
    expect(hitTest(index, elements, { x: mid.x, y: mid.y + 3 }, 8, 1)).toBe("m1");
    // Inside the bounds but away from every node and edge.
    const bounds = view.layout.bounds;
    expect(hitTest(index, elements, { x: bounds.x + bounds.width - 2, y: bounds.y + bounds.height - 2 }, 8, 1)).toBeNull();
  });

  it("pdf_export_with_a_mind_map_does_not_throw", async () => {
    const page: Page = {
      id: "pm",
      sectionId: "s1",
      title: "T",
      isExpanded: false,
      isFavourite: false,
      depth: 0,
      mode: "canvas",
      backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
      thumbnailVersion: 0,
      orderIndex: 0,
      createdAt: STAMP,
      updatedAt: STAMP,
      version: 0,
    };
    const deps: PdfDeps = {
      readPdfBytes: async () => {
        throw new Error("no PDFs in this test");
      },
      rasterize: () => null,
      rasterPdfPages: async () => new Map(),
    };
    const opts: PdfExportOptions = { theme: "light", background: "plain", pages: "all", searchable: false };
    const root = tree();
    root.children[0] = { ...root.children[0], collapsed: true };
    for (const style of [1, 2, 3, 4] as const) {
      const bytes = await renderToPdf([mindmap({ style, root })], page, opts, deps);
      expect(bytes.byteLength).toBeGreaterThan(0);
    }
  });
});
