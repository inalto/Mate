// Mind-map tidy-tree layout (pure, spec D2): node boxes, flattened Bézier edges and bounds for a
// `MindNode` tree centred at `rootCentre`. Text measure is injected (canvas `measureText` in the
// renderer, a fixed-width stub in tests).
import type { Vec2 } from "../canvas/camera";
import { wrapText } from "../text/wrap";
import type { Rect } from "../tools/spatialIndex";
import type { MindNode } from "./tree";

export type MindmapLayoutMode = "right" | "left" | "balance";

/** The parts of a mind map's `content` the layout reads. */
export interface MindmapLayoutInput {
  layout: MindmapLayoutMode;
  root: MindNode;
}

/** Width of `text` at `fontSize` (px). */
export type MeasureText = (text: string, fontSize: number) => number;

export interface NodeBox extends Rect {
  id: string;
  depth: number;
  side: "left" | "right";
  /** First-level branch index (0-based, in child order); -1 for the root. */
  branch: number;
}

export interface Edge {
  from: string;
  to: string;
  path: Vec2[];
}

export interface Layout {
  nodes: Map<string, NodeBox>;
  edges: Edge[];
  bounds: Rect;
}

export const NODE_FONT = 16;
export const ROOT_FONT = 20;
export const LINE_HEIGHT = 1.25;
export const MAX_TEXT_WIDTH = 240;
export const PAD_X = 12;
export const PAD_Y = 8;
export const MIN_WIDTH = 60;
export const MIN_HEIGHT = 32;
export const SIBLING_GAP = 12;
export const LEVEL_GAP = 48;
export const ROOT_GAP = 72;
export const EDGE_SEGMENTS = 16;

export const fontSizeFor = (depth: number): number => (depth === 0 ? ROOT_FONT : NODE_FONT);

/** Box size and wrapped lines of a node's text. Empty text sizes as one (empty) line. */
export function nodeSize(
  text: string,
  fontSize: number,
  measure: MeasureText,
): { width: number; height: number; lines: string[] } {
  const m = (s: string) => measure(s, fontSize);
  const lines = wrapText(text, MAX_TEXT_WIDTH, m);
  const longest = lines.reduce((w, line) => Math.max(w, m(line)), 0);
  const width = Math.min(MAX_TEXT_WIDTH + 2 * PAD_X, Math.max(MIN_WIDTH, longest + 2 * PAD_X));
  const height = Math.max(MIN_HEIGHT, Math.max(1, lines.length) * LINE_HEIGHT * fontSize + 2 * PAD_Y);
  return { width, height, lines: lines.length > 0 ? lines : [""] };
}

const visibleChildren = (node: MindNode): MindNode[] => (node.collapsed ? [] : node.children);

/** Cubic from `a` to `b` with horizontal tangents (controls at 50 % of dx), flattened. */
function edgePath(a: Vec2, b: Vec2): Vec2[] {
  const dx = b.x - a.x;
  const c1 = { x: a.x + dx * 0.5, y: a.y };
  const c2 = { x: b.x - dx * 0.5, y: b.y };
  const out: Vec2[] = [];
  for (let i = 0; i <= EDGE_SEGMENTS; i++) {
    const t = i / EDGE_SEGMENTS;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    out.push({
      x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x,
      y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y,
    });
  }
  out[0] = { ...a };
  out[EDGE_SEGMENTS] = { ...b };
  return out;
}

export function layoutMindmap(content: MindmapLayoutInput, rootCentre: Vec2, measure: MeasureText): Layout {
  const sizes = new Map<string, { width: number; height: number }>();
  const sizeOf = (node: MindNode, depth: number) => {
    let s = sizes.get(node.id);
    if (!s) {
      const { width, height } = nodeSize(node.text, fontSizeFor(depth), measure);
      s = { width, height };
      sizes.set(node.id, s);
    }
    return s;
  };
  const extents = new Map<string, number>();
  /** Vertical extent of a subtree (never smaller than the node's own box). */
  const extentOf = (node: MindNode, depth: number): number => {
    const cached = extents.get(node.id);
    if (cached !== undefined) return cached;
    const own = sizeOf(node, depth).height;
    const kids = visibleChildren(node);
    const span = stackSpan(kids, depth + 1);
    const ext = kids.length === 0 ? own : Math.max(own, span);
    extents.set(node.id, ext);
    return ext;
  };
  const stackSpan = (kids: MindNode[], depth: number): number =>
    kids.reduce((sum, k) => sum + extentOf(k, depth), 0) + SIBLING_GAP * Math.max(0, kids.length - 1);

  const nodes = new Map<string, NodeBox>();
  const edges: Edge[] = [];

  const rootSize = sizeOf(content.root, 0);
  const rootBox: NodeBox = {
    id: content.root.id,
    x: rootCentre.x - rootSize.width / 2,
    y: rootCentre.y - rootSize.height / 2,
    width: rootSize.width,
    height: rootSize.height,
    depth: 0,
    side: content.layout === "left" ? "left" : "right",
    branch: -1,
  };
  nodes.set(rootBox.id, rootBox);

  /** Stack `kids` of `parent` on `side`, centred on the parent's middle, then recurse. */
  const placeChildren = (
    parent: NodeBox,
    kids: { node: MindNode; branch: number }[],
    side: "left" | "right",
    depth: number,
  ) => {
    if (kids.length === 0) return;
    const gap = depth === 1 ? ROOT_GAP : LEVEL_GAP;
    const innerX = side === "right" ? parent.x + parent.width + gap : parent.x - gap;
    const centreY = parent.y + parent.height / 2;
    let top = centreY - stackSpan(kids.map((k) => k.node), depth) / 2;
    const from: Vec2 = { x: side === "right" ? parent.x + parent.width : parent.x, y: centreY };
    for (const { node, branch } of kids) {
      const ext = extentOf(node, depth);
      const size = sizeOf(node, depth);
      const box: NodeBox = {
        id: node.id,
        x: side === "right" ? innerX : innerX - size.width,
        y: top + ext / 2 - size.height / 2,
        width: size.width,
        height: size.height,
        depth,
        side,
        branch,
      };
      nodes.set(node.id, box);
      const to: Vec2 = { x: side === "right" ? box.x : box.x + box.width, y: box.y + box.height / 2 };
      edges.push({ from: parent.id, to: node.id, path: edgePath(from, to) });
      placeChildren(
        box,
        visibleChildren(node).map((c) => ({ node: c, branch })),
        side,
        depth + 1,
      );
      top += ext + SIBLING_GAP;
    }
  };

  const first = visibleChildren(content.root).map((node, branch) => ({ node, branch }));
  const right = first.filter((k) =>
    content.layout === "balance" ? k.branch % 2 === 0 : content.layout !== "left",
  );
  const left = first.filter((k) => !right.includes(k));
  placeChildren(rootBox, right, "right", 1);
  placeChildren(rootBox, left, "left", 1);
  // Edges in tree order (first-level children by index), whatever the side split.
  const treeOrder: string[] = [];
  const collect = (node: MindNode) => {
    treeOrder.push(node.id);
    for (const c of visibleChildren(node)) collect(c);
  };
  collect(content.root);
  const rank = new Map(treeOrder.map((id, k) => [id, k]));
  edges.sort((a, b) => (rank.get(a.to) ?? 0) - (rank.get(b.to) ?? 0));
  const orderedNodes = new Map<string, NodeBox>();
  for (const id of treeOrder) orderedNodes.set(id, nodes.get(id)!);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of orderedNodes.values()) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { nodes: orderedNodes, edges, bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}
