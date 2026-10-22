// Shared scene drawing for exports and thumbnails: the world-space region to capture and the
// background + element painter for a 2D context. The SVG writer uses the same region and pattern.
// Elements are drawn by their type's renderer (renderers/registry), in z-order.
import { paintBackground, type BackgroundPage, type Rect, type SurfaceColors } from "../canvas/background";
import { sheetSize } from "../canvas/camera";
import { isDarkTheme } from "../ink/theme";
import type { ThemeName } from "../ink/types";
import { PAGE_GAP } from "../model/constants";
import type { Element, Page } from "../model/types";
import "../renderers/builtins";
import { drawElement, type RenderOptions } from "../renderers/registry";
import { elementBounds } from "../tools/spatialIndex";
import { renderOrder } from "../tools/zorder";

export const EXPORT_PADDING = 40;
/** Region used for an empty infinite-canvas page. */
const EMPTY_REGION: Rect = { x: 0, y: 0, width: 1024, height: 768 };

export interface ExportOptions {
  /** Device pixels per page unit. */
  scale: number;
  theme: ThemeName;
  background: "plain" | "transparent";
  /** Page mode: draw sheet rectangles on the desk colour (else the gaps are paper too). */
  pageFrame: boolean;
}

/** Paper/desk colours of exports (and thumbnails), matching the app's light and dark canvases. */
export function surfaceFor(theme: ThemeName): SurfaceColors {
  return isDarkTheme(theme) ? { paper: "#18181b", desk: "#0e0e10" } : { paper: "#ffffff", desk: "#eceef1" };
}

/** Live elements of `page`. */
export const pageElements = (page: Page, elements: Iterable<Element>): Element[] =>
  [...elements].filter((e) => e.pageId === page.id && !e.deletedAt);

/** Bounds of all elements plus `padding` on each side; `null` when there are none. */
export function contentRegion(elements: Iterable<Element>, padding: number): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    const b = elementBounds(el);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX - padding, y: minY - padding, width: maxX - minX + 2 * padding, height: maxY - minY + 2 * padding };
}

/**
 * Region and sheet stack of a page export. Canvas mode: content bounds + 40 units of padding.
 * Page mode: every sheet down to the last one holding content (at least one), stacked.
 */
export function exportRegion(page: Page, elements: Element[], defaultAspect: string): { region: Rect; sheet: BackgroundPage } {
  if (page.mode === "page") {
    const { width, height } = sheetSize(page, defaultAspect);
    const stride = height + PAGE_GAP;
    let bottom = 0;
    for (const el of elements) {
      const b = elementBounds(el);
      bottom = Math.max(bottom, b.y + b.height);
    }
    const count = bottom > 0 ? Math.floor(bottom / stride) + 1 : 1;
    return { region: { x: 0, y: 0, width, height: count * stride - PAGE_GAP }, sheet: { mode: "page", width, height, count } };
  }
  const region = contentRegion(elements, EXPORT_PADDING) ?? EMPTY_REGION;
  return { region, sheet: { mode: "canvas", width: region.width, height: region.height } };
}

/**
 * Paint background (unless transparent) and elements for `clip` into `ctx`, which already has the
 * world transform. `zoomBucket` is the output scale (device pixels per unit).
 */
export function paintScene(
  ctx: CanvasRenderingContext2D,
  page: Page,
  elements: Iterable<Element>,
  clip: Rect,
  sheet: BackgroundPage,
  opts: Omit<ExportOptions, "scale"> & { zoomBucket: number; pdfTiles?: RenderOptions["pdfTiles"]; textBitmaps?: RenderOptions["textBitmaps"] },
): void {
  if (opts.background === "plain") {
    const surface = surfaceFor(opts.theme);
    if (!opts.pageFrame) surface.desk = surface.paper;
    paintBackground(ctx, page.backgroundConfig, clip, sheet, opts.theme, surface);
  }
  const ropts = { theme: opts.theme, zoomBucket: opts.zoomBucket, pdfTiles: opts.pdfTiles, textBitmaps: opts.textBitmaps };
  for (const el of renderOrder(elements)) drawElement(ctx, el, ropts);
}
