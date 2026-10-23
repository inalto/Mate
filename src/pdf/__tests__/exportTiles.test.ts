import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/notebook", () => ({}));
vi.mock("../../ipc/thumbnails", () => ({ saveThumbnail: vi.fn(async () => ({ path: "x", version: 1 })) }));
const loadElements = vi.hoisted(() => vi.fn());
vi.mock("../../ipc/elements", () => ({ loadElements, upsertElements: vi.fn(), deleteElements: vi.fn() }));
vi.mock("../../ipc/export", () => ({ writeExportFile: vi.fn(async () => "C:/out.png") }));

import { exportPage } from "../../export/exportPage";
import { canvasExportLayout } from "../../export/renderToCanvas";
import { DEFAULT_SETTINGS, PAGE_WIDTH } from "../../model/constants";
import type { Element, Page } from "../../model/types";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { captureThumbnail } from "../../thumbnails";
import { layoutPdfPages } from "../import";
import { cachedPdfTileKeys, clearPdfTiles, PREPARE_CONCURRENCY, preparePdfPages, zoomBucketFor } from "../render";
import { configurePdfLoader } from "../source";

const PT = { width: 612, height: 792 };

interface FakeBitmap {
  page: number;
  scale: number;
  width: number;
  height: number;
  toDataURL(): string;
}

let renders: FakeBitmap[];
let active = 0;
let maxActive = 0;

function useStubPdf(count: number, delayMs = 0) {
  configurePdfLoader(async () => ({
    pageCount: count,
    pageSize: async () => PT,
    render: async (page: number, scale: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, delayMs));
      active--;
      const bmp: FakeBitmap = { page, scale, width: 10, height: 10, toDataURL: () => `data:image/png;base64,${page}` };
      renders.push(bmp);
      return bmp as unknown as HTMLCanvasElement;
    },
  }));
}

function pdfPage(count: number): { page: Page; elements: Element[] } {
  const { sheet, boxes } = layoutPdfPages(Array.from({ length: count }, () => PT));
  const page: Page = {
    id: "pg", sectionId: "s", title: "doc", isExpanded: true, isFavourite: false, depth: 0, mode: "page",
    backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 }, pageWidth: sheet.width, pageHeight: sheet.height,
    thumbnailVersion: 0, orderIndex: 0, createdAt: "", updatedAt: "", version: 0,
  };
  const elements = boxes.map((b, i): Element => ({
    id: `pl${i + 1}`, pageId: "pg", type: "image", points: [{ x: b.x, y: b.y, pressure: 0.5, timestamp: 0 }],
    color: "#000000", width: b.width, height: b.height, isHighlighter: false,
    content: { pdfSourceKey: "pdf-1", pdfPageIndex: i + 1, zIndex: -1_000_000 },
    createdAt: "t", updatedAt: "t", version: 0,
  }));
  return { page, elements };
}

/** A 2d context that records drawImage sources and ignores everything else. */
let drawn: unknown[];
function stubCanvas() {
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) => (k === "drawImage" ? (src: unknown) => drawn.push(src) : k in t ? t[k] : () => {}),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ctx as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb: BlobCallback) {
    cb(new Blob([new Uint8Array([1])]));
  });
}

beforeEach(() => {
  renders = [];
  drawn = [];
  active = 0;
  maxActive = 0;
  clearPdfTiles();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
  stubCanvas();
});
afterEach(() => {
  configurePdfLoader();
  vi.restoreAllMocks();
});

describe("PDF pages in exports and thumbnails", () => {
  it("prepare_runs_at_most_3_renders_concurrently", async () => {
    useStubPdf(12, 2);
    const { elements } = pdfPage(12);
    const kept = await preparePdfPages(elements, 1, { keep: true });
    expect(maxActive).toBe(PREPARE_CONCURRENCY);
    expect(PREPARE_CONCURRENCY).toBe(3);
    expect(kept.size).toBe(12);
    expect(renders.map((r) => r.page).slice(0, 3).sort()).toEqual([1, 2, 3]); // in order
  });

  it("svg preparation builds data URLs without keeping the canvases", async () => {
    useStubPdf(5);
    const { elements } = pdfPage(5);
    const kept = await preparePdfPages(elements, 2, { embed: true });
    expect(kept.size).toBe(0);
    expect(cachedPdfTileKeys()).toEqual([]);
  });

  it("png_export_prepares_tiles_at_paint_scale", async () => {
    useStubPdf(20);
    const { page, elements } = pdfPage(20);
    useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [], sections: [], pages: [page] } });
    loadElements.mockResolvedValue(elements);
    const paint = canvasExportLayout(elements, page, 2).scale;
    expect(zoomBucketFor(paint)).not.toBe(zoomBucketFor(2)); // a tall page is fitted below the asked scale
    await exportPage("pg", "png", { scale: 2 });
    const want = (zoomBucketFor(paint) * PAGE_WIDTH) / PT.width;
    expect(new Set(renders.map((r) => r.scale))).toEqual(new Set([want]));
    expect(drawn.filter((d) => renders.includes(d as FakeBitmap))).toHaveLength(20);
  });

  it("export_tiles_are_not_evicted_mid_paint", async () => {
    useStubPdf(70);
    const { page, elements } = pdfPage(70); // more pages than the on-screen tile cache holds
    useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [], sections: [], pages: [page] } });
    loadElements.mockResolvedValue(elements);
    await exportPage("pg", "png", { scale: 2 });
    const painted = new Set(drawn.filter((d) => renders.includes(d as FakeBitmap)).map((d) => (d as FakeBitmap).page));
    expect(painted.size).toBe(70);
    expect(cachedPdfTileKeys()).toEqual([]); // the on-screen cache was left alone
  });

  it("thumbnail_prepares_only_visible_pdf_pages", async () => {
    useStubPdf(200);
    const { page, elements } = pdfPage(200);
    await captureThumbnail("pg", elements, page);
    expect(renders.map((r) => r.page)).toEqual([1]);
    expect(drawn).toContain(renders[0]);
  });
});
