// Page export: render the page to PNG or SVG and save it through the native save dialog.
import { prepareImages } from "../images/load";
import { loadElements } from "../ipc/elements";
import { writeExportFile } from "../ipc/export";
import type { Element } from "../model/types";
import { preparePdfPages } from "../pdf/render";
import { prepareTextSnapshots } from "../overlay/snapshot";
import { editorForPane } from "../stores/focusedEditor";
import { useNotebookStore } from "../stores/notebook";
import { renderToCanvas } from "./renderToCanvas";
import { renderToSvg } from "./renderToSvg";
import type { ExportOptions } from "./scene";

export type PageExportFormat = "png" | "svg";

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
  options: Partial<ExportOptions> = {},
): Promise<string | null> {
  const page = useNotebookStore.getState().tree.pages.find((p) => p.id === pageId);
  if (!page) throw new Error("page not found");
  const elements = await elementsOf(pageId);
  const opts: ExportOptions = {
    scale: 2,
    theme: "light",
    background: "plain",
    pageFrame: page.mode === "page",
    ...options,
  };
  // Text boxes are drawn from bitmaps rendered asynchronously: have them ready for the PNG.
  if (format === "png") await prepareTextSnapshots(elements, opts.theme, opts.scale);
  await prepareImages(elements, format === "svg");
  // PDF pages: rendered at the export scale for PNG; embedded as 2× PNGs in SVG.
  await preparePdfPages(elements, format === "svg" ? 2 : opts.scale, format === "svg");
  const bytes =
    format === "png"
      ? await canvasToPng(renderToCanvas(elements, page, opts))
      : new TextEncoder().encode(renderToSvg(elements, page, { ...opts, scale: 1 }));
  return writeExportFile(pageExportFilename(page.title, format), bytes);
}
