// Mind-map layout memo: the layout of a mind-map element plus what painting needs (wrapped lines,
// hidden counts of collapsed nodes, effective branch colours, padded bounds), computed once per
// element revision and text measure. Bounds (spatialIndex), the hit test, the renderer, the PDF
// export and the overlay all read it, so they agree on every node box.
import { mindmapOf, type MindmapContent } from "../model/content";
import type { Element } from "../model/types";
import { FONT_STACKS } from "../text/style";
import type { Rect } from "../tools/spatialIndex";
import { fontSizeFor, layoutMindmap, nodeSize, ROOT_FONT, type Layout, type MeasureText, type NodeBox } from "./layout";
import type { MindNode } from "./tree";

/** "canvas": an OffscreenCanvas 2D `measureText`; "estimate": 0.55 × font size per character. */
export type MeasureKind = "canvas" | "estimate";

/** Font family of mind-map node text (the text boxes' sans stack). */
export const MINDMAP_FONT = FONT_STACKS.sans;
/** Rough character width as a fraction of the font size, when no canvas can measure. */
export const MINDMAP_CHAR_WIDTH = 0.55;
/** Radius of the count badge of a collapsed node (page units). */
export const BADGE_RADIUS = 9;
/** Padding of a mind map's bounds around its layout. */
export const BOUNDS_PAD = 2;

/** CSS font of node text at `fontSize` (the root's 20 px is semi-bold). */
export const mindmapFont = (fontSize: number): string => `${fontSize === ROOT_FONT ? 600 : 400} ${fontSize}px ${MINDMAP_FONT}`;

type Measurer = { font: string; measureText(s: string): { width: number } };
let measurer: Measurer | null | undefined;

function sharedMeasurer(): Measurer | null {
  if (measurer !== undefined) return measurer;
  measurer = null;
  try {
    if (typeof OffscreenCanvas !== "undefined") measurer = new OffscreenCanvas(1, 1).getContext("2d");
  } catch {
    measurer = null;
  }
  return measurer;
}

/** The measure available here: "canvas" when an OffscreenCanvas 2D context exists, else "estimate". */
export const measureKind = (): MeasureKind => (sharedMeasurer() ? "canvas" : "estimate");

/** Text width measure of `kind` (falls back to the estimate when no canvas can measure). */
export function measureFor(kind: MeasureKind): MeasureText {
  const m = kind === "canvas" ? sharedMeasurer() : null;
  if (m) {
    return (s, fontSize) => {
      m.font = mindmapFont(fontSize);
      return m.measureText(s).width;
    };
  }
  return (s, fontSize) => Array.from(s).length * fontSize * MINDMAP_CHAR_WIDTH;
}

export interface MindmapView {
  /** The normalised content the layout was computed from. */
  content: MindmapContent;
  layout: Layout;
  /** Wrapped text lines of every laid-out node. */
  lines: Map<string, string[]>;
  /** Font size of every laid-out node. */
  fontSize: Map<string, number>;
  /** Descendants hidden under each collapsed node that has children. */
  hidden: Map<string, number>;
  /** Branch colour override of every laid-out node (its own `color`, else its branch's), if any. */
  colors: Map<string, string | undefined>;
  /** Layout bounds plus the count badges, padded by `BOUNDS_PAD`. */
  bounds: Rect;
}

/** Centre of the count badge of `box`: the middle of its outer edge. */
export const badgeCentre = (box: NodeBox): { x: number; y: number } => ({
  x: box.side === "left" ? box.x : box.x + box.width,
  y: box.y + box.height / 2,
});

const descendants = (node: MindNode): number => node.children.reduce((n, c) => n + 1 + descendants(c), 0);

function buildView(el: Element, kind: MeasureKind): MindmapView {
  const content = mindmapOf(el) ?? { layout: "right", style: 1, root: { id: "root", text: "", children: [] } };
  const measure = measureFor(kind);
  const a = el.points[0] ?? { x: 0, y: 0 };
  const layout = layoutMindmap(content, { x: a.x, y: a.y }, measure);
  const lines = new Map<string, string[]>();
  const fontSize = new Map<string, number>();
  const hidden = new Map<string, number>();
  const colors = new Map<string, string | undefined>();
  const visit = (node: MindNode, depth: number, inherited: string | undefined) => {
    if (!layout.nodes.has(node.id)) return;
    const size = fontSizeFor(depth);
    fontSize.set(node.id, size);
    lines.set(node.id, nodeSize(node.text, size, measure).lines);
    // The root's colour is its own; a first-level node starts its branch's colour.
    const colour = node.color ?? (depth >= 2 ? inherited : undefined);
    colors.set(node.id, colour);
    if (node.collapsed) {
      if (node.children.length > 0) hidden.set(node.id, descendants(node));
      return;
    }
    for (const c of node.children) visit(c, depth + 1, colour);
  };
  visit(content.root, 0, undefined);
  let { x: minX, y: minY } = layout.bounds;
  let maxX = minX + layout.bounds.width;
  let maxY = minY + layout.bounds.height;
  for (const id of hidden.keys()) {
    const c = badgeCentre(layout.nodes.get(id)!);
    minX = Math.min(minX, c.x - BADGE_RADIUS);
    minY = Math.min(minY, c.y - BADGE_RADIUS);
    maxX = Math.max(maxX, c.x + BADGE_RADIUS);
    maxY = Math.max(maxY, c.y + BADGE_RADIUS);
  }
  const bounds = { x: minX - BOUNDS_PAD, y: minY - BOUNDS_PAD, width: maxX - minX + 2 * BOUNDS_PAD, height: maxY - minY + 2 * BOUNDS_PAD };
  return { content, layout, lines, fontSize, hidden, colors, bounds };
}

interface Memo {
  key: string;
  content: unknown;
  view: MindmapView;
}

const memo = new Map<string, Memo>();
const MAX_MEMO = 512;

/**
 * The (memoised) view of mind map `el` measured with `kind` (default: the best available). The
 * memo is per element id, keyed by `updatedAt`, `version`, the root centre, the measure and the
 * content object, so an edit, a move or an undo always recomputes.
 */
export function mindmapView(el: Element, kind: MeasureKind = measureKind()): MindmapView {
  const a = el.points[0];
  const key = `${el.updatedAt}|${el.version}|${a?.x ?? 0},${a?.y ?? 0}|${kind}`;
  const hit = memo.get(el.id);
  if (hit && hit.key === key && hit.content === el.content) return hit.view;
  const view = buildView(el, kind);
  if (!hit && memo.size >= MAX_MEMO) memo.clear();
  memo.set(el.id, { key, content: el.content, view });
  return view;
}

/** World bounds of mind map `el` (layout plus badges, padded; never rotated). */
export const mindmapBounds = (el: Element): Rect => mindmapView(el).bounds;

/** Forget every memoised layout (tests, font loads). */
export function clearMindmapCache(): void {
  memo.clear();
}
