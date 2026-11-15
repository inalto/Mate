import type { Element } from "../model/types";
import { shapeElement, type ShapeDrag } from "../shapes/geometry";
import type { EditorState } from "../stores/editor";
import type { ShapeContent } from "../model/content";
import { mapInkColor } from "../ink/theme";
import type { ThemeName } from "../ink/types";

/** A recall cover is a stroke drawn with the cover pen, or a shape marked as a cover. */
export const isCover = (el: Pick<Element, "type" | "penStyle" | "content">): boolean =>
  (el.type === "stroke" && el.penStyle === "cover") ||
  (el.type === "shape" && (el.content as Partial<ShapeContent> | undefined)?.cover === true);

/** The live covers among `elements`; deleted ones are left out. */
export function coversOf(elements: Iterable<Element>): Element[] {
  const out: Element[] = [];
  for (const el of elements) if (!el.deletedAt && isCover(el)) out.push(el);
  return out;
}

const HEX6 = /^#[0-9a-f]{6}$/i;
/** How far the outline colour moves from the cover colour toward the text colour. */
const OUTLINE_MIX = 0.2;

/**
 * The thin outline that keeps a cover visible on paper of its own colour: `color` (as displayed)
 * mixed 20 % toward the theme's text colour. A colour that is not #rrggbb is returned as it is.
 */
export function coverOutlineColor(color: string, theme: ThemeName): string {
  if (!HEX6.test(color)) return color;
  const text = mapInkColor("#000000", theme);
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  const mixed = [1, 3, 5].map((at) => Math.round(channel(color, at) * (1 - OUTLINE_MIX) + channel(text, at) * OUTLINE_MIX));
  return `#${mixed.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** A box cover: an opaque rectangle in the cover colour, marked `cover` so it hides what is under it. */
export function coverBoxElement(color: string, drag: ShapeDrag, pageId: string, id: string, now: string): Element {
  const box = shapeElement({ shapeType: "rectangle", color, fillColor: color, width: 0, fillOpacity: 1 }, drag, pageId, id, now);
  return { ...box, content: { fillOpacity: 1, cover: true } };
}

/** The cover tool is in hand with a box preset: a drag draws a rectangle instead of a stroke. */
export const coverBoxActive = (s: Pick<EditorState, "tool" | "preset">): boolean => s.tool === "cover" && s.preset.coverShape === "box";
