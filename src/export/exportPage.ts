// Page export: render the page to PNG, SVG, PDF or LaTeX and save it through the native save
// dialog. Graphs need the lazily loaded math engine: it is awaited first so no "Loading…" frame is
// exported.
import { screenToWorld, sheetSize } from "../canvas/camera";
import { prepareImages } from "../images/load";
import { loadElements } from "../ipc/elements";
import { writeExportFile } from "../ipc/export";
import { PAGE_GAP } from "../model/constants";
import { isPdfPlacement } from "../model/content";
import type { Element } from "../model/types";
import { preparePdfPages } from "../pdf/render";
import { prepareTextSnapshots } from "../overlay/snapshot";
import { endAllEdits } from "../overlay/useEditSession";
import { editorForPane } from "../stores/focusedEditor";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";
import { canvasExportLayout, renderToCanvas } from "./renderToCanvas";
import { readyGraphs } from "./readyGraphs";
import { renderToLatex } from "./renderToLatex";
import { renderToSvg } from "./renderToSvg";
import type { ExportOptions } from "./scene";

export type PageExportFormat = "png" | "svg" | "pdf" | "latex";

export interface PageExportOptions extends Partial<ExportOptions> {
  /** PDF: every sheet, or the sheet shown in the editor (page mode). */
  pages?: "all" | "current";
  /** PDF: add an invisible text layer from text boxes. */
  searchable?: boolean;
}

const EXTENSIONS: Record<PageExportFormat, string> = { png: "png", svg: "svg", pdf: "pdf", latex: "tex" };

/** Slug of `title` (`[^a-z0-9]+` → `-`, trimmed, ≤ 60 chars) + `.ext`, else `mate-export-YYYY-MM-DD.ext`. */
export function pageExportFilename(title: string, ext: string, now: Date = new Date()): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  if (slug) return `${slug}.${ext}`;
  const pad = (v: number) => String(v).padStart(2, "0");
  return `mate-export-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.${ext}`;
}

/** The page's elements: an open editor's in-memory copy (includes unsaved edits), else storage. */
async function elementsOf(pageId: string): Promise<Element[]> {
  for (const i of [0, 1] as const) {
    const s = editorForPane(i).getState();
    if (s.loadedPageId === pageId) return [...s.elements.values()];
  }
  return loadElements(pageId);
}

/** 0-based sheet at the centre of the editor showing `pageId` (0 when no editor shows it). */
export function currentSheetIndex(pageId: string): number {
  for (const i of [0, 1] as const) {
    const s = editorForPane(i).getState();
    if (s.loadedPageId !== pageId || !s.page) continue;
    const vp = s.viewport.width > 0 ? s.viewport : { width: 1280, height: 800 };
    const centreY = screenToWorld(s.camera, { x: vp.width / 2, y: vp.height / 2 }).y;
    const { height } = sheetSize(s.page, useSettingsStore.getState().settings.defaultPageAspectRatio);
    return Math.max(0, Math.floor(centreY / (height + PAGE_GAP)));
  }
  return 0;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? b.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject) : reject(new Error("PNG encoding failed"))),
      "image/png",
    ),
  );
}

/** Export a page; resolves to the saved path, or `null` if the save dialog was cancelled. */
export async function exportPage(
  pageId: string,
  format: PageExportFormat,
  options: PageExportOptions = {},
): Promise<string | null> {
  const page = useNotebookStore.getState().tree.pages.find((p) => p.id === pageId);
  if (!page) throw new Error("page not found");
  // An open box editor keeps its edits locally until the session ends: commit them first.
  endAllEdits();
  const elements = await elementsOf(pageId);
  const filename = pageExportFilename(page.title, EXTENSIONS[format]);
  if (format === "latex") {
    const tex = renderToLatex(elements.filter((e) => e.pageId === pageId));
    return writeExportFile(filename, new TextEncoder().encode(tex));
  }
  await readyGraphs(elements);
  const opts: ExportOptions = {
    scale: 2,
    theme: "light",
    background: "plain",
    pageFrame: page.mode === "page",
    ...options,
  };
  if (format === "pdf") {
    // jsPDF and pdf-lib are large: loaded on the first PDF export only.
    const { PDF_RASTER_SCALE, renderToPdf } = await import("./renderToPdf");
    await prepareTextSnapshots(elements, opts.theme, PDF_RASTER_SCALE);
    // Sheets backed by an imported PDF keep the original page and are drawn in light colours.
    if (opts.theme !== "light" && elements.some(isPdfPlacement)) await prepareTextSnapshots(elements, "light", PDF_RASTER_SCALE);
    await prepareImages(elements);
    const bytes = await renderToPdf(elements, page, {
      theme: opts.theme,
      background: opts.background,
      pages: options.pages ?? "all",
      currentSheet: options.pages === "current" ? currentSheetIndex(pageId) : undefined,
      searchable: options.searchable ?? true,
    });
    return writeExportFile(filename, bytes);
  }
  // Text boxes are drawn from bitmaps rendered asynchronously: have them ready for the PNG.
  if (format === "png") await prepareTextSnapshots(elements, opts.theme, opts.scale);
  await prepareImages(elements, format === "svg");
  let bytes: Uint8Array;
  if (format === "png") {
    // PDF pages at the scale the canvas is actually painted at, held by this export until it is drawn.
    const pdfTiles = await preparePdfPages(elements, canvasExportLayout(elements, page, opts.scale).scale, { keep: true });
    bytes = await canvasToPng(renderToCanvas(elements, page, opts, pdfTiles));
  } else {
    await preparePdfPages(elements, 2, { embed: true }); // embedded as 2× PNGs
    bytes = new TextEncoder().encode(renderToSvg(elements, page, { ...opts, scale: 1 }));
  }
  return writeExportFile(filename, bytes);
}
