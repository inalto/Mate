// PDF page export. Each sheet of a page-mode page becomes a PDF page (or only the current one); a
// canvas-mode page becomes one page sized to its content region. Page units map to points at
// 0.75 pt/unit (CSS px → pt), scaled down so no side exceeds jsPDF's 14 400 pt limit.
//
// Drawn as vectors with jsPDF: background (paper + pattern), ink (pen/pencil capsule runs as
// stroked polylines with round caps, fountain-pen/highlighter outlines as filled paths), shapes and
// graphs (from their PlotScene). Images, text boxes, tables, code and typed math are embedded as
// 2× bitmaps of their usual rendering. With `searchable`, text boxes add their raw text as an
// invisible text layer (render mode 3) over their box.
//
// Sheets backed by an imported PDF keep the original PDF page: the annotation layer is rendered
// with jsPDF (no paper, no PDF bitmap), then pdf-lib copies the source page into the output and
// draws that layer on top as an embedded page. A source that cannot be read falls back to drawing
// the page as a bitmap on an ordinary sheet.
import { GState, jsPDF } from "jspdf";
import { degrees, PDFDocument, type PDFPage } from "pdf-lib";
import { getStroke } from "perfect-freehand";
import { buildBackgroundPattern, type Rect } from "../canvas/background";
import { sheetSize } from "../canvas/camera";
import { graphScene } from "../renderers/graph";
import { capsuleRuns } from "../ink/capsuleRuns";
import { traceSmoothPolygon } from "../ink/render";
import { simplifyEpsForZoom } from "../ink/resample";
import { detectRealPressure, penParams, strokeDiscs } from "../ink/strokePoints";
import { mapInkColor } from "../ink/theme";
import type { ThemeName } from "../ink/types";
import { readAsset } from "../ipc/assets";
import { PAGE_GAP } from "../model/constants";
import { contentOf, isPdfPlacement, type ImageContent } from "../model/content";
import type { Element, Page } from "../model/types";
import { preparePdfPages, type PdfTileSet } from "../pdf/render";
import { PLACEHOLDER_COLOR } from "../renderers/boxDraw";
import "../renderers/builtins";
import { drawElement } from "../renderers/registry";
import { fillOpacityOf, hasFill, isClosedShape, shapeElementOutline } from "../shapes/geometry";
import { useSettingsStore } from "../stores/settings";
import { LINE_HEIGHT } from "../text/style";
import { textContentOf } from "../text/textBox";
import { boxRect, contentMeta, elementBounds, rectsOverlap, withMeta } from "../tools/spatialIndex";
import { renderOrder } from "../tools/zorder";
import { exportRegion, pageElements, surfaceFor } from "./scene";

/** Points per page unit (page units are CSS pixels). */
export const PT_PER_UNIT = 0.75;
/** Largest page side jsPDF writes (PDF implementation limit, 200 in). */
export const MAX_PDF_PAGE_PT = 14_400;
/** Bitmaps (images, text boxes, tables, code, math) are embedded at this many pixels per unit. */
export const PDF_RASTER_SCALE = 2;
const MAX_RASTER_SIDE = 4096;
/** Sheets drawn between yields to the event loop. */
const SHEETS_PER_YIELD = 10;

export interface PdfExportOptions {
  theme: ThemeName;
  background: "plain" | "transparent";
  /** Every sheet, or only `currentSheet` (page mode; canvas pages are always one page). */
  pages: "all" | "current";
  /** 0-based sheet index for `pages: "current"`. */
  currentSheet?: number;
  /** Add an invisible text layer from text boxes. */
  searchable: boolean;
  /** Deflate page content (default true; tests read the raw operators). */
  compress?: boolean;
}

export interface PdfDeps {
  /** Bytes of a stored PDF asset. */
  readPdfBytes(assetId: string): Promise<Uint8Array>;
  /** `el` (unrotated) drawn into a bitmap of its box at the raster scale; null when unavailable. */
  rasterize(el: Element, theme: ThemeName, pdfTiles: PdfTileSet): HTMLCanvasElement | null;
  /** Bitmaps of the PDF placements drawn as pictures (not kept as original pages). */
  rasterPdfPages(placements: Element[]): Promise<PdfTileSet>;
}

/** `el` drawn by its renderer into a canvas covering its box (rotation dropped: applied by the PDF). */
function rasterizeElement(el: Element, theme: ThemeName, pdfTiles: PdfTileSet): HTMLCanvasElement | null {
  const r = boxRect(el);
  if (!(r.width > 0 && r.height > 0)) return null;
  const scale = Math.min(PDF_RASTER_SCALE, MAX_RASTER_SIDE / Math.max(r.width, r.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(r.width * scale));
  canvas.height = Math.max(1, Math.ceil(r.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(canvas.width / r.width, canvas.height / r.height);
  ctx.translate(-r.x, -r.y);
  drawElement(ctx, contentMeta(el).rotation ? withMeta(el, { rotation: 0 }) : el, { theme, zoomBucket: scale, pdfTiles });
  return canvas;
}

export const defaultPdfDeps: PdfDeps = {
  readPdfBytes: readAsset,
  rasterize: rasterizeElement,
  rasterPdfPages: (placements) => preparePdfPages(placements, PDF_RASTER_SCALE, { keep: true }),
};

// ---- colours ----

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()`; anything else is black. */
export function parseColor(css: string): Rgba {
  const s = css.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length === 6 || h.length === 8) {
      const v = (i: number) => parseInt(h.slice(i, i + 2), 16);
      return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? v(6) / 255 : 1 };
    }
  }
  m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const [r, g, b, a] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if ([r, g, b].every(Number.isFinite)) return { r, g, b, a: Number.isFinite(a) ? a : 1 };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

// ---- layout ----

interface Backing {
  assetId: string;
  /** 1-based page of the source PDF. */
  page: number;
  /** The placement's box (page units). */
  box: Rect;
  elementId: string;
}

interface Sheet {
  /** World rectangle exported as this PDF page. */
  rect: Rect;
  /** Points per page unit on this PDF page. */
  k: number;
  backing: Backing | null;
}

const fitK = (r: Rect): number => Math.min(PT_PER_UNIT, MAX_PDF_PAGE_PT / Math.max(1, r.width), MAX_PDF_PAGE_PT / Math.max(1, r.height));

function backingOf(el: Element): Backing | null {
  const c = contentOf<ImageContent>(el);
  if (typeof c.pdfSourceKey !== "string") return null;
  const page = typeof c.pdfPageIndex === "number" && c.pdfPageIndex >= 1 ? Math.floor(c.pdfPageIndex) : 1;
  return { assetId: c.pdfSourceKey, page, box: boxRect(el), elementId: el.id };
}

/** The sheets to export, with the PDF placement each page-mode sheet is backed by (if any). */
function layoutSheets(page: Page, list: Element[], opts: PdfExportOptions): Sheet[] {
  const aspect = useSettingsStore.getState().settings.defaultPageAspectRatio;
  if (page.mode !== "page") {
    const { region } = exportRegion(page, list, aspect);
    return [{ rect: region, k: fitK(region), backing: null }];
  }
  const { sheet } = exportRegion(page, list, aspect);
  const { width, height } = sheetSize(page, aspect);
  const stride = height + PAGE_GAP;
  const count = sheet.count ?? 1;
  const indices =
    opts.pages === "current" ? [Math.max(0, Math.floor(opts.currentSheet ?? 0))] : Array.from({ length: count }, (_, i) => i);
  const placements = list.filter(isPdfPlacement);
  return indices.map((i) => {
    const rect = { x: 0, y: i * stride, width, height };
    const holder = placements.find((p) => {
      const b = boxRect(p);
      return b.y >= rect.y - 0.5 && b.y < rect.y + height && b.width > 0 && b.height > 0;
    });
    return { rect, k: fitK(rect), backing: holder ? backingOf(holder) : null };
  });
}

// ---- drawing ----

type Pt = [number, number];

/** Draws world-space geometry onto the current jsPDF page. */
class Painter {
  private opacity = 1;
  readonly pdf: jsPDF;
  private map: (x: number, y: number) => Pt;
  readonly k: number;

  constructor(pdf: jsPDF, map: (x: number, y: number) => Pt, k: number) {
    this.pdf = pdf;
    this.map = map;
    this.k = k;
  }

  /** Run `fn` with points mapped through `inner` first (box-local → world). */
  within(inner: (x: number, y: number) => Pt, fn: () => void): void {
    const outer = this.map;
    this.map = (x, y) => {
      const [wx, wy] = inner(x, y);
      return outer(wx, wy);
    };
    try {
      fn();
    } finally {
      this.map = outer;
    }
  }

  pt(x: number, y: number): Pt {
    return this.map(x, y);
  }

  setOpacity(a: number): void {
    const v = Math.max(0, Math.min(1, a));
    if (v === this.opacity) return;
    this.opacity = v;
    this.pdf.setGState(new GState({ opacity: v, "stroke-opacity": v }));
  }

  /** Fill and stroke colours (alpha multiplies `opacity`). */
  colour(css: string, which: "fill" | "draw" | "text", opacity = 1): void {
    const c = parseColor(css);
    if (which === "fill") this.pdf.setFillColor(c.r, c.g, c.b);
    else if (which === "draw") this.pdf.setDrawColor(c.r, c.g, c.b);
    else this.pdf.setTextColor(c.r, c.g, c.b);
    this.setOpacity(c.a * opacity);
  }

  moveTo(x: number, y: number): void {
    const [px, py] = this.map(x, y);
    this.pdf.moveTo(px, py);
  }

  lineTo(x: number, y: number): void {
    const [px, py] = this.map(x, y);
    this.pdf.lineTo(px, py);
  }

  polyline(points: ReadonlyArray<{ x: number; y: number }>, closed: boolean): void {
    points.forEach((p, i) => (i === 0 ? this.moveTo(p.x, p.y) : this.lineTo(p.x, p.y)));
    if (closed) this.pdf.close();
  }

  circle(x: number, y: number, r: number): void {
    const [px, py] = this.map(x, y);
    this.pdf.circle(px, py, r * this.k, "F");
  }

  /** A `traceSmoothPolygon` sink emitting cubic Béziers (PDF has no quadratic curves). */
  smoothSink() {
    let cx = 0;
    let cy = 0;
    return {
      moveTo: (x: number, y: number) => {
        cx = x;
        cy = y;
        this.moveTo(x, y);
      },
      quadraticCurveTo: (qx: number, qy: number, x: number, y: number) => {
        const [c1x, c1y] = this.map(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy));
        const [c2x, c2y] = this.map(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y));
        const [ex, ey] = this.map(x, y);
        this.pdf.curveTo(c1x, c1y, c2x, c2y, ex, ey);
        cx = x;
        cy = y;
      },
      closePath: () => {
        this.pdf.close();
      },
    };
  }
}

function paintBackground(p: Painter, page: Page, sheet: Sheet, theme: ThemeName): void {
  const { rect } = sheet;
  const aspect = useSettingsStore.getState().settings.defaultPageAspectRatio;
  p.colour(surfaceFor(theme).paper, "fill");
  const [x, y] = p.pt(rect.x, rect.y);
  p.pdf.rect(x, y, rect.width * p.k, rect.height * p.k, "F");
  const bg =
    page.mode === "page"
      ? { mode: "page" as const, ...sheetSize(page, aspect) }
      : { mode: "canvas" as const, width: rect.width, height: rect.height };
  const { lines, dots } = buildBackgroundPattern(page.backgroundConfig, rect, bg, theme);
  p.pdf.setLineCap("butt");
  for (const l of lines) {
    p.colour(l.color, "draw");
    p.pdf.setLineWidth(l.width * p.k);
    p.moveTo(l.x1, l.y1);
    p.lineTo(l.x2, l.y2);
    p.pdf.stroke();
  }
  for (const d of dots) {
    p.colour(d.color, "fill");
    p.circle(d.x, d.y, d.r);
  }
  p.setOpacity(1);
}

function paintStroke(p: Painter, el: Element, theme: ThemeName): void {
  const pts = el.points;
  if (pts.length === 0) return;
  const style = el.penStyle ?? (el.isHighlighter ? "highlighter" : "pen");
  const color = mapInkColor(el.color, theme);
  const alpha = style === "highlighter" ? 0.5 : 1;
  p.colour(color, "fill", alpha);
  p.colour(color, "draw", alpha);
  if (pts.length === 1) {
    p.circle(pts[0].x, pts[0].y, Math.max(el.width / 2, 0.4));
    return;
  }
  const params = penParams(style, el.width, detectRealPressure(pts));
  if (params.outline) {
    const poly = getStroke(
      pts.map((q) => [q.x, q.y, q.pressure]),
      { ...params, last: true },
    );
    if (poly.length > 0) {
      traceSmoothPolygon(p.smoothSink(), poly);
      p.pdf.fill();
    }
    return;
  }
  p.pdf.setLineCap("round");
  p.pdf.setLineJoin("round");
  // Export scale for the width tolerance: the PDF is vector, so use the 2× export bucket.
  for (const run of capsuleRuns(strokeDiscs(pts, params), simplifyEpsForZoom(PDF_RASTER_SCALE))) {
    const xy = run.xy;
    if (xy.length === 2) {
      p.circle(xy[0], xy[1], run.width / 2);
      continue;
    }
    p.moveTo(xy[0], xy[1]);
    for (let i = 2; i < xy.length; i += 2) p.lineTo(xy[i], xy[i + 1]);
    p.pdf.setLineWidth(run.width * p.k);
    p.pdf.stroke();
  }
}

function paintShape(p: Painter, el: Element, theme: ThemeName): void {
  const [main, head] = shapeElementOutline(el);
  if (!main || main.length === 0) return;
  const closed = isClosedShape(el.shapeType ?? "rectangle");
  const stroke = mapInkColor(el.color, theme);
  const opacity = fillOpacityOf(el);
  p.pdf.setLineCap("round");
  p.pdf.setLineJoin("round");
  p.pdf.setLineWidth(el.width * p.k);
  if (closed && hasFill(el.fillColor) && opacity > 0) {
    p.colour(mapInkColor(el.fillColor, theme), "fill", opacity);
    p.polyline(main, true);
    p.pdf.fill();
  }
  p.colour(stroke, "draw");
  p.polyline(main, closed);
  p.pdf.stroke();
  if (head) {
    p.colour(stroke, "fill");
    p.polyline(head, true);
    p.pdf.fillStroke();
  }
}

/** Maps box-local (unrotated) coordinates of `el` to world coordinates, rotation applied. */
function boxLocal(el: Element): (x: number, y: number) => Pt {
  const r = boxRect(el);
  const rot = contentMeta(el).rotation ?? 0;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return (x, y) => {
    const dx = r.x + x - cx;
    const dy = r.y + y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  };
}

function paintGraph(p: Painter, el: Element, theme: ThemeName): void {
  const r = boxRect(el);
  if (!(r.width > 0 && r.height > 0)) return;
  const scene = graphScene(el, theme);
  const rotDeg = ((contentMeta(el).rotation ?? 0) * 180) / Math.PI;
  p.within(boxLocal(el), () => {
    p.colour(scene.colors.background, "fill");
    p.polyline(
      [
        { x: 0, y: 0 },
        { x: scene.w, y: 0 },
        { x: scene.w, y: scene.h },
        { x: 0, y: scene.h },
      ],
      true,
    );
    p.pdf.fill();
    p.pdf.setLineCap("butt");
    const lines = (ls: typeof scene.grid, color: string, width: number) => {
      if (ls.length === 0) return;
      p.colour(color, "draw");
      p.pdf.setLineWidth(width * p.k);
      for (const l of ls) {
        p.moveTo(l.a.x, l.a.y);
        p.lineTo(l.b.x, l.b.y);
      }
      p.pdf.stroke();
    };
    lines(scene.grid, scene.colors.grid, 1);
    lines(scene.axes, scene.colors.axis, 1.25);
    p.pdf.setLineCap("round");
    p.pdf.setLineJoin("round");
    p.pdf.setLineWidth(2 * p.k);
    for (const c of scene.curves) {
      if (c.polyline.length < 2) continue;
      p.colour(c.color, "draw");
      p.polyline(c.polyline, false);
      p.pdf.stroke();
    }
    p.pdf.setFont("courier", "normal");
    p.pdf.setFontSize(11 * p.k);
    p.colour(scene.colors.text, "text");
    for (const t of scene.labels) {
      const [x, y] = p.pt(t.x, t.y);
      p.pdf.text(t.text, x, y, { align: t.align, baseline: t.baseline, angle: rotDeg ? -rotDeg : undefined });
    }
  });
}

/** Place a bitmap in `el`'s box, rotated about the box centre like the canvas does. */
function placeBitmap(p: Painter, el: Element, bmp: HTMLCanvasElement, alias: string): void {
  const r = boxRect(el);
  const rot = contentMeta(el).rotation ?? 0;
  const w = r.width * p.k;
  const h = r.height * p.k;
  if (!rot) {
    const [x, y] = p.pt(r.x, r.y);
    p.pdf.addImage(bmp, "PNG", x, y, w, h, alias, "FAST");
    return;
  }
  // jsPDF rotates counter-clockwise about the bottom-left corner: find where that corner lands.
  const [bx, by] = p.pt(...boxLocal(el)(0, r.height));
  p.pdf.addImage(bmp, "PNG", bx, by - h, w, h, alias, "FAST", (-rot * 180) / Math.PI);
}

function paintPlaceholder(p: Painter, el: Element): void {
  const r = boxRect(el);
  p.colour(PLACEHOLDER_COLOR, "draw");
  p.pdf.setLineWidth(0.5);
  p.within(boxLocal(el), () =>
    p.polyline(
      [
        { x: 0, y: 0 },
        { x: r.width, y: 0 },
        { x: r.width, y: r.height },
        { x: 0, y: r.height },
      ],
      true,
    ),
  );
  p.pdf.stroke();
}

/** Latin-1 only: the standard PDF fonts cannot encode anything else. */
const latin1 = (s: string): string => s.replace(/[^\x20-\x7e\xa0-\xff]/g, " ");

function paintTextLayer(p: Painter, el: Element): void {
  const c = textContentOf(el);
  const lines = c.rawContent.split(/\r?\n/);
  if (!lines.some((l) => l.trim() !== "")) return;
  const r = boxRect(el);
  const size = c.textAttributes.fontSize;
  p.pdf.setFont("helvetica", "normal");
  p.pdf.setFontSize(size * p.k);
  lines.forEach((line, i) => {
    const text = latin1(line);
    if (text.trim() === "") return;
    const [x, y] = p.pt(r.x, r.y + i * size * LINE_HEIGHT);
    p.pdf.text(text, x, y, { baseline: "top", renderingMode: "invisible" });
  });
}

interface SheetContext {
  page: Page;
  list: Element[];
  opts: PdfExportOptions;
  deps: PdfDeps;
  pdfTiles: PdfTileSet;
  /** Bitmaps by `id|theme` (an element on two sheets of the same theme is rasterised once). */
  bitmaps: Map<string, HTMLCanvasElement | null>;
}

function paintSheet(pdf: jsPDF, sheet: Sheet, ctx: SheetContext): void {
  const { rect, k, backing } = sheet;
  const p = new Painter(pdf, (x, y) => [(x - rect.x) * k, (y - rect.y) * k], k);
  // A PDF-backed sheet keeps the original page: light ink over it, no paper.
  const theme: ThemeName = backing ? "light" : ctx.opts.theme;
  if (!backing && ctx.opts.background === "plain") paintBackground(p, ctx.page, sheet, theme);
  const onSheet = ctx.list.filter((el) => el.id !== backing?.elementId && rectsOverlap(elementBounds(el), rect));
  for (const el of renderOrder(onSheet)) {
    switch (el.type) {
      case "stroke":
        paintStroke(p, el, theme);
        break;
      case "shape":
        paintShape(p, el, theme);
        break;
      case "graph":
        paintGraph(p, el, theme);
        break;
      default: {
        const key = `${el.id}|${theme}`; // backed sheets draw in light, others in the export theme
        let bmp = ctx.bitmaps.get(key);
        if (bmp === undefined) {
          bmp = ctx.deps.rasterize(el, theme, ctx.pdfTiles);
          ctx.bitmaps.set(key, bmp);
        }
        if (bmp) placeBitmap(p, el, bmp, `${el.id}|${theme}`);
        else paintPlaceholder(p, el);
      }
    }
    p.setOpacity(1);
  }
  if (ctx.opts.searchable) for (const el of onSheet) if (el.type === "text-box") paintTextLayer(p, el);
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve));

/** Load each distinct source PDF once; sheets whose source or page is unusable lose their backing. */
async function loadSources(sheets: Sheet[], deps: PdfDeps): Promise<Map<string, PDFDocument>> {
  const docs = new Map<string, PDFDocument | null>();
  for (const s of sheets) {
    const b = s.backing;
    if (!b) continue;
    if (!docs.has(b.assetId)) {
      try {
        docs.set(b.assetId, await PDFDocument.load(await deps.readPdfBytes(b.assetId), { updateMetadata: false }));
      } catch {
        docs.set(b.assetId, null);
      }
    }
    const doc = docs.get(b.assetId);
    if (!doc || b.page > doc.getPageCount()) s.backing = null;
  }
  const ok = new Map<string, PDFDocument>();
  for (const [id, d] of docs) if (d) ok.set(id, d);
  return ok;
}

export interface OverlayPlacement {
  /** Anchor of the layer's bottom-left corner in the page's user space (points). */
  x: number;
  y: number;
  /** Counter-clockwise turn about the anchor, degrees. */
  rotate: number;
  /** Output points per page unit. */
  scale: number;
}

/**
 * Where a sheet's annotation layer goes on the original PDF page so that, as displayed (`/Rotate`
 * applied, crop box origin honoured), the placement `box` covers the page exactly and the layer
 * reads upright. `rotation` is the page's `/Rotate` in degrees.
 */
export function overlayPlacement(rotation: number, crop: Rect, box: Rect, sheet: Rect): OverlayPlacement {
  const rot = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
  const { x: cx, y: cy, width: W, height: H } = crop;
  const [dw, dh] = rot === 90 || rot === 270 ? [H, W] : [W, H];
  const scale = dw / Math.max(1e-9, box.width);
  // The layer's bottom-left corner in display coordinates (origin bottom-left, y up).
  const X = -(box.x - sheet.x) * scale;
  const Y = dh + (box.y - sheet.y) * scale - sheet.height * scale;
  const [x, y] =
    rot === 90 ? [cx + W - Y, cy + X] : rot === 180 ? [cx + W - X, cy + H - Y] : rot === 270 ? [cx + Y, cy + H - X] : [cx + X, cy + Y];
  return { x, y, rotate: rot, scale };
}

/** Output with original pages under the annotation layers of backed sheets. */
async function compose(layers: Uint8Array, sheets: Sheet[], sources: Map<string, PDFDocument>): Promise<Uint8Array> {
  const overlay = await PDFDocument.load(layers);
  const out = await PDFDocument.create();
  const plain = sheets.map((s, i) => (s.backing ? -1 : i)).filter((i) => i >= 0);
  const copiedPlain = new Map<number, PDFPage>();
  (await out.copyPages(overlay, plain)).forEach((pg, j) => copiedPlain.set(plain[j], pg));
  const backed = sheets.map((s, i) => (s.backing ? i : -1)).filter((i) => i >= 0);
  const embedded = await out.embedPages(backed.map((i) => overlay.getPage(i)));
  // One copy call per source so shared resources (fonts, images) are copied once.
  const originals = new Map<number, PDFPage>();
  for (const [assetId, doc] of sources) {
    const mine = backed.filter((i) => sheets[i].backing!.assetId === assetId);
    if (mine.length === 0) continue;
    const pages = await out.copyPages(
      doc,
      mine.map((i) => sheets[i].backing!.page - 1),
    );
    pages.forEach((pg, j) => originals.set(mine[j], pg));
  }
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i];
    if (!s.backing) {
      out.addPage(copiedPlain.get(i)!);
      continue;
    }
    const pg = out.addPage(originals.get(i)!);
    const a = overlayPlacement(pg.getRotation().angle, pg.getCropBox(), s.backing.box, s.rect);
    const xy = a.scale / s.k; // layer points → output points
    pg.drawPage(embedded[backed.indexOf(i)], { x: a.x, y: a.y, xScale: xy, yScale: xy, rotate: degrees(a.rotate) });
    if ((i + 1) % SHEETS_PER_YIELD === 0) await yieldToUi();
  }
  return out.save();
}

/** The PDF of `page`. Text-box bitmaps and images must already be prepared (see exportPage). */
export async function renderToPdf(
  elements: Iterable<Element>,
  page: Page,
  opts: PdfExportOptions,
  deps: PdfDeps = defaultPdfDeps,
): Promise<Uint8Array> {
  const list = pageElements(page, elements);
  const sheets = layoutSheets(page, list, opts);
  const sources = await loadSources(sheets, deps);
  const kept = new Set(sheets.map((s) => s.backing?.elementId).filter(Boolean));
  const rasterPlacements = list.filter((el) => isPdfPlacement(el) && !kept.has(el.id));
  const pdfTiles = rasterPlacements.length > 0 ? await deps.rasterPdfPages(rasterPlacements) : new Map<string, never>();

  const size = (s: Sheet): [number, number] => [Math.max(1, s.rect.width * s.k), Math.max(1, s.rect.height * s.k)];
  const orient = ([w, h]: [number, number]) => (w > h ? "landscape" : "portrait");
  const first = size(sheets[0]);
  const pdf = new jsPDF({ unit: "pt", format: first, orientation: orient(first), compress: opts.compress ?? true });
  const ctx: SheetContext = { page, list, opts, deps, pdfTiles, bitmaps: new Map() };
  for (let i = 0; i < sheets.length; i++) {
    if (i > 0) {
      const sz = size(sheets[i]);
      pdf.addPage(sz, orient(sz));
    }
    paintSheet(pdf, sheets[i], ctx);
    if ((i + 1) % SHEETS_PER_YIELD === 0) await yieldToUi();
  }
  const layers = new Uint8Array(pdf.output("arraybuffer"));
  if (!sheets.some((s) => s.backing)) return layers;
  return compose(layers, sheets, sources);
}
