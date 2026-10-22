// Graph element data (pure): the stored `graphData` shape, its defaults, the expression colour
// palette, a never-throwing reader for stored content and the factory for a new graph element.
import type { Vec2 } from "../canvas/camera";
import { contentOf, type GraphContent } from "../model/content";
import type { Element } from "../model/types";

export type GraphKind = "2d-function" | "2d-polar" | "2d-parametric";

export interface GraphExpression {
  id: string;
  latex: string;
  /** Light-theme colour (dark themes remap through mapInkColor). */
  color: string;
  visible: boolean;
}

export interface GraphDomain {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface GraphData {
  kind: GraphKind;
  expressions: GraphExpression[];
  domain: GraphDomain;
  grid: boolean;
}

/** Expression colours (light variants), assigned in order and cycled by the editor's colour dot. */
export const GRAPH_PALETTE: readonly string[] = [
  "#C62828",
  "#1565C0",
  "#2E7D32",
  "#EF6C00",
  "#6A1B9A",
  "#00838F",
  "#AD1457",
  "#4E342E",
  "#1B5E20",
  "#283593",
  "#F9A825",
  "#37474F",
];

export const DEFAULT_GRAPH_SIZE = { width: 480, height: 360 };
export const DEFAULT_DOMAIN: GraphDomain = { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };

const newId = (): string => crypto.randomUUID();

/** A new expression row coloured after the `index`-th palette entry. */
export const newExpression = (index: number, latex = ""): GraphExpression => ({
  id: newId(),
  latex,
  color: GRAPH_PALETTE[((index % GRAPH_PALETTE.length) + GRAPH_PALETTE.length) % GRAPH_PALETTE.length],
  visible: true,
});

/** The palette colour after `color` (the first one for colours outside the palette). */
export function nextPaletteColor(color: string): string {
  const i = GRAPH_PALETTE.findIndex((c) => c.toUpperCase() === color.toUpperCase());
  return GRAPH_PALETTE[(i + 1) % GRAPH_PALETTE.length];
}

export const defaultGraphData = (): GraphData => ({
  kind: "2d-function",
  expressions: [newExpression(0)],
  domain: { ...DEFAULT_DOMAIN },
  grid: true,
});

const KINDS: readonly GraphKind[] = ["2d-function", "2d-polar", "2d-parametric"];
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** A domain with finite, strictly increasing bounds (the default otherwise). */
export function validDomain(d: unknown): GraphDomain {
  const o = obj(d);
  if (o && num(o.xMin) && num(o.xMax) && num(o.yMin) && num(o.yMax) && o.xMin < o.xMax && o.yMin < o.yMax) {
    return { xMin: o.xMin, xMax: o.xMax, yMin: o.yMin, yMax: o.yMax };
  }
  return { ...DEFAULT_DOMAIN };
}

const MIN_SPAN = 1e-9;
const MAX_SPAN = 1e9;

/** `d` zoomed by `factor` (< 1 zooms in) about the domain point (ax, ay); unchanged when that would degenerate. */
export function zoomDomain(d: GraphDomain, factor: number, ax: number, ay: number): GraphDomain {
  const next = {
    xMin: ax - (ax - d.xMin) * factor,
    xMax: ax + (d.xMax - ax) * factor,
    yMin: ay - (ay - d.yMin) * factor,
    yMax: ay + (d.yMax - ay) * factor,
  };
  const ok = (lo: number, hi: number) => Number.isFinite(lo) && Number.isFinite(hi) && hi - lo > MIN_SPAN && hi - lo < MAX_SPAN;
  return ok(next.xMin, next.xMax) && ok(next.yMin, next.yMax) ? next : d;
}

/** `graphData` of a stored graph element, normalised (missing or malformed fields get defaults). Never throws. */
export function graphDataOf(el: Pick<Element, "content">): GraphData {
  const g = obj(contentOf<GraphContent>(el).graphData);
  if (!g) return defaultGraphData();
  const exprs = Array.isArray(g.expressions) ? g.expressions : [];
  return {
    kind: KINDS.includes(g.kind as GraphKind) ? (g.kind as GraphKind) : "2d-function",
    expressions: exprs.flatMap((e, i): GraphExpression[] => {
      const o = obj(e);
      if (!o) return [];
      return [
        {
          id: typeof o.id === "string" && o.id ? o.id : `expr-${i}`,
          latex: typeof o.latex === "string" ? o.latex : "",
          color: typeof o.color === "string" && o.color ? o.color : GRAPH_PALETTE[i % GRAPH_PALETTE.length],
          visible: o.visible !== false,
        },
      ];
    }),
    domain: validDomain(g.domain),
    grid: g.grid !== false,
  };
}

/** A new graph (default data) with its top-left at `at`. */
export const graphElement = (pageId: string, id: string, now: string, at: Vec2, color: string): Element => ({
  id,
  pageId,
  type: "graph",
  points: [{ x: at.x, y: at.y, pressure: 0.5, timestamp: 0 }],
  color,
  width: 1,
  isHighlighter: false,
  boxWidth: DEFAULT_GRAPH_SIZE.width,
  boxHeight: DEFAULT_GRAPH_SIZE.height,
  content: { subtype: "graph", graphData: defaultGraphData() } satisfies GraphContent,
  createdAt: now,
  updatedAt: now,
  version: 0,
});

/** Guess the graph kind for a typed equation: polar (`r = ...`), parametric (pair / only `t`), else function. */
export function inferGraphKind(latex: string): GraphKind {
  const src = latex.trim();
  const vars = src.replace(/\[a-zA-Z]+/g, " "); // drop commands such as \theta, \sin
  if (/^r\s*=/.test(src)) return "2d-polar";
  if (/\theta/.test(src) && !/[xy]/.test(vars)) return "2d-polar";
  if (/x\s*=.*,\s*y\s*=/.test(src)) return "2d-parametric";
  if (/t/.test(vars) && !/[xy]/.test(vars)) return "2d-parametric";
  if (/^\([^,()]+,[^()]+\)$/.test(src)) return "2d-parametric";
  return "2d-function";
}
