// Where Compute results go: the LaTeX of a result box, and the insertion of a result (math or
// plain text) as a new box under its source, one undo step. Shared by the Compute menu's local
// operations and its remote-engine items.
import { esc } from "../export/svgUtil";
import type { TKey } from "../i18n";
import { looksLikeEquation, type Op } from "./cas";
import { MATH_HEIGHT_FACTOR, mathContent, mathElement } from "./mathBox";
import type { TextBoxContent } from "../model/content";
import type { Element } from "../model/types";
import { PAGE_GAP } from "../model/constants";
import { sheetStack, type EditorStore } from "../stores/editor";
import { textAttrsOf, textBoxElement } from "../text/textBox";
import { sanitizeHtml } from "../text/sanitize";
import { elementBounds, withMeta } from "../tools/spatialIndex";
import { topZ } from "../tools/zorder";

/** Gap (page units) between the source box and the result under it. */
export const RESULT_GAP = 12;

export const COMPUTE_OPS: ReadonlyArray<{ op: Op; labelKey: TKey }> = [
  { op: "evaluate", labelKey: "math.ops.evaluate" },
  { op: "simplify", labelKey: "math.ops.simplify" },
  { op: "expand", labelKey: "math.ops.expand" },
  { op: "solve", labelKey: "math.ops.solve" },
  { op: "numeric", labelKey: "math.ops.numeric" },
];

/**
 * The LaTeX of the result box: `=` before the result of an expression (`≈` for a numeric value);
 * a solution or an equation's result is shown as is.
 */
export function resultLatex(sourceLatex: string, op: Op, result: string): string {
  if (op === "solve" || looksLikeEquation(sourceLatex)) return result;
  return op === "numeric" ? `\\approx ${result}` : `=${result}`;
}

/**
 * Paper mode: keep `el` on the sheet its source starts on. When it would cross the sheet's bottom
 * edge it goes to the right of the source at the source's top instead (pulled left to fit the
 * sheet's width). The infinite canvas is left alone.
 */
function keepOnSheet(s: ReturnType<EditorStore["getState"]>, src: Element, el: Element): Element {
  if (s.page?.mode !== "page") return el;
  const sheet = sheetStack(s);
  const b = elementBounds(src);
  const pitch = sheet.height + PAGE_GAP;
  const index = Math.max(0, Math.floor(b.y / pitch));
  const sheetBottom = index * pitch + sheet.height;
  const height = el.boxHeight ?? 0;
  if (el.points[0].y + height <= sheetBottom) return el;
  const width = el.boxWidth ?? 0;
  const x = Math.max(0, Math.min(b.x + b.width + RESULT_GAP, sheet.width - width));
  const y = Math.max(index * pitch, Math.min(b.y, sheetBottom - height));
  return { ...el, points: [{ ...el.points[0], x, y }, ...el.points.slice(1)] };
}

/**
 * Insert a math box (`latex`) or a text box (`text`) under `source`: same x, top at the source's
 * bottom + RESULT_GAP, the source's font attributes; one undo step, then selected. In paper mode a
 * result that would cross the sheet's bottom goes to the right of the source instead. Its id, or
 * null when the store no longer shows the source's page (or the page is full).
 */
export function insertResultBelow(store: EditorStore, source: Element, result: { latex: string } | { text: string }): string | null {
  const s = store.getState();
  if (!s.pageId || s.pageId !== source.pageId) return null;
  const src = s.elements.get(source.id) ?? source;
  const b = elementBounds(src);
  const at = { x: src.points[0]?.x ?? b.x, y: b.y + b.height + RESULT_GAP };
  const attrs = textAttrsOf(src);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  let el: Element;
  if ("latex" in result) {
    const base = mathElement(s.pageId, id, now, at, attrs.color);
    el = {
      ...base,
      boxWidth: src.boxWidth ?? base.boxWidth,
      boxHeight: Math.ceil(attrs.fontSize * MATH_HEIGHT_FACTOR),
      content: mathContent({}, result.latex, attrs),
    };
  } else {
    const base = textBoxElement(s.pageId, id, now, at, attrs);
    const content: TextBoxContent = { contentHtml: sanitizeHtml(`<p>${esc(result.text)}</p>`), rawContent: result.text, textAttributes: attrs };
    el = { ...base, boxWidth: src.boxWidth ?? base.boxWidth, content };
  }
  el = keepOnSheet(s, src, el);
  const top = topZ(s.elements.values());
  if (top > 0) el = withMeta(el, { zIndex: top + 1 });
  if (!s.addElements("Compute", [el])) return null;
  store.setState({ selection: new Set([el.id]) });
  return el.id;
}
