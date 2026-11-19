// Section / book export: every page of a section or a book as one PDF, in sidebar order, with an
// outline of sections and page titles. Each page is drawn exactly as its own PDF export draws it
// (renderPagePdf), one after another, and the results are joined with pdf-lib. Other note-taking
// apps (GoodNotes, Notability, Samsung Notes) import the file and annotate on top of it.
import { writeExportFile } from "../ipc/export";
import type { Page } from "../model/types";
import { endAllEdits } from "../overlay/useEditSession";
import { useNotebookStore } from "../stores/notebook";
import { orderedSections, type ExportScope, type OrderedSection } from "./bookOrder";
import { pageExportFilename, renderPagePdf, type PageExportOptions } from "./exportPage";
import type { OutlineNode } from "./pdfOutline";

/** One page could not be drawn: the export stops rather than leave it out. */
export class PageExportError extends Error {
  readonly pageTitle: string;
  constructor(pageTitle: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "PageExportError";
    this.pageTitle = pageTitle;
  }
}

/** The section or book has no page to export. */
export class NoPagesError extends Error {
  constructor() {
    super("no pages to export");
    this.name = "NoPagesError";
  }
}

export interface BookExportOptions extends PageExportOptions {
  /** Called after each page is drawn. */
  onProgress?(done: number, total: number): void;
}

/** Let the UI paint (progress) between two pages. */
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Outline entries of one section's pages; nested pages nest under their parent. */
function pageNodes(pages: Page[], firstIndex: Map<string, number>): OutlineNode[] {
  const nodes = new Map<string, OutlineNode>();
  const top: OutlineNode[] = [];
  // Depth-first order: a parent is always seen before its children.
  for (const p of pages) {
    const node: OutlineNode = { title: p.title, pageIndex: firstIndex.get(p.id) ?? 0, children: [] };
    nodes.set(p.id, node);
    const parent = p.parentId ? nodes.get(p.parentId) : undefined;
    (parent ? parent.children : top).push(node);
  }
  return top;
}

/** A book lists its sections with their pages under them; a section lists its pages. */
export function outlineOf(sections: OrderedSection[], scope: ExportScope, firstIndex: Map<string, number>): OutlineNode[] {
  if (scope.kind === "section") return sections.flatMap((s) => pageNodes(s.pages, firstIndex));
  return sections.map((s) => ({
    title: s.section.title,
    pageIndex: firstIndex.get(s.pages[0].id) ?? 0,
    children: pageNodes(s.pages, firstIndex),
  }));
}

/** The PDF of `scope` and the title it is saved under. */
export async function buildBookPdf(scope: ExportScope, options: BookExportOptions = {}): Promise<{ bytes: Uint8Array; title: string }> {
  const tree = useNotebookStore.getState().tree;
  const sections = orderedSections(tree, scope);
  const pages = sections.flatMap((s) => s.pages);
  if (pages.length === 0) throw new NoPagesError();
  const title =
    scope.kind === "section" ? sections[0].section.title : (tree.units.find((u) => u.id === scope.unitId)?.title ?? "");
  // An open box editor keeps its edits locally until the session ends: commit them first.
  endAllEdits();
  const { onProgress, ...rest } = options;
  // Whole pages only; a separate annotation layer does not survive joining the pages.
  const pageOptions: PageExportOptions = {
    ...rest,
    pages: "all",
    region: undefined,
    annotations: rest.annotations === "layer" ? "flat" : rest.annotations,
  };
  const { PDFDocument } = await import("pdf-lib");
  const { writeOutline } = await import("./pdfOutline");
  const out = await PDFDocument.create();
  const firstIndex = new Map<string, number>();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    try {
      const src = await PDFDocument.load(await renderPagePdf(page, pageOptions));
      firstIndex.set(page.id, out.getPageCount());
      for (const copied of await out.copyPages(src, src.getPageIndices())) out.addPage(copied);
    } catch (err) {
      throw new PageExportError(page.title, err);
    }
    onProgress?.(i + 1, pages.length);
    await yieldToUi();
  }
  writeOutline(out, outlineOf(sections, scope, firstIndex));
  if (title) out.setTitle(title);
  return { bytes: await out.save(), title };
}

/** Export a section or a book as one PDF; resolves to the saved path, or `null` if cancelled. */
export async function exportBook(scope: ExportScope, options: BookExportOptions = {}): Promise<string | null> {
  const { bytes, title } = await buildBookPdf(scope, options);
  return writeExportFile(pageExportFilename(title, "pdf"), bytes);
}
