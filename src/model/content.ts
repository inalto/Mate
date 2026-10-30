// Typed views of `Element.content` per element type (phase 2 rich content), and the boxed-type set.
// `content` is untyped JSON from storage: read it through `contentOf`, never by casting directly.
import type { Vec2 } from "../canvas/camera";
import type { GraphData } from "../graph/data";
import type { MindmapLayoutMode } from "../mindmap/layout";
import type { MindmapStyle } from "../mindmap/styles";
import type { MindNode } from "../mindmap/tree";
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

/**
 * Card look of a text box (a sticky note). `background` is a note swatch id ("yellow") resolved per
 * theme at render time (components/noteColors), or a "#rrggbb" colour used as-is.
 */
export interface CardStyle {
  background: string;
  radius: 0 | 8 | 16;
  shadow: "none" | "soft" | "paper";
  border: boolean;
}

export const CARD_RADII: readonly CardStyle["radius"][] = [0, 8, 16];
export const CARD_SHADOWS: readonly CardStyle["shadow"][] = ["none", "soft", "paper"];
/** Inner padding of a card box (page units): the text sits this far inside the card. */
export const CARD_PADDING = 12;

/** text-box (`boxWidth/boxHeight` top-level). Typed math is a text-box with subtype "math". */
export interface TextBoxContent extends ContentMeta {
  card?: CardStyle;
  contentHtml: string;
  rawContent: string;
  textAttributes: TextAttributes;
  subtype?: "math";
  latex?: string;
}

/** The card style of a text box, normalised (unknown radius or shadow fall back); null when it has none. */
export function cardOf(el: Pick<Element, "type" | "content">): CardStyle | null {
  if (el.type !== "text-box") return null;
  const c = contentOf<{ card?: Partial<CardStyle> | null }>(el).card;
  if (!c || typeof c !== "object" || typeof c.background !== "string" || c.background === "") return null;
  return {
    background: c.background,
    radius: CARD_RADII.includes(c.radius as CardStyle["radius"]) ? (c.radius as CardStyle["radius"]) : 8,
    shadow: CARD_SHADOWS.includes(c.shadow as CardStyle["shadow"]) ? (c.shadow as CardStyle["shadow"]) : "none",
    border: c.border === true,
  };
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

/**
 * frame (`points[0]` top-left, `boxWidth/boxHeight` top-level): a named region. Its children are
 * computed by containment (frames/contain), never stored. `background` unset paints the paper
 * tinted 4 % towards the ink colour; `order` is its place in a presentation.
 */
export interface FrameContent extends ContentMeta {
  title: string;
  background?: string;
  order: number;
}

/**
 * mindmap (`points[0]` = the root node's centre): the whole tree in one element. Node boxes come
 * from the layout (mindmap/layout), never stored. `rotation` is ignored.
 */
export interface MindmapContent extends ContentMeta {
  layout: MindmapLayoutMode;
  style: MindmapStyle;
  root: MindNode;
}

const MINDMAP_LAYOUTS: readonly MindmapLayoutMode[] = ["right", "left", "balance"];
const MINDMAP_STYLE_IDS: readonly MindmapStyle[] = [1, 2, 3, 4];

/**
 * `raw` as a valid `MindNode` (the same object when it already is one), or null when it has no
 * string id or that id was seen already. A missing text reads as "", bad children are dropped.
 */
function cleanMindNode(raw: unknown, seen: Set<string>): MindNode | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const n = raw as Partial<Record<keyof MindNode, unknown>>;
  if (typeof n.id !== "string" || n.id === "" || seen.has(n.id)) return null;
  seen.add(n.id);
  const list = Array.isArray(n.children) ? (n.children as unknown[]) : [];
  const children: MindNode[] = [];
  let same = Array.isArray(n.children) && typeof n.text === "string";
  for (const c of list) {
    const k = cleanMindNode(c, seen);
    if (k) children.push(k);
    if (k !== c) same = false;
  }
  if (n.collapsed !== undefined && typeof n.collapsed !== "boolean") same = false;
  if (n.color !== undefined && typeof n.color !== "string") same = false;
  if (same) return raw as MindNode;
  const out: MindNode = { id: n.id, text: typeof n.text === "string" ? n.text : "", children };
  if (n.collapsed === true) out.collapsed = true;
  if (typeof n.color === "string") out.color = n.color;
  return out;
}

/**
 * The content of mind map `el`, normalised (unknown layout reads "right", unknown style 1, a bad
 * root a lone empty root; the root keeps its identity when valid); null for other types.
 */
export function mindmapOf(el: Pick<Element, "type" | "content">): MindmapContent | null {
  if (el.type !== "mindmap") return null;
  const c = contentOf<MindmapContent>(el);
  const layout = MINDMAP_LAYOUTS.includes(c.layout as MindmapLayoutMode) ? (c.layout as MindmapLayoutMode) : "right";
  const style = MINDMAP_STYLE_IDS.includes(c.style as MindmapStyle) ? (c.style as MindmapStyle) : 1;
  const root = cleanMindNode(c.root, new Set()) ?? { id: "root", text: "", children: [] };
  return { ...c, layout, style, root };
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
export const BOXED_TYPES: readonly ElementType[] = ["text-box", "table", "codespace", "graph", "image", "media", "frame"];

export const isBoxedType = (t: ElementType): boolean => BOXED_TYPES.includes(t);

/** Container types a connector may also attach to (frames, mind maps) once they exist. */
const ATTACHABLE_CONTAINERS: readonly string[] = ["frame", "mindmap"];

/**
 * True for elements a connector end may bind to: shapes (closed kinds and line/arrow), boxed
 * types, frames and mind maps. Never strokes or connectors. Locks are not checked here.
 */
export const isAttachable = (el: Pick<Element, "type">): boolean =>
  el.type === "shape" || isBoxedType(el.type) || ATTACHABLE_CONTAINERS.includes(el.type);
