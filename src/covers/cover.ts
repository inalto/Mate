import type { Element } from "../model/types";
import type { ShapeContent } from "../model/content";

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
