// Typed views of `Element.content` per element type (phase 2 rich content), and the boxed-type set.
// `content` is untyped JSON from storage: read it through `contentOf`, never by casting directly.
import type { Vec2 } from "../canvas/camera";
import type { GraphData } from "../graph/data";
import type { Element, ElementType } from "./types";

/** Metadata any element's content may carry (see spatialIndex.contentMeta). */
interface ContentMeta {
  zIndex?: number;
  /** Radians about the box centre. */
  rotation?: number;
  /** Never moved, resized, rotated, restyled, erased, deleted, aligned, grouped or lasso-picked. */
  locked?: boolean;
}

/** True for an element the user locked (`content.locked`); copies of it are unlocked. */
export const isLocked = (el: Pick<Element, "content">): boolean => contentOf<ContentMeta>(el).locked === true;

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

/** End decoration of a line or arrow shape, or of a connector (connectors also take "diamond"). */
export type LineCap = "none" | "arrow" | "dot" | "bar" | "diamond";

/** Caps offered by the line-ends picker for line/arrow shapes (connectors add "diamond"). */
export const LINE_CAPS: readonly Exclude<LineCap, "diamond">[] = ["none", "arrow", "dot", "bar"];

/** Every cap kind: the picker's caps plus a filled diamond (connectors). */
export const CONNECTOR_CAPS: readonly LineCap[] = [...LINE_CAPS, "diamond"];

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

/** A side of an element's (rotated) bounds, where a connector end attaches. */
export type Side = "top" | "right" | "bottom" | "left";

/** A connector end bound to element `id`; "auto" picks the side facing the other end on every reroute. */
export interface ConnectorEnd {
  id: string;
  side: Side | "auto";
}

/**
 * connector (`points` = [start, end] absolute endpoints, always current; `color`, `width` the
 * stroke). `route` caches the routed polyline in page units (curves flattened), so rendering,
 * bounds and hit tests read the connector alone. `rotation` is ignored.
 */
export interface ConnectorContent extends ContentMeta {
  mode: "straight" | "curve" | "elbow";
  source?: ConnectorEnd;
  target?: ConnectorEnd;
  caps: LineCaps;
  dash?: "solid" | "dashed";
  /** `t` in [0, 1] along the route. */
  label?: { text: string; t: number };
  route: Vec2[];
}

/** `el.content` as a partial `T` when it is a JSON object, else `{}`. Never throws. */
export function contentOf<T>(el: Pick<Element, "content">): Partial<T> {
  const c = el.content;
  return c !== null && typeof c === "object" && !Array.isArray(c) ? (c as Partial<T>) : {};
}

const asCap = (v: unknown, fallback: LineCap): LineCap => (CONNECTOR_CAPS as readonly unknown[]).includes(v) ? (v as LineCap) : fallback;

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

/** Container types a connector may also attach to (frames, mind maps) once they exist. */
const ATTACHABLE_CONTAINERS: readonly string[] = ["frame", "mindmap"];

/**
 * True for elements a connector end may bind to: shapes (closed kinds and line/arrow), boxed
 * types, frames and mind maps. Never strokes or connectors. Locks are not checked here.
 */
export const isAttachable = (el: Pick<Element, "type">): boolean =>
  el.type === "shape" || isBoxedType(el.type) || ATTACHABLE_CONTAINERS.includes(el.type);
