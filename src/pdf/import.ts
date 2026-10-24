// PDF import: a PDF becomes ONE page in page mode with one sheet per PDF page. Each sheet holds an
// `image` element carrying `content.pdfSourceKey` (the PDF's asset id) and `content.pdfPageIndex`
// (1-based), anchored at the sheet's top-left and sized to it; these placements are locked (see
// model/content `isPdfPlacement`) and sit below everything else. The sheet size comes from the
// first PDF page (width PAGE_WIDTH); a page of another aspect is fitted inside its sheet.
import { open } from "@tauri-apps/plugin-dialog";
import { showToast } from "../components/Toast";
import i18n from "../i18n";
import { deleteAsset } from "../ipc/assets";
import { upsertElements } from "../ipc/elements";
import { readSharedPdf } from "../ipc/pdf";
import { PAGE_GAP, PAGE_WIDTH } from "../model/constants";
import { PDF_Z_INDEX } from "../model/content";
import type { Element, Page } from "../model/types";
import { useNotebookStore } from "../stores/notebook";
import { getPdfSource } from "./source";

export const MAX_PDF_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_PDF_IMPORT_PAGES = 200;

/** The sentence Rust rejects an oversized PDF with (recognised to show `pdf.tooLarge`). */
export const TOO_LARGE_MESSAGE = "PDF is larger than 50 MiB.";
export const tooManyPagesMessage = (n: number): string => i18n.t("pdf.tooManyPages", { n, max: MAX_PDF_IMPORT_PAGES });

/** An import refused for a reason the user should read (shown as the toast text). */
export class PdfImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfImportError";
  }
}

export interface Size {
  width: number;
  height: number;
}

export interface PdfLayout {
  sheet: Size;
  /** One box per PDF page, in page units. */
  boxes: Array<{ x: number; y: number; width: number; height: number }>;
}

/** Sheet size from the first page; each page fitted (aspect kept) at the top of its own sheet. */
export function layoutPdfPages(sizes: readonly Size[]): PdfLayout {
  const first = sizes[0];
  const aspect = first && first.width > 0 && first.height > 0 ? first.height / first.width : 1;
  const sheet = { width: PAGE_WIDTH, height: Math.max(1, Math.round(PAGE_WIDTH * aspect)) };
  const boxes = sizes.map((s, i) => {
    const ok = s.width > 0 && s.height > 0;
    const k = ok ? Math.min(sheet.width / s.width, sheet.height / s.height) : 1;
    const width = ok ? s.width * k : sheet.width;
    const height = ok ? s.height * k : sheet.height;
    // Rounding the sheet height can leave a sub-unit sliver: snap near-full boxes to the sheet.
    const w = Math.abs(width - sheet.width) < 1 ? sheet.width : width;
    const h = Math.abs(height - sheet.height) < 1 ? sheet.height : height;
    return { x: (sheet.width - w) / 2, y: i * (sheet.height + PAGE_GAP), width: w, height: h };
  });
  return { sheet, boxes };
}

function placement(pageId: string, assetId: string, index: number, box: PdfLayout["boxes"][number], now: string): Element {
  return {
    id: crypto.randomUUID(),
    pageId,
    type: "image",
    points: [{ x: box.x, y: box.y, pressure: 0.5, timestamp: 0 }],
    color: "#000000",
    width: box.width,
    height: box.height,
    isHighlighter: false,
    content: { pdfSourceKey: assetId, pdfPageIndex: index + 1, zIndex: PDF_Z_INDEX },
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

/** Create the page for stored PDF `assetId` in `sectionId` (one page write, one element batch). */
export async function importPdfAsPage(assetId: string, sectionId: string, title = "PDF"): Promise<Page> {
  const source = await getPdfSource(assetId);
  const n = source.pageCount;
  if (n > MAX_PDF_IMPORT_PAGES) throw new PdfImportError(tooManyPagesMessage(n));
  if (n < 1) throw new PdfImportError(i18n.t("pdf.noPages"));
  const sizes: Size[] = [];
  for (let i = 1; i <= n; i++) sizes.push(await source.pageSize(i));
  const { sheet, boxes } = layoutPdfPages(sizes);
  const page = await useNotebookStore.getState().createPage(sectionId, title, undefined, {
    mode: "page",
    pageWidth: sheet.width,
    pageHeight: sheet.height,
    backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
  });
  const now = new Date().toISOString();
  await upsertElements(boxes.map((b, i) => placement(page.id, assetId, i, b, now)));
  return page;
}

/** Page title from a file path: its name without the extension. */
export function titleFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  return name.replace(/\.pdf$/i, "").trim() || "PDF";
}

export const isPdfPath = (path: string): boolean => /\.pdf$/i.test(path);

/** The section imports go to: the most recently updated one, else "Imported" in the first book. */
export async function defaultImportSection(): Promise<string> {
  const store = useNotebookStore.getState();
  if (!store.loaded) await store.load();
  const { sections, units } = useNotebookStore.getState().tree;
  const latest = [...sections].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))[0];
  if (latest) return latest.id;
  const unit = [...units].sort((a, b) => a.orderIndex - b.orderIndex)[0] ?? (await store.createUnit(i18n.t("pdf.imported")));
  const existing = useNotebookStore.getState().tree.sections.find((s) => s.unitId === unit.id);
  return existing?.id ?? (await store.createSection(unit.id, i18n.t("pdf.imported"))).id;
}

const messageOf = (err: unknown): string => {
  if (err instanceof PdfImportError) return err.message;
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : "";
  return text === TOO_LARGE_MESSAGE ? i18n.t("pdf.tooLarge") : i18n.t("pdf.importFailed");
};

/**
 * Store the PDF at `path` (size-checked and sniffed in Rust) and import it into `sectionId` (default:
 * `defaultImportSection`). Failures show a toast and resolve to null.
 */
export async function importPdfFromPath(path: string, sectionId?: string): Promise<Page | null> {
  let stored: string | null = null;
  try {
    stored = (await readSharedPdf(path)).id;
    return await importPdfAsPage(stored, sectionId ?? (await defaultImportSection()), titleFromPath(path));
  } catch (err) {
    // A refused PDF must not linger in the asset store (nothing references it).
    if (stored) void deleteAsset(stored).catch(() => {});
    showToast(messageOf(err));
    return null;
  }
}

/** Library/Home "Import PDF…": pick a PDF and import it; the new page, or null. */
export async function pickAndImportPdf(sectionId?: string): Promise<Page | null> {
  const picked = await open({ multiple: false, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (typeof picked !== "string") return null;
  return importPdfFromPath(picked, sectionId);
}
