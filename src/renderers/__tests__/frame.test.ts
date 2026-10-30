import { describe, expect, it } from "vitest";
import type { Element, Page } from "../../model/types";
import { elementBounds } from "../../tools/spatialIndex";
import { renderToPdf, type PdfDeps, type PdfExportOptions } from "../../export/renderToPdf";
import { setPageFrames } from "../../frames/contain";
import "../builtins";
import { drawElement, elementSvg } from "../registry";
import { frameFill, mixHex } from "../frame";

const STAMP = "2026-01-01T00:00:00.000Z";

const frame = (over: Record<string, unknown> = {}, box = { x: 0, y: 0, w: 400, h: 300 }, id = "f1"): Element => ({
  id,
  pageId: "pf",
  type: "frame",
  points: [{ x: box.x, y: box.y, pressure: 0.5, timestamp: 0 }],
  color: "#000000",
  width: 1,
  isHighlighter: false,
  boxWidth: box.w,
  boxHeight: box.h,
  content: { title: "Intro & <goals>", order: 0, ...over },
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
    translate: rec("translate"),
    rotate: rec("rotate"),
    fillText: (text: string) => void calls.push(`fillText:${text}`),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("frame renderer", () => {
  it("svg_has_the_rounded_rect_and_the_title_text", () => {
    const svg = elementSvg(frame(), { theme: "light", zoomBucket: 1 });
    expect(svg).toContain("<rect");
    expect(svg).toContain('rx="8"');
    expect(svg).toContain("<text");
    expect(svg).toContain("Intro &amp; &lt;goals&gt;");
    expect(svg).toContain('font-weight="600"');
  });

  it("fill_defaults_to_a_4_percent_ink_tint_per_theme", () => {
    expect(frameFill(frame(), "light")).toBe(mixHex("#ffffff", "#000000", 0.04));
    expect(frameFill(frame(), "light")).toBe("#f5f5f5");
    expect(frameFill(frame(), "dark")).toBe(mixHex("#18181b", "#ffffff", 0.04));
    expect(frameFill(frame({ background: "#FFF59D" }), "dark")).toBe("#FFF59D");
  });

  it("title_hides_when_narrow_on_screen_and_when_empty", () => {
    // 400 units at zoom 0.1 = 40 px.
    expect(elementSvg(frame(), { theme: "light", zoomBucket: 0.1 })).not.toContain("<text");
    expect(elementSvg(frame({ title: "" }), { theme: "light", zoomBucket: 1 })).not.toContain("<text");
  });

  it("title_goes_inside_when_nested", () => {
    const outer = frame({ title: "Outer" }, { x: 0, y: 0, w: 1000, h: 1000 }, "outer");
    const inner = frame({ title: "Inner" }, { x: 100, y: 100, w: 400, h: 300 }, "inner");
    setPageFrames("pf", [outer, inner]);
    const y = (svg: string) => Number(/<text x="[^"]+" y="([^"]+)"/.exec(svg)![1]);
    expect(y(elementSvg(inner, { theme: "light", zoomBucket: 1 }))).toBeGreaterThan(100);
    expect(y(elementSvg(outer, { theme: "light", zoomBucket: 1 }))).toBeLessThan(0);
    setPageFrames("pf", []);
  });

  it("draws_fill_border_and_title", () => {
    const { ctx, calls } = stubCtx();
    drawElement(ctx, frame(), { theme: "sepia", zoomBucket: 1 });
    expect(calls).toContain("fill");
    expect(calls).toContain("stroke");
    expect(calls).toContain("fillText:Intro & <goals>");
  });

  it("bounds_include_the_title_band", () => {
    const b = elementBounds(frame());
    expect(b.y).toBeLessThan(0);
    expect(b.y + b.height).toBe(300);
    expect(b.width).toBe(400);
  });

  it("pdf_export_with_a_frame_does_not_throw", async () => {
    const page: Page = {
      id: "pf",
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
    const bytes = await renderToPdf([frame()], page, opts, deps);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
