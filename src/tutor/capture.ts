// Stroke-group capture: renders one group's ink, alone, on white, to a PNG for the AI check.
// The image is always light (dark-theme colours map back to the light palette) and sized so its
// area is about 72 000 px², whatever the zoom or the size of the writing.
import { renderStroke } from "../ink/render";
import { toLightInk } from "../ink/theme";
import type { Element, GroupBounds } from "../model/types";
import type { Rect } from "../tools/spatialIndex";
import type { Region } from "./types";

export const CAPTURE_PADDING = 24;
export const CAPTURE_TARGET_AREA = 72_000;
export const CAPTURE_MAX_DIMENSION = 2048;
export const CAPTURE_MAX_UPSCALE = 8;

/** A drawing surface plus its PNG encoder (OffscreenCanvas or a DOM canvas; fakes in tests). */
export interface CaptureCanvas {
  width: number;
  height: number;
  getContext(kind: "2d"): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  encodePng(): Promise<Uint8Array>;
}

export interface CaptureOptions {
  /** World units around the ink (default 24). */
  padding?: number;
  targetArea?: number;
  maxDimension?: number;
  maxUpscale?: number;
  createCanvas?: (width: number, height: number) => CaptureCanvas;
}

export interface CaptureGeometry {
  /** Padded world-space rectangle that the image shows. */
  bounds: GroupBounds;
  /** Pixels per world unit. */
  scale: number;
  width: number;
  height: number;
}

export interface CapturedImage {
  png: Uint8Array;
  /** Padded world-space rectangle that the image shows. */
  bounds: GroupBounds;
  width: number;
  height: number;
}

export function captureGeometry(ink: Rect, opts: CaptureOptions = {}): CaptureGeometry {
  const pad = opts.padding ?? CAPTURE_PADDING;
  const maxDim = opts.maxDimension ?? CAPTURE_MAX_DIMENSION;
  const bounds = { x: ink.x - pad, y: ink.y - pad, width: Math.max(1, ink.width + 2 * pad), height: Math.max(1, ink.height + 2 * pad) };
  let scale = Math.sqrt((opts.targetArea ?? CAPTURE_TARGET_AREA) / (bounds.width * bounds.height));
  scale = Math.min(scale, opts.maxUpscale ?? CAPTURE_MAX_UPSCALE, maxDim / Math.max(bounds.width, bounds.height));
  return {
    bounds,
    scale,
    width: Math.max(1, Math.min(maxDim, Math.round(bounds.width * scale))),
    height: Math.max(1, Math.min(maxDim, Math.round(bounds.height * scale))),
  };
}

function defaultCanvas(width: number, height: number): CaptureCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(width, height);
    // Some engines lack a 2D OffscreenCanvas context or `convertToBlob`: use a DOM canvas then.
    const ctx = c.getContext("2d");
    if (ctx && typeof c.convertToBlob === "function") {
      return {
        width,
        height,
        getContext: () => ctx,
        encodePng: async () => new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer()),
      };
    }
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return {
    width,
    height,
    getContext: () => c.getContext("2d"),
    encodePng: () =>
      new Promise((resolve, reject) =>
        c.toBlob((b) => (b ? b.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject) : reject(new Error("PNG encoding failed"))), "image/png"),
      ),
  };
}

function inkBounds(strokes: Element[]): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of strokes) {
    const r = s.width / 2;
    for (const p of s.points) {
      x0 = Math.min(x0, p.x - r);
      y0 = Math.min(y0, p.y - r);
      x1 = Math.max(x1, p.x + r);
      y1 = Math.max(y1, p.y + r);
    }
  }
  return x0 === Infinity ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The group's own strokes, in drawing order. */
export function groupStrokes(elements: Iterable<Element>, region: Region): Element[] {
  const ids = new Set(region.elementIds);
  const out: Element[] = [];
  for (const e of elements) if (ids.has(e.id) && !e.deletedAt && e.points.length > 0) out.push(e);
  return out;
}

/**
 * Render the group's ink (nothing else) on white and encode it as PNG. Rejects when the group has
 * no ink or the canvas cannot be created.
 */
export async function captureGroupImage(
  elements: Iterable<Element>,
  region: Region,
  opts: CaptureOptions = {},
): Promise<CapturedImage> {
  const strokes = groupStrokes(elements, region);
  const ink = inkBounds(strokes);
  if (!ink) throw new Error("This group has no ink to check.");
  const g = captureGeometry(region.bounds.width > 0 && region.bounds.height > 0 ? region.bounds : ink, opts);
  const canvas = (opts.createCanvas ?? defaultCanvas)(g.width, g.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas available for capture.");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, g.width, g.height);
  ctx.setTransform(g.scale, 0, 0, g.scale, -g.bounds.x * g.scale, -g.bounds.y * g.scale);
  for (const s of strokes) {
    // Light theme rendering with light-palette colours: the image is always dark ink on white.
    renderStroke(ctx as CanvasRenderingContext2D, { ...s, color: toLightInk(s.color) }, "light", g.scale);
  }
  return { png: await canvas.encodePng(), bounds: g.bounds, width: g.width, height: g.height };
}
