import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/export", () => ({ writeExportFile: vi.fn(async () => "C:/out.pdf") }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../exportPage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../exportPage")>()),
  renderPagePdf: vi.fn(),
}));

import { writeExportFile } from "../../ipc/export";
import type { Page, Section, Unit } from "../../model/types";
import { useNotebookStore } from "../../stores/notebook";
import { buildBookPdf, exportBook, NoPagesError, PageExportError } from "../exportBook";
import { renderPagePdf } from "../exportPage";

const STAMP = "2026-01-01T00:00:00.000Z";
const unit: Unit = { id: "u1", title: "Physics 日本語", isFavourite: false, isExpanded: true, orderIndex: 0, createdAt: STAMP, updatedAt: STAMP, version: 0 };
const section = (id: string, title: string, orderIndex: number): Section => ({
  id,
  unitId: "u1",
  title,
  color: "#000",
  orderIndex,
  isExpanded: true,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
});
const page = (id: string, sectionId: string, title: string, orderIndex: number, extra: Partial<Page> = {}): Page => ({
  id,
  sectionId,
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
  ...extra,
});

/** A real PDF with one page per size. */
async function pdfOf(...sizes: [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const size of sizes) doc.addPage(size);
  return doc.save();
}

interface ReadNode {
  title: string;
  page: number;
  children: ReadNode[];
}

/** The outline of `doc`, read back by following First/Next. */
function readOutline(doc: PDFDocument): ReadNode[] {
  const pageRefs = doc.getPages().map((p) => p.ref);
  const walk = (first: PDFRef | undefined): ReadNode[] => {
    const out: ReadNode[] = [];
    for (let ref = first; ref; ) {
      const d = doc.context.lookup(ref, PDFDict);
      const title = d.lookup(PDFName.of("Title"));
      const dest = d.lookup(PDFName.of("Dest"), PDFArray);
      const target = dest.get(0) as PDFRef;
      out.push({
        title: title instanceof PDFHexString || title instanceof PDFString ? title.decodeText() : "",
        page: pageRefs.findIndex((r) => r === target),
        children: walk(d.get(PDFName.of("First")) as PDFRef | undefined),
      });
      ref = d.get(PDFName.of("Next")) as PDFRef | undefined;
    }
    return out;
  };
  const root = doc.catalog.lookupMaybe(PDFName.of("Outlines"), PDFDict);
  return root ? walk(root.get(PDFName.of("First")) as PDFRef | undefined) : [];
}

const rendered = vi.mocked(renderPagePdf);

beforeEach(() => {
  vi.clearAllMocks();
  useNotebookStore.setState({
    tree: {
      bookshelves: [],
      units: [unit],
      sections: [section("s2", "Waves", 1), section("s1", "Mechanics", 0)],
      pages: [
        page("p3", "s2", "Sound", 0),
        page("p1", "s1", "Forces è", 0),
        page("p2", "s1", "Friction", 0, { parentId: "p1", depth: 1 }),
      ],
    },
    loaded: true,
  });
  rendered.mockImplementation(async (p) =>
    p.id === "p1" ? pdfOf([300, 400], [300, 400]) : p.id === "p2" ? pdfOf([500, 200]) : pdfOf([210, 297]),
  );
});

describe("buildBookPdf", () => {
  it("joins every page of the book in sidebar order, sizes kept", async () => {
    const { bytes, title } = await buildBookPdf({ kind: "book", unitId: "u1" });
    expect(title).toBe("Physics 日本語");
    expect(rendered.mock.calls.map(([p]) => p.id)).toEqual(["p1", "p2", "p3"]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([
      [300, 400],
      [300, 400],
      [500, 200],
      [210, 297],
    ]);
    expect(doc.getTitle()).toBe("Physics 日本語");
  });

  it("writes an outline of sections, pages and nested pages", async () => {
    const doc = await PDFDocument.load((await buildBookPdf({ kind: "book", unitId: "u1" })).bytes);
    expect(readOutline(doc)).toEqual([
      {
        title: "Mechanics",
        page: 0,
        children: [{ title: "Forces è", page: 0, children: [{ title: "Friction", page: 2, children: [] }] }],
      },
      { title: "Waves", page: 3, children: [{ title: "Sound", page: 3, children: [] }] },
    ]);
    const root = doc.catalog.lookup(PDFName.of("Outlines"), PDFDict);
    expect(root.lookup(PDFName.of("Count"), PDFNumber).asNumber()).toBe(5);
  });

  it("exports one section with its pages at the top of the outline", async () => {
    const { bytes, title } = await buildBookPdf({ kind: "section", sectionId: "s1" });
    expect(title).toBe("Mechanics");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(readOutline(doc)).toEqual([
      { title: "Forces è", page: 0, children: [{ title: "Friction", page: 2, children: [] }] },
    ]);
  });

  it("reports progress after each page", async () => {
    const onProgress = vi.fn();
    await buildBookPdf({ kind: "book", unitId: "u1" }, { onProgress });
    expect(onProgress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("exports whole pages: no region, every sheet, no separate layer", async () => {
    await buildBookPdf(
      { kind: "book", unitId: "u1" },
      { region: { x: 0, y: 0, width: 5, height: 5 }, pages: "current", annotations: "layer", covers: "hidden", theme: "dark" },
    );
    const opts = rendered.mock.calls[0][1]!;
    expect(opts.region).toBeUndefined();
    expect(opts.pages).toBe("all");
    expect(opts.annotations).toBe("flat");
    expect(opts.covers).toBe("hidden");
    expect(opts.theme).toBe("dark");
    expect("onProgress" in opts).toBe(false);
  });

  it("stops and names the page that cannot be drawn", async () => {
    rendered.mockImplementation(async (p) => {
      if (p.id === "p2") throw new Error("boom");
      return pdfOf([10, 10]);
    });
    const err = await buildBookPdf({ kind: "book", unitId: "u1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PageExportError);
    expect((err as PageExportError).pageTitle).toBe("Friction");
    expect((err as PageExportError).message).toBe("boom");
    expect(rendered).toHaveBeenCalledTimes(2);
  });

  it("refuses a book without pages", async () => {
    useNotebookStore.setState({ tree: { bookshelves: [], units: [unit], sections: [section("s1", "Mechanics", 0)], pages: [] } });
    await expect(buildBookPdf({ kind: "book", unitId: "u1" })).rejects.toBeInstanceOf(NoPagesError);
    await expect(buildBookPdf({ kind: "section", sectionId: "nope" })).rejects.toBeInstanceOf(NoPagesError);
  });
});

describe("exportBook", () => {
  it("saves under the book's title", async () => {
    expect(await exportBook({ kind: "book", unitId: "u1" })).toBe("C:/out.pdf");
    const [name, bytes] = vi.mocked(writeExportFile).mock.calls[0];
    expect(name).toBe("physics.pdf");
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(4);
  });

  it("saves a section under the section's title and writes nothing when a page fails", async () => {
    await exportBook({ kind: "section", sectionId: "s2" });
    expect(vi.mocked(writeExportFile).mock.calls[0][0]).toBe("waves.pdf");
    vi.mocked(writeExportFile).mockClear();
    rendered.mockRejectedValue(new Error("boom"));
    await expect(exportBook({ kind: "book", unitId: "u1" })).rejects.toBeInstanceOf(PageExportError);
    expect(writeExportFile).not.toHaveBeenCalled();
  });
});
