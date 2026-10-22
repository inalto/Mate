// Typed-math boxes (pure): a text-box element with `content.subtype:"math"`. The KaTeX HTML in
// `contentHtml` is a snapshot of `latex`, regenerated whenever the LaTeX is committed.
import type { Vec2 } from "../canvas/camera";
import { contentOf, type TextAttributes, type TextBoxContent } from "../model/content";
import type { Element } from "../model/types";
import { sanitizeHtml } from "../text/sanitize";
import { textAttrsOf } from "../text/textBox";
import { DEFAULT_BOX_WIDTH } from "../text/style";
import { renderLatex } from "./katex";

/** Box height (page units) of a new equation, as a multiple of the font size. */
export const MATH_HEIGHT_FACTOR = 2.2;
export const DEFAULT_MATH_FONT_SIZE = 28;

export const isMathBox = (el: Pick<Element, "type" | "content">): boolean =>
  el.type === "text-box" && contentOf<TextBoxContent>(el).subtype === "math";

/** The LaTeX source of a math box ("" when missing or malformed). */
export function latexOf(el: Pick<Element, "content">): string {
  const l = contentOf<TextBoxContent>(el).latex;
  return typeof l === "string" ? l : "";
}

/** Content of a math box for `latex` (KaTeX HTML regenerated and sanitised). */
export function mathContent(prev: Partial<TextBoxContent>, latex: string, attrs: TextAttributes): TextBoxContent {
  return { ...prev, subtype: "math", latex, contentHtml: sanitizeHtml(renderLatex(latex).html), rawContent: latex, textAttributes: attrs };
}

/** A new, empty equation box with its top-left at `at`. */
export function mathElement(pageId: string, id: string, now: string, at: Vec2, color: string): Element {
  const fontSize = DEFAULT_MATH_FONT_SIZE;
  const attrs: TextAttributes = { ...textAttrsOf({ content: {} }), fontFamily: "serif", fontSize, color, align: "center" };
  return {
    id,
    pageId,
    type: "text-box",
    points: [{ x: at.x, y: at.y, pressure: 0.5, timestamp: 0 }],
    color,
    width: 1,
    isHighlighter: false,
    boxWidth: DEFAULT_BOX_WIDTH,
    boxHeight: Math.ceil(fontSize * MATH_HEIGHT_FACTOR),
    content: mathContent({}, "", attrs),
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

/**
 * Size (page units) of `html` laid out off-screen with `attrs`; zeros where the document has no
 * layout (tests). The global katex.css must be loaded for the numbers to mean anything.
 */
export function measureMathSize(html: string, attrs: TextAttributes): { width: number; height: number } {
  if (typeof document === "undefined" || !html) return { width: 0, height: 0 };
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position: absolute; left: -100000px; top: 0; visibility: hidden; width: max-content; font-size: ${attrs.fontSize}px; line-height: 1.2;`;
  host.innerHTML = html;
  document.body.appendChild(host);
  try {
    const r = host.getBoundingClientRect();
    return { width: r.width, height: r.height };
  } finally {
    host.remove();
  }
}
