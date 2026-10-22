// Per-element-type renderers: canvas drawing, SVG emission and optional bounds. The canvas, the
// exports and thumbnails all dispatch through here, so every type renders the same everywhere.
// Built-in renderers are registered by ./builtins (imported for its side effect by the scene).
import type { ThemeName } from "../ink/types";
import type { PdfBitmap } from "../pdf/source";
import type { Element, ElementType } from "../model/types";
import type { Rect } from "../tools/spatialIndex";
import type { BoxBitmap, BoxSnapshotCache } from "./boxSnapshot";

export interface RenderOptions {
  theme: ThemeName;
  /** Output scale (device pixels per page unit; the live canvas passes the camera zoom). */
  zoomBucket: number;
  /** Device pixels per CSS pixel of the live canvas (default 1: exports already include it). */
  pixelRatio?: number;
  /** Snapshot source for boxed elements (default: the shared `boxSnapshots`). */
  snapshots?: BoxSnapshotCache;
  /** PDF page bitmaps prepared for this paint, by `pdfPageKey` (exports, thumbnails); else the live tile cache. */
  pdfTiles?: ReadonlyMap<string, PdfBitmap>;
  /**
   * Text-box / table / code bitmaps prepared for this paint, by `id|theme` (exports). When set, those
   * boxes are drawn from it only: never from a bitmap published for another theme, and a missing
   * one throws instead of drawing the placeholder.
   */
  textBitmaps?: ReadonlyMap<string, BoxBitmap>;
  /**
   * SVG export: collects the document-wide stylesheets the emitted markup needs (e.g. "katex"),
   * embedded once in `<defs>` instead of in every element.
   */
  svgStyles?: Set<string>;
}

export interface ElementRenderer {
  /** Draw `el` in page units; the context already carries the world transform. */
  draw(ctx: CanvasRenderingContext2D, el: Element, opts: RenderOptions): void;
  /** SVG markup for `el` in page units ("" for nothing). */
  svg(el: Element, opts: RenderOptions): string;
  /** World bounds before rotation, when the generic rules (spatialIndex.elementBounds) do not fit. */
  bounds?(el: Element): Rect;
}

const renderers = new Map<ElementType, ElementRenderer>();

/** Register the renderer for `type` (replacing any previous one); returns an unregister function. */
export function registerRenderer(type: ElementType, r: ElementRenderer): () => void {
  renderers.set(type, r);
  return () => {
    if (renderers.get(type) === r) renderers.delete(type);
  };
}

export const rendererFor = (type: ElementType): ElementRenderer | undefined => renderers.get(type);

/** Draw `el` with its type's renderer; types without one are skipped. */
export function drawElement(ctx: CanvasRenderingContext2D, el: Element, opts: RenderOptions): void {
  renderers.get(el.type)?.draw(ctx, el, opts);
}

/** SVG for `el` with its type's renderer; "" for types without one. */
export const elementSvg = (el: Element, opts: RenderOptions): string => renderers.get(el.type)?.svg(el, opts) ?? "";
