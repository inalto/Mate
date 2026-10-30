import { describe, expect, it } from "vitest";
import type { Element, Page } from "../../model/types";
import type { ConnectorContent } from "../../model/content";
import { capOutline } from "../../shapes/geometry";
import { elementBounds } from "../../tools/spatialIndex";
import { hitTest } from "../../canvas/toolInteractions";
import { SpatialIndex } from "../../tools/spatialIndex";
import { renderToPdf, type PdfDeps, type PdfExportOptions } from "../../export/renderToPdf";
import "../builtins";
import { drawElement, elementSvg } from "../registry";

const STAMP = "2026-01-01T00:00:00.000Z";

const connector = (over: Partial<ConnectorContent> = {}): Element => ({
  id: "c1",
  pageId: "p1",
  type: "connector",
  points: [
    { x: 0, y: 0, pressure: 0.5, timestamp: 0 },
    { x: 200, y: 100, pressure: 0.5, timestamp: 1 },
  ],
  color: "#1565C0",
  width: 2,
  isHighlighter: false,
  content: {
    mode: "elbow",
    caps: { start: "diamond", end: "arrow" },
    route: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ],
    label: { text: "a < b", t: 0.5 },
    ...over,
  },
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
});

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

describe("connector renderer", () => {
  it("svg_has_a_path_and_the_label_text", () => {
    const svg = elementSvg(connector({ dash: "dashed" }), { theme: "light", zoomBucket: 1 });
    expect(svg).toContain("<path");
    expect(svg).toContain("M0 0L100 0L100 100L200 100");
    expect(svg).toContain("stroke-dasharray");
    expect(svg).toContain("<text");
    expect(svg).toContain("a &lt; b");
    expect(svg).toContain("<rect");
  });

  it("draws_route_caps_and_label", () => {
    const { ctx, calls } = stubCtx();
    drawElement(ctx, connector(), { theme: "dark", zoomBucket: 1 });
    expect(calls).toContain("fillText:a < b");
    expect(calls.filter((c) => c === "fill").length).toBeGreaterThanOrEqual(3); // two caps + pill
  });

  it("label_pill_takes_the_live_paper_colour_when_given", () => {
    const fills: string[] = [];
    const { ctx } = stubCtx();
    const c = ctx as unknown as { fill: () => void; fillStyle: string };
    c.fill = () => void fills.push(c.fillStyle);
    drawElement(ctx, connector({ caps: { start: "none", end: "none" } }), { theme: "sepia", zoomBucket: 1, paper: "#f7efdb" });
    expect(fills).toEqual(["#f7efdb"]);
    fills.length = 0;
    drawElement(ctx, connector({ caps: { start: "none", end: "none" } }), { theme: "light", zoomBucket: 1 });
    expect(fills).toEqual(["#ffffff"]); // exports keep the surface paper
  });

  it("bounds_cover_route_caps_and_label", () => {
    const b = elementBounds(connector());
    expect(b.x).toBeLessThan(0);
    expect(b.y).toBeLessThan(0);
    expect(b.x + b.width).toBeGreaterThan(200);
    expect(b.y + b.height).toBeGreaterThan(100);
  });

  it("hit_test_follows_the_route_not_the_bbox", () => {
    const el = connector({ label: undefined });
    const els = new Map([[el.id, el]]);
    const index = SpatialIndex.from(els.values());
    expect(hitTest(index, els, { x: 100, y: 50 }, 2)).toBe("c1");
    expect(hitTest(index, els, { x: 160, y: 30 }, 2)).toBeNull();
    // The label pill is hit too.
    const labelled = connector();
    const els2 = new Map([[labelled.id, labelled]]);
    expect(hitTest(SpatialIndex.from(els2.values()), els2, { x: 90, y: 52 }, 0)).toBe("c1");
  });

  it("diamond_cap_is_a_closed_rhombus", () => {
    const d = capOutline("diamond", { x: 0, y: 0 }, { x: 1, y: 0 }, 2, 12);
    expect(d).toHaveLength(5);
    expect(d[0]).toEqual({ x: 0, y: 0 });
    expect(d[2]).toEqual({ x: -12, y: 0 });
    expect(Math.abs(d[1].y)).toBeCloseTo(6);
  });
});

describe("connector PDF export", () => {
  it("one_connector_does_not_throw", async () => {
    const page: Page = {
      id: "p1",
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
    const bytes = await renderToPdf([connector({ dash: "dashed" })], page, opts, deps);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
