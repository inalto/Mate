// A book PDF built with the real page renderer (jsPDF) and joined with pdf-lib: what another app
// would import.
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/export", () => ({ writeExportFile: vi.fn(async () => "C:/out.pdf") }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../../overlay/snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../overlay/snapshot")>()),
  prepareTextSnapshots: vi.fn(async () => new Map()),
}));
vi.mock("../../graph/engine", () => ({ loadEngine: vi.fn(async () => ({})), engineSync: () => null }));

import { loadElements } from "../../ipc/elements";
import { PAGE_GAP } from "../../model/constants";
import type { Element, Page, Point, Section, Unit } from "../../model/types";
import { useNotebookStore } from "../../stores/notebook";
import { buildBookPdf } from "../exportBook";
import { PT_PER_UNIT } from "../renderToPdf";
import { pdfText } from "./pdfText";

const STAMP = "2026-01-01T00:00:00.000Z";
const SHEET = { width: 1080, height: 1398 };
const unit: Unit = { id: "u1", title: "Physics", isFavourite: false, isExpanded: true, orderIndex: 0, createdAt: STAMP, updatedAt: STAMP, version: 0 };
const section: Section = { id: "s1", unitId: "u1", title: "Mechanics", color: "#000", orderIndex: 0, isExpanded: true, createdAt: STAMP, updatedAt: STAMP, version: 0 };
const page = (id: string, title: string, orderIndex: number, over: Partial<Page> = {}): Page => ({
  id,
  sectionId: "s1",
  title,
  isExpanded: false,
  isFavourite: false,
  depth: 0,
  mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
  ...over,
});
const line = (x0: number, y0: number, x1: number, y1: number, n = 20): Point[] =>
  Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, pressure: 0.5, timestamp: i * 8 };
  });
const stroke = (id: string, pageId: string, points: Point[]): Element => ({
  id,
  pageId,
  type: "stroke",
  points,
  color: "#1565C0",
  width: 4,
  isHighlighter: false,
  penStyle: "pen",
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
});

const ELEMENTS: Record<string, Element[]> = {
  // Ink on the first and on the second sheet.
  sheets: [stroke("a", "sheets", line(100, 100, 600, 300)), stroke("b", "sheets", line(100, SHEET.height + PAGE_GAP + 200, 700, SHEET.height + PAGE_GAP + 400))],
  canvas: [stroke("c", "canvas", line(0, 0, 2000, 500))],
  empty: [],
};

beforeEach(() => {
  vi.mocked(loadElements).mockImplementation(async (pageId: string) => ELEMENTS[pageId] ?? []);
  useNotebookStore.setState({
    tree: {
      bookshelves: [],
      units: [unit],
      sections: [section],
      pages: [
        page("sheets", "Forces", 0, { mode: "page", pageWidth: SHEET.width, pageHeight: SHEET.height }),
        page("canvas", "Whiteboard", 1),
        page("empty", "Empty", 2),
      ],
    },
    loaded: true,
  });
});

describe("a real book PDF", () => {
  it("holds every sheet of every page, with vector ink and an outline", async () => {
    const { bytes } = await buildBookPdf({ kind: "book", unitId: "u1" }, { searchable: true });
    expect(new TextDecoder("latin1").decode(bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    // Two sheets, one canvas page, one empty page.
    expect(doc.getPageCount()).toBe(4);
    const sizes = doc.getPages().map((p) => p.getSize());
    for (const i of [0, 1]) {
      expect(sizes[i].width).toBeCloseTo(SHEET.width * PT_PER_UNIT, 1);
      expect(sizes[i].height).toBeCloseTo(SHEET.height * PT_PER_UNIT, 1);
    }
    // The canvas page is sized to its content: wider than tall.
    expect(sizes[2].width).toBeGreaterThan(2000 * PT_PER_UNIT);
    expect(sizes[2].width).toBeGreaterThan(sizes[2].height);

    // Ink is drawn as paths: no page carries a picture.
    for (const p of doc.getPages()) {
      const resources = p.node.Resources();
      const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
      expect(xobjects?.keys().length ?? 0).toBe(0);
    }
    // The stroke colour (#1565C0) is set as a stroke or fill colour on the inked pages.
    const content = await pdfText(bytes);
    expect(/0\.08 0\.4 0\.75 (RG|rg)/.test(content)).toBe(true);

    const root = doc.catalog.lookup(PDFName.of("Outlines"), PDFDict);
    const sectionEntry = doc.context.lookup(root.get(PDFName.of("First")) as PDFRef, PDFDict);
    const titles: string[] = [];
    for (let ref = sectionEntry.get(PDFName.of("First")) as PDFRef | undefined; ref; ) {
      const d = doc.context.lookup(ref, PDFDict);
      titles.push(d.lookup(PDFName.of("Title"), PDFHexString).decodeText());
      ref = d.get(PDFName.of("Next")) as PDFRef | undefined;
    }
    expect(titles).toEqual(["Forces", "Whiteboard", "Empty"]);
  });
});
