// Typed views of `Element.content` per element type (phase 2 rich content), and the boxed-type set.
// `content` is untyped JSON from storage: read it through `contentOf`, never by casting directly.
import type { GraphData } from "../graph/data";
import type { Element, ElementType } from "./types";

/** Metadata any element's content may carry (see spatialIndex.contentMeta). */
interface ContentMeta {
  zIndex?: number;
  /** Radians about the box centre. */
  rotation?: number;
}

export interface TextAttributes {
  fontFamily: string;
  fontSize: number;
  color: string;
  align: "left" | "center" | "right" | "justify";
}

/** text-box (`boxWidth/boxHeight` top-level). Typed math is a text-box with subtype "math". */
export interface TextBoxContent extends ContentMeta {
  contentHtml: string;
  rawContent: string;
  textAttributes: TextAttributes;
  subtype?: "math";
  latex?: string;
}

export interface TableContent extends ContentMeta {
  subtype: "table";
  tableData: { rows: string[][] };
}

/** The last run of a code block (read through text/tableCode `codeOf`). */
export interface CodeOutput {
  stdout: string;
  stderr: string;
  status: "ok" | "error" | "timeout";
  durationMs: number;
  /** ISO time of the run. */
  ranAt: string;
}

export interface CodespaceContent extends ContentMeta {
  subtype: "codespace";
  code: string;
  language: string;
  output?: CodeOutput;
}

/** graph (`boxWidth/boxHeight` top-level). Read `graphData` through graph/data `graphDataOf`. */
export interface GraphContent extends ContentMeta {
  subtype: "graph";
  graphData: GraphData;
}

/** image (`imageUrl, width, height` top-level). */
export interface ImageContent extends ContentMeta {
  isBW?: boolean;
  /** Fractions (0 to 1) of the source image trimmed from each side. */
  cropTop?: number;
  cropBottom?: number;
  cropLeft?: number;
  cropRight?: number;
  pdfSourceKey?: string;
  pdfPageIndex?: number;
}

/** End decoration of a line or arrow shape. */
export type LineCap = "none" | "arrow" | "dot" | "bar";

export const LINE_CAPS: readonly LineCap[] = ["none", "arrow", "dot", "bar"];

/** Start and end caps of a line/arrow shape. */
export interface LineCaps {
  start: LineCap;
  end: LineCap;
}

/** shape (`shapeType, fillColor, color, width, points` top-level). */
export interface ShapeContent extends ContentMeta {
  fillOpacity: number;
  /** Line/arrow end caps; absent reads as the shape type's default (see `effectiveCaps`). */
  caps?: LineCaps;
}

/** media (`imageUrl` asset id, `width/height` box like images): an audio or video player. */
export interface MediaContent extends ContentMeta {
  kind: "audio" | "video";
  title?: string;
}

/** `el.content` as a partial `T` when it is a JSON object, else `{}`. Never throws. */
export function contentOf<T>(el: Pick<Element, "content">): Partial<T> {
  const c = el.content;
  return c !== null && typeof c === "object" && !Array.isArray(c) ? (c as Partial<T>) : {};
}

const asCap = (v: unknown, fallback: LineCap): LineCap => (LINE_CAPS as readonly unknown[]).includes(v) ? (v as LineCap) : fallback;

/**
 * Caps of a line/arrow shape: stored `content.caps` (unknown values fall back), else the type's
 * default (an arrow ends in an arrow head, a line has none). Other shapes have none.
 */
export function effectiveCaps(el: Pick<Element, "type" | "shapeType" | "content">): LineCaps {
  const legacyEnd: LineCap = el.shapeType === "arrow" ? "arrow" : "none";
  if (el.type !== "shape" || (el.shapeType !== "line" && el.shapeType !== "arrow")) return { start: "none", end: "none" };
  const c = contentOf<ShapeContent>(el).caps;
  if (c === null || typeof c !== "object") return { start: "none", end: legacyEnd };
  return { start: asCap(c.start, "none"), end: asCap(c.end, legacyEnd) };
}

/** z-order of PDF page placements: below everything a user adds (see tools/zorder). */
export const PDF_Z_INDEX = -1_000_000;

/**
 * An `image` element showing a page of an imported PDF. Placements are locked: never hit-tested,
 * lasso-selected, erased, framed or reordered, and always drawn first.
 */
export const isPdfPlacement = (el: Pick<Element, "type" | "content">): boolean =>
  el.type === "image" && typeof contentOf<ImageContent>(el).pdfSourceKey === "string";

/** Element types laid out as a box: `points[0]` is the top-left anchor (page units). */
export const BOXED_TYPES: readonly ElementType[] = ["text-box", "table", "codespace", "graph", "image", "media"];

export const isBoxedType = (t: ElementType): boolean => BOXED_TYPES.includes(t);
