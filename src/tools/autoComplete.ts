// Auto-complete arrows (pure): where the element added from a side handle of a selected shape,
// text box or note goes, and the connector joining the two. The new element sits AUTO_COMPLETE_GAP
// page units beyond the chosen side, centred on the source's axis (or centred on a drop point), and
// the connector runs from that side of the source to the side of the new element facing it.
import { worldToScreen, type Camera, type Vec2 } from "../canvas/camera";
import { noteCard } from "../components/noteColors";
import type { CardStyle, ConnectorEnd, Side, TextAttributes } from "../model/content";
import type { Element, ShapeType } from "../model/types";
import { isClosedShape, shapeRectOf } from "../shapes/geometry";
import { defaultTextAttributes, textBoxElement } from "../text/textBox";
import { boxRect, contentMeta, rotatedBox, type Rect } from "./spatialIndex";

/** Distance between the source and the new element (page units). */
export const AUTO_COMPLETE_GAP = 80;
/** A new text box (page units). */
export const AUTO_TEXT_SIZE = { width: 200, height: 60 } as const;
/** A new sticky note (page units). */
export const AUTO_NOTE_SIZE = { width: 200, height: 200 } as const;
/** Card style of a new sticky note in the default yellow (see components/noteColors `noteCard`). */
export const NOTE_CARD: CardStyle = noteCard();

/** Gap between a side of the element and the near edge of its arrow button (screen px). */
export const HANDLE_GAP_PX = 18;
/** Hit area of an auto-complete arrow button (screen px; at least 24). */
export const HANDLE_HIT_PX = 28;
/** Extra clearance above the top side, past the rotate handle (24 px out, plus its knob and slop). */
const TOP_EXTRA_PX = 24;

/** Distance from the element's side to the centre of that side's arrow button (screen px). */
export const handleOffset = (side: Side): number => HANDLE_GAP_PX + HANDLE_HIT_PX / 2 + (side === "top" ? TOP_EXTRA_PX : 0);

/** Pane screen point of the centre of the `side` arrow button around element bounds `b`. */
export function handleCentre(b: Rect, side: Side, camera: Camera): Vec2 {
  const tl = worldToScreen(camera, { x: b.x, y: b.y });
  const br = worldToScreen(camera, { x: b.x + b.width, y: b.y + b.height });
  const o = handleOffset(side);
  if (side === "top") return { x: (tl.x + br.x) / 2, y: tl.y - o };
  if (side === "bottom") return { x: (tl.x + br.x) / 2, y: br.y + o };
  if (side === "left") return { x: tl.x - o, y: (tl.y + br.y) / 2 };
  return { x: br.x + o, y: (tl.y + br.y) / 2 };
}

export type AutoCompleteKind = "shape" | "text" | "note";

/** What the auto-complete popover offers: a closed shape kind, a text box or a note. */
export type AutoCompleteChoice = { kind: "shape"; shapeType: ShapeType } | { kind: "text" } | { kind: "note" };

/** The side across from `s`. */
export const OPPOSITE: Record<Side, Side> = { top: "bottom", right: "left", bottom: "top", left: "right" };

/** Unit direction of each side, pointing out of the element. */
const DIR: Record<Side, Vec2> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

/** True for an element auto-complete handles are offered on: a closed shape or a plain text box (notes included). */
export function autoCompletable(el: Element): boolean {
  if (el.type === "shape") return isClosedShape(el.shapeType ?? "rectangle");
  return el.type === "text-box" && (el.content as { subtype?: unknown } | null)?.subtype === undefined;
}

/** The source's box auto-complete measures from: the anchor box (rotated bounds when rotated). */
export function sourceRect(el: Element): Rect {
  const rot = contentMeta(el).rotation ?? 0;
  if (el.type === "shape") {
    const r = shapeRectOf(el);
    const n = { x: Math.min(r.x, r.x + r.width), y: Math.min(r.y, r.y + r.height), width: Math.abs(r.width), height: Math.abs(r.height) };
    return rotatedBox(n, rot);
  }
  return rotatedBox(boxRect(el), rot);
}

/** The side of `box` that faces point `p` (the dominant axis of the offset from the box centre). */
export function facingSide(box: Rect, p: Vec2): Side {
  const dx = p.x - (box.x + box.width / 2);
  const dy = p.y - (box.y + box.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

export interface PlaceOptions {
  pageId?: string;
  id?: string;
  now?: string;
  /** Centre the new element on this point instead of placing it beyond the side. */
  at?: Vec2;
  /** Text attributes of a new text box or note (default: the app defaults). */
  textAttributes?: TextAttributes;
  /** Swatch id of a new note's card (default yellow). */
  noteColor?: string;
}

/** The new element and the connector (to create) joining source side → the new element's facing side. */
export interface Placement {
  element: Element;
  connector: { start: Vec2; end: Vec2; source: ConnectorEnd; target: ConnectorEnd };
}

const centreOf = (r: Rect): Vec2 => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** Size of the element a choice creates from `source`. */
function sizeFor(source: Element, kind: AutoCompleteKind): { width: number; height: number } {
  if (kind === "text") return AUTO_TEXT_SIZE;
  if (kind === "note") return AUTO_NOTE_SIZE;
  if (source.type === "shape") {
    const r = shapeRectOf(source);
    return { width: Math.abs(r.width), height: Math.abs(r.height) };
  }
  const b = boxRect(source);
  return { width: b.width, height: b.height };
}

/**
 * Where an element of `kind` added from `side` of `source` goes, and its connector. Shapes copy the
 * source's size (a non-shape source gives its box size), stroke, fill and width but not its label;
 * text is 200×60, a note 200×200 carrying a card in `opts.noteColor` (default yellow).
 */
export function placeNext(
  source: Element,
  side: Side,
  kind: AutoCompleteKind,
  shapeType?: ShapeType,
  opts: PlaceOptions = {},
): Placement {
  const src = sourceRect(source);
  const size = sizeFor(source, kind);
  const d = DIR[side];
  const c = centreOf(src);
  const centre = opts.at
    ? { x: opts.at.x, y: opts.at.y }
    : {
        x: d.x === 0 ? c.x : d.x > 0 ? src.x + src.width + AUTO_COMPLETE_GAP + size.width / 2 : src.x - AUTO_COMPLETE_GAP - size.width / 2,
        y: d.y === 0 ? c.y : d.y > 0 ? src.y + src.height + AUTO_COMPLETE_GAP + size.height / 2 : src.y - AUTO_COMPLETE_GAP - size.height / 2,
      };
  const box: Rect = { x: centre.x - size.width / 2, y: centre.y - size.height / 2, width: size.width, height: size.height };
  const pageId = opts.pageId ?? source.pageId;
  const id = opts.id ?? crypto.randomUUID();
  const now = opts.now ?? new Date().toISOString();
  const element = kind === "shape" ? shapeAt(source, shapeType ?? source.shapeType ?? "rectangle", box, pageId, id, now) : boxAt(kind, box, pageId, id, now, opts.textAttributes, opts.noteColor);
  const targetSide = opts.at ? facingSide(box, c) : OPPOSITE[side];
  const mid = (r: Rect, s: Side): Vec2 => ({ x: r.x + r.width / 2 + (DIR[s].x * r.width) / 2, y: r.y + r.height / 2 + (DIR[s].y * r.height) / 2 });
  return {
    element,
    connector: { start: mid(src, side), end: mid(box, targetSide), source: { id: source.id, side }, target: { id, side: targetSide } },
  };
}

function shapeAt(source: Element, shapeType: ShapeType, box: Rect, pageId: string, id: string, now: string): Element {
  const fromShape = source.type === "shape";
  const c = (source.content ?? {}) as { fillOpacity?: unknown; sides?: unknown };
  const content: Record<string, unknown> = { fillOpacity: fromShape && typeof c.fillOpacity === "number" ? c.fillOpacity : 1 };
  if (fromShape && shapeType === source.shapeType && typeof c.sides === "number") content.sides = c.sides;
  return {
    id,
    pageId,
    type: "shape",
    shapeType,
    points: [
      { x: box.x, y: box.y, pressure: 0.5, timestamp: 0 },
      { x: box.x + box.width, y: box.y + box.height, pressure: 0.5, timestamp: 1 },
    ],
    color: source.color,
    fillColor: fromShape ? source.fillColor : "transparent",
    width: fromShape ? source.width : 2,
    isHighlighter: false,
    boxWidth: box.width,
    boxHeight: box.height,
    content,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

function boxAt(kind: "text" | "note", box: Rect, pageId: string, id: string, now: string, attrs?: TextAttributes, noteColor?: string): Element {
  const el = textBoxElement(pageId, id, now, { x: box.x, y: box.y }, attrs ?? defaultTextAttributes());
  const content = kind === "note" ? { ...(el.content as object), card: noteCard(noteColor) } : el.content;
  return { ...el, boxWidth: box.width, boxHeight: box.height, content };
}
