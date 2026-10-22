import { degrees, PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { PAGE_GAP } from "../../model/constants";
import type { Element, Page, PenStyle, Point } from "../../model/types";
import { MAX_PDF_PAGE_PT, overlayPlacement, PT_PER_UNIT, renderToPdf, type PdfDeps, type PdfExportOptions } from "../renderToPdf";

const STAMP = "2026-01-01T00:00:00.000Z";
const SHEET = { width: 1080, height: 1398 };
const STRIDE = SHEET.height + PAGE_GAP;

const page = (over: Partial<Page> = {}): Page => ({
  id: "p1",
  sectionId: "s1",
  title: "Test",
  isExpanded: false,
  isFavourite: false,
  depth: 0,
  mode: "canvas",
  backgroundConfig: { type: "ruled", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex: 0,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
  ...over,
});
const sheets = (): Page => page({ mode: "page", pageWidth: SHEET.width, pageHeight: SHEET.height });

const line = (x0: number, y0: number, x1: number, y1: number, n = 20): Point[] =>
  Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, pressure: 0.2 + 0.6 * t, timestamp: i * 8 };
  });

const stroke = (id: string, points: Point[], penStyle: PenStyle = "pen"): Element => ({
  id,
  pageId: "p1",
  type: "stroke",
  points,
  color: "#1565C0",
  width: 4,
  isHighlighter: penStyle === "highlighter",
  penStyle,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
});

const box = (id: string, type: Element["type"], x: number, y: number, w: number, h: number, content: unknown): Element => ({
  id,
  pageId: "p1",
  type,
  points: [{ x, y, pressure: 0.5, timestamp: 0 }],
  color: "#000000",
  width: type === "image" ? w : 1,
  height: type === "image" ? h : undefined,
  boxWidth: type === "image" ? undefined : w,
  boxHeight: type === "image" ? undefined : h,
  isHighlighter: false,
  content,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
});

const OPTS: PdfExportOptions = { theme: "light", background: "plain", pages: "all", searchable: false };

/** Dependencies that never touch the asset store, a canvas or pdf.js. */
const deps = (over: Partial<PdfDeps> = {}): PdfDeps => ({
  readPdfBytes: vi.fn(async () => {
    throw new Error("no PDFs in this test");
  }),
  rasterize: () => null,
  rasterPdfPages: async () => new Map(),
  ...over,
});

const text = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

describe("renderToPdf", () => {
  it("produces_pdf_header", async () => {
    const shape: Element = {
      ...stroke("sh", [{ x: 10, y: 10, pressure: 0.5, timestamp: 0 }, { x: 200, y: 120, pressure: 0.5, timestamp: 1 }]),
      type: "shape",
      shapeType: "rectangle",
      fillColor: "#C62828",
      content: { fillOpacity: 0.3 },
    };
    const els = [stroke("a", line(0, 0, 300, 200)), stroke("b", line(0, 50, 300, 250), "fountain-pen"), stroke("h", line(0, 90, 300, 90), "highlighter"), shape];
    const bytes = await renderToPdf(els, page(), OPTS, deps());
    expect(text(bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    // Canvas mode: one page sized to the content region (+40 padding each side).
    expect(width).toBeGreaterThan(300 * PT_PER_UNIT);
    expect(height).toBeGreaterThan(250 * PT_PER_UNIT);
  });

  it("caps a tall canvas page at the PDF size limit", async () => {
    const bytes = await renderToPdf([stroke("a", line(0, 0, 100, 40_000))], page(), OPTS, deps());
    const { width, height } = (await PDFDocument.load(bytes)).getPage(0).getSize();
    expect(height).toBeLessThanOrEqual(MAX_PDF_PAGE_PT + 0.01);
    expect(height / width).toBeGreaterThan(100); // scaled down, aspect kept
  });

  it("page_count_matches_sheets", async () => {
    const els = [stroke("a", line(100, 100, 300, 200)), stroke("c", line(100, 2 * STRIDE + 100, 300, 2 * STRIDE + 300))];
    const all = await PDFDocument.load(await renderToPdf(els, sheets(), OPTS, deps()));
    expect(all.getPageCount()).toBe(3);
    const size = all.getPage(1).getSize();
    expect(size.width).toBeCloseTo(SHEET.width * PT_PER_UNIT);
    expect(size.height).toBeCloseTo(SHEET.height * PT_PER_UNIT);

    const one = await PDFDocument.load(await renderToPdf(els, sheets(), { ...OPTS, pages: "current", currentSheet: 2 }, deps()));
    expect(one.getPageCount()).toBe(1);
  });

  it("embeds the original page of PDF-backed sheets", async () => {
    const src = await PDFDocument.create();
    src.addPage([612, 792]);
    src.addPage([612, 792]);
    const srcBytes = await src.save();
    const readPdfBytes = vi.fn(async () => srcBytes);
    const placement = (i: number) =>
      box(`pdf${i}`, "image", 0, i * STRIDE, SHEET.width, SHEET.height, { pdfSourceKey: "asset-1", pdfPageIndex: i + 1, zIndex: -1_000_000 });
    const els = [placement(0), placement(1), stroke("ink", line(100, STRIDE + 100, 400, STRIDE + 300))];
    const out = await PDFDocument.load(await renderToPdf(els, sheets(), OPTS, deps({ readPdfBytes })));
    expect(out.getPageCount()).toBe(2);
    expect(out.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(out.getPage(1).getSize()).toEqual({ width: 612, height: 792 });
    expect(readPdfBytes).toHaveBeenCalledTimes(1);
    expect(readPdfBytes).toHaveBeenCalledWith("asset-1");
  });

  it("draws the annotation layer upright on rotated source pages", async () => {
    const src = await PDFDocument.create();
    src.addPage([792, 612]).setRotation(degrees(90)); // displayed as 612 x 792
    const srcBytes = await src.save();
    const els = [
      box("pdf0", "image", 0, 0, SHEET.width, SHEET.height, { pdfSourceKey: "a", pdfPageIndex: 1 }),
      stroke("ink", line(100, 100, 400, 300)),
    ];
    const out = await PDFDocument.load(await renderToPdf(els, sheets(), OPTS, deps({ readPdfBytes: async () => srcBytes })));
    expect(out.getPageCount()).toBe(1);
    expect(out.getPage(0).getRotation().angle).toBe(90);
  });

  it("overlayPlacement maps the placement box onto the displayed page", () => {
    // PDF spec: /Rotate turns the page clockwise for display. User → display (origin bottom-left):
    const toDisplay = (rot: number, W: number, H: number, x: number, y: number): [number, number] =>
      rot === 90 ? [y, W - x] : rot === 180 ? [W - x, H - y] : rot === 270 ? [H - y, x] : [x, y];
    const sheet = { x: 0, y: 2 * STRIDE, width: SHEET.width, height: SHEET.height };
    const box = { x: 40, y: 2 * STRIDE + 10, width: 1000, height: 1294 }; // fitted inside the sheet
    for (const rot of [0, 90, 180, 270]) {
      const [W, H] = rot % 180 ? [792, 612] : [612, 792]; // displayed 612 x 792 either way
      const a = overlayPlacement(rot, { x: 0, y: 0, width: W, height: H }, box, sheet);
      expect(a.scale).toBeCloseTo(612 / 1000);
      // A layer point (sheet-local units, y down) drawn at the anchor, turned `rotate` degrees.
      const layerToDisplay = (u: number, v: number) => {
        const lx = u * a.scale;
        const ly = (sheet.height - v) * a.scale; // layer is y-up from its bottom-left corner
        const t = (a.rotate * Math.PI) / 180;
        const ux = a.x + lx * Math.cos(t) - ly * Math.sin(t);
        const uy = a.y + lx * Math.sin(t) + ly * Math.cos(t);
        return toDisplay(rot, W, H, ux, uy);
      };
      const [tlx, tly] = layerToDisplay(box.x - sheet.x, box.y - sheet.y); // box top-left
      expect(tlx).toBeCloseTo(0);
      expect(tly).toBeCloseTo(792);
      const [brx, bry] = layerToDisplay(box.x - sheet.x + box.width, box.y - sheet.y + box.height); // box bottom-right
      expect(brx).toBeCloseTo(612);
      expect(bry).toBeCloseTo(0, 0);
    }
  });

  it("falls back to a raster page when the source PDF cannot be read", async () => {
    const rasterPdfPages = vi.fn(async () => new Map());
    const els = [box("pdf0", "image", 0, 0, SHEET.width, SHEET.height, { pdfSourceKey: "gone", pdfPageIndex: 1 })];
    const out = await PDFDocument.load(await renderToPdf(els, sheets(), OPTS, deps({ rasterPdfPages })));
    expect(out.getPageCount()).toBe(1);
    expect(out.getPage(0).getSize().width).toBeCloseTo(SHEET.width * PT_PER_UNIT);
    expect(rasterPdfPages).toHaveBeenCalledTimes(1);
  });

  it("adds an invisible text layer from text boxes when searchable", async () => {
    const tb = box("t", "text-box", 50, 50, 300, 80, {
      contentHtml: "<p>Hello searchable</p>",
      rawContent: "Hello searchable\nsecond line",
      textAttributes: { fontFamily: "sans", fontSize: 18, color: "#000000", align: "left" },
    });
    const on = text(await renderToPdf([tb], page(), { ...OPTS, searchable: true, compress: false }, deps()));
    expect(on).toContain("(Hello searchable) Tj");
    expect(on).toContain("(second line) Tj");
    expect(on).toMatch(/\b3 Tr\b/);
    const off = text(await renderToPdf([tb], page(), { ...OPTS, compress: false }, deps()));
    expect(off).not.toContain("Hello searchable");
  });
});
