// Text inside shapes (pure): the label stored at `content.label` of a closed shape, the inner
// rectangle it wraps into (spec B4) and its wrapped lines. Line and arrow shapes have no label.
import { contentOf } from "../model/content";
import type { Element } from "../model/types";
import { FONT_STACKS } from "../text/style";
import { wrapText } from "../text/wrap";
import { isClosedShape, shapeRectOf, type ShapeRect } from "./geometry";

export interface ShapeLabel {
  /** Plain text; `\n` breaks lines. */
  text: string;
  fontSize: number;
  color: string;
  align: "left" | "center" | "right";
}

/** Font family of shape labels: the text boxes' default (sans) stack. */
export const SHAPE_LABEL_FONT = FONT_STACKS.sans;
export const DEFAULT_LABEL_FONT_SIZE = 16;
/** Line spacing as a multiple of the font size. */
export const LABEL_LINE_HEIGHT = 1.25;

const ALIGNS: readonly ShapeLabel["align"][] = ["left", "center", "right"];

const hasLabel = (el: Pick<Element, "type" | "shapeType">): boolean =>
  el.type === "shape" && isClosedShape(el.shapeType ?? "rectangle");

/**
 * The label of a closed shape (`content.label`), or null when there is none (or `text` is not a
 * string). Bad fields take defaults: font size 16, the stroke colour, centred.
 */
export function shapeLabelOf(el: Element): ShapeLabel | null {
  if (!hasLabel(el)) return null;
  const raw = contentOf<{ label: unknown }>(el).label;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const l = raw as Partial<Record<keyof ShapeLabel, unknown>>;
  if (typeof l.text !== "string") return null;
  const fontSize = typeof l.fontSize === "number" && Number.isFinite(l.fontSize) && l.fontSize > 0 ? l.fontSize : DEFAULT_LABEL_FONT_SIZE;
  const color = typeof l.color === "string" ? l.color : el.color;
  const align = (ALIGNS as readonly unknown[]).includes(l.align) ? (l.align as ShapeLabel["align"]) : "center";
  return { text: l.text, fontSize, color, align };
}

/** A copy of `el` with `content.label` set (or removed for null); other content fields are kept. */
export function withShapeLabel(el: Element, label: ShapeLabel | null): Element {
  const rest: Record<string, unknown> = { ...contentOf<Record<string, unknown>>(el) };
  delete rest.label;
  return { ...el, content: label ? { ...rest, label: { ...label } } : rest };
}

/** `r` shrunk to `fw × fh` of its size about its centre. */
const central = (r: ShapeRect, fw: number, fh: number): ShapeRect => ({
  x: r.x + (r.width * (1 - fw)) / 2,
  y: r.y + (r.height * (1 - fh)) / 2,
  width: r.width * fw,
  height: r.height * fh,
});

const ELLIPSE_INSCRIBED = 0.707;

/**
 * The rectangle a closed shape's label wraps into, in the shape's own unrotated frame (like
 * `shapeRectOf`; renderers rotate it about the box centre). Rectangles inset by stroke width + 6,
 * ellipse/circle the inscribed rectangle, triangle the lower 55 % inset 15 % per side, diamond the
 * middle 50 %, pentagon/hexagon/star/polygon the central 60 %. Null for line and arrow.
 */
export function shapeInnerRect(el: Element): ShapeRect | null {
  if (!hasLabel(el)) return null;
  const s = shapeRectOf(el);
  const r: ShapeRect = {
    x: Math.min(s.x, s.x + s.width),
    y: Math.min(s.y, s.y + s.height),
    width: Math.abs(s.width),
    height: Math.abs(s.height),
  };
  switch (el.shapeType ?? "rectangle") {
    case "circle":
    case "ellipse":
      return central(r, ELLIPSE_INSCRIBED, ELLIPSE_INSCRIBED);
    case "triangle":
      return { x: r.x + r.width * 0.15, y: r.y + r.height * 0.45, width: r.width * 0.7, height: r.height * 0.55 };
    case "diamond":
      return central(r, 0.5, 0.5);
    case "pentagon":
    case "hexagon":
    case "star":
    case "polygon":
      return central(r, 0.6, 0.6);
    default: {
      const inset = Math.max(0, el.width) + 6;
      const w = Math.max(0, r.width - 2 * inset);
      const h = Math.max(0, r.height - 2 * inset);
      return { x: r.x + (r.width - w) / 2, y: r.y + (r.height - h) / 2, width: w, height: h };
    }
  }
}

/** The label's text wrapped to the inner rect's width (`measure` at the label's font); [] without a label. */
export function labelLines(el: Element, measure: (s: string) => number): string[] {
  const label = shapeLabelOf(el);
  const inner = shapeInnerRect(el);
  if (!label || !inner) return [];
  return wrapText(label.text, inner.width, measure);
}

/** Rough character width as a fraction of the font size, when no canvas can measure. */
export const APPROX_CHAR_WIDTH = 0.55;

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

/**
 * A width measure for label text at `fontSize` outside a drawing context (SVG and PDF export): an
 * OffscreenCanvas `measureText` in the label font when available, so lines match the canvas, else
 * `APPROX_CHAR_WIDTH × fontSize` per character.
 */
export function labelMeasure(fontSize: number): (s: string) => number {
  const m = sharedMeasurer();
  if (m) {
    const font = `${fontSize}px ${SHAPE_LABEL_FONT}`;
    return (s) => {
      m.font = font;
      return m.measureText(s).width;
    };
  }
  return (s) => Array.from(s).length * fontSize * APPROX_CHAR_WIDTH;
}
