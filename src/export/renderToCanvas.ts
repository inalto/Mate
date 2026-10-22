// Raster page export: the page's region drawn into an offscreen canvas at `scale` px per unit.
import type { Element, Page } from "../model/types";
import { useSettingsStore } from "../stores/settings";
import type { PdfTileSet } from "../pdf/render";
import { exportRegion, pageElements, paintScene, type ExportOptions } from "./scene";

/** Browser canvas limits (Chromium/WebView2): per-side and total pixel area. */
const MAX_CANVAS_SIDE = 16_384;
const MAX_CANVAS_AREA = 268_000_000;

/** `scale`, reduced if needed so the output fits the browser's canvas limits. */
export function fitScale(width: number, height: number, scale: number): number {
  return Math.min(scale, MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height, Math.sqrt(MAX_CANVAS_AREA / (width * height)));
}

/** Elements, region, sheet stack and the (canvas-limit fitted) scale a PNG export of `page` paints at. */
export function canvasExportLayout(elements: Iterable<Element>, page: Page, scale: number) {
  const aspect = useSettingsStore.getState().settings.defaultPageAspectRatio;
  const list = pageElements(page, elements);
  const { region, sheet } = exportRegion(page, list, aspect);
  return { list, region, sheet, scale: fitScale(region.width, region.height, scale) };
}

/** Draw `page` into a new canvas; `pdfTiles` are its PDF pages prepared at the layout's scale. */
export function renderToCanvas(elements: Iterable<Element>, page: Page, opts: ExportOptions, pdfTiles?: PdfTileSet): HTMLCanvasElement {
  const { list, region, sheet, scale } = canvasExportLayout(elements, page, opts.scale);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(region.width * scale));
  canvas.height = Math.max(1, Math.round(region.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable");
  ctx.scale(scale, scale);
  ctx.translate(-region.x, -region.y);
  paintScene(ctx, page, list, region, sheet, { ...opts, zoomBucket: scale, pdfTiles });
  return canvas;
}
