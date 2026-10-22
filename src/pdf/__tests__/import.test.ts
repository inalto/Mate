import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/notebook", () => ({
  getNotebookTree: vi.fn(async () => ({ bookshelves: [], units: [], sections: [], pages: [] })),
  listTrash: vi.fn(async () => []),
  upsertPage: vi.fn(async () => {}),
  upsertUnit: vi.fn(async () => {}),
  upsertSection: vi.fn(async () => {}),
  upsertBookshelf: vi.fn(async () => {}),
}));
vi.mock("../../ipc/elements", () => ({
  loadElements: vi.fn(async () => []),
  upsertElements: vi.fn(async () => {}),
  deleteElements: vi.fn(async () => {}),
}));

import { upsertElements } from "../../ipc/elements";
import { upsertPage } from "../../ipc/notebook";
import { PAGE_GAP, PAGE_WIDTH } from "../../model/constants";
import { contentOf, type ImageContent } from "../../model/content";
import type { Element, Page } from "../../model/types";
import { importPdfAsPage, PdfImportError, tooManyPagesMessage } from "../import";
import { configurePdfLoader, type PdfSource } from "../source";

function stubSource(sizes: Array<{ width: number; height: number }>, pageCount = sizes.length): PdfSource {
  return {
    pageCount,
    pageSize: async (n) => sizes[n - 1] ?? sizes[0],
    render: async () => document.createElement("canvas"),
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => configurePdfLoader());

describe("importPdfAsPage", () => {
  it("creates_one_sheet_per_page", async () => {
    const letter = { width: 612, height: 792 };
    configurePdfLoader(async () => stubSource([letter, letter, letter, { width: 792, height: 612 }]));
    const page = await importPdfAsPage("pdf-asset", "sec1", "Lecture 3");

    const sheetH = Math.round((PAGE_WIDTH * 792) / 612);
    expect(page).toMatchObject({ sectionId: "sec1", title: "Lecture 3", mode: "page", pageWidth: PAGE_WIDTH, pageHeight: sheetH });
    expect(upsertPage).toHaveBeenCalledTimes(1);
    expect((vi.mocked(upsertPage).mock.calls[0][0] as Page).mode).toBe("page");

    expect(upsertElements).toHaveBeenCalledTimes(1); // one batch
    const els = vi.mocked(upsertElements).mock.calls[0][0] as Element[];
    expect(els).toHaveLength(4);
    els.forEach((el, i) => {
      const c = contentOf<ImageContent>(el);
      expect(el.type).toBe("image");
      expect(el.pageId).toBe(page.id);
      expect(c.pdfSourceKey).toBe("pdf-asset");
      expect(c.pdfPageIndex).toBe(i + 1);
      // Anchored on its own sheet, inside it.
      const top = i * (sheetH + PAGE_GAP);
      expect(el.points[0].y).toBeGreaterThanOrEqual(top);
      expect(el.points[0].y + el.height!).toBeLessThanOrEqual(top + sheetH + 1e-6);
      expect(el.points[0].x).toBeGreaterThanOrEqual(0);
      expect(el.points[0].x + el.width).toBeLessThanOrEqual(PAGE_WIDTH + 1e-6);
    });
    // Same-aspect pages fill their sheet from its top-left corner.
    expect(els[1].points[0]).toMatchObject({ x: 0, y: sheetH + PAGE_GAP });
    expect([els[1].width, els[1].height]).toEqual([PAGE_WIDTH, sheetH]);
    // A landscape page keeps its aspect inside the portrait sheet.
    expect(els[3].width / els[3].height!).toBeCloseTo(792 / 612, 3);
    expect(els[3].width).toBeCloseTo(PAGE_WIDTH, 6);
  });

  it("rejects_over_200_pages", async () => {
    configurePdfLoader(async () => stubSource([{ width: 612, height: 792 }], 201));
    const run = importPdfAsPage("pdf-asset", "sec1", "Big");
    await expect(run).rejects.toBeInstanceOf(PdfImportError);
    await expect(run).rejects.toThrow("This PDF has 201 pages; Mate imports up to 200.");
    expect(tooManyPagesMessage(201)).toBe("This PDF has 201 pages; Mate imports up to 200.");
    expect(upsertPage).not.toHaveBeenCalled();
    expect(upsertElements).not.toHaveBeenCalled();
  });

  it("accepts exactly 200 pages", async () => {
    configurePdfLoader(async () => stubSource([{ width: 595, height: 842 }], 200));
    await importPdfAsPage("pdf-asset", "sec1", "Max");
    expect((vi.mocked(upsertElements).mock.calls[0][0] as Element[]).length).toBe(200);
  });
});
