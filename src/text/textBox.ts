// Text-box elements (pure): construction with defaults, a complete typed view of the stored
// content (sanitised, defaults filled in) and the equality used to skip no-op edits.
import type { Vec2 } from "../canvas/camera";
import { DEFAULT_SETTINGS } from "../model/constants";
import { contentOf, type TextAttributes, type TextBoxContent } from "../model/content";
import type { Element } from "../model/types";
import { defaultBoxSize } from "./measure";
import { isSafeColor, sanitizeHtml } from "./sanitize";
import { FONT_KEYS, type FontKey } from "./style";

/** Font sizes (page units) a stored box may use. */
const MIN_FONT_SIZE = 4;
const MAX_FONT_SIZE = 400;

const ALIGNS: readonly TextAttributes["align"][] = ["left", "center", "right", "justify"];

export const defaultTextAttributes = (color = DEFAULT_SETTINGS.defaultTextColor, fontSize = DEFAULT_SETTINGS.defaultTextSize): TextAttributes => ({
  fontFamily: "sans",
  fontSize,
  color,
  align: "left",
});

/**
 * Box-level attributes of `el`, each falling back to the default when missing or malformed. They
 * end up in CSS (editor, snapshot, SVG export), so only known fonts, sane sizes and colours the
 * sanitiser accepts get through.
 */
export function textAttrsOf(el: Pick<Element, "content">): TextAttributes {
  const a = (contentOf<TextBoxContent>(el).textAttributes ?? {}) as Partial<TextAttributes>;
  const d = defaultTextAttributes();
  return {
    fontFamily: FONT_KEYS.includes(a.fontFamily as FontKey) ? (a.fontFamily as string) : d.fontFamily,
    fontSize:
      typeof a.fontSize === "number" && Number.isFinite(a.fontSize) && a.fontSize >= MIN_FONT_SIZE && a.fontSize <= MAX_FONT_SIZE
        ? a.fontSize
        : d.fontSize,
    color: isSafeColor(a.color) ? a.color.trim() : d.color,
    align: ALIGNS.includes(a.align as TextAttributes["align"]) ? (a.align as TextAttributes["align"]) : d.align,
  };
}

/** The content of `el` with sanitised HTML and complete attributes (safe to render). */
export function textContentOf(el: Pick<Element, "content">): TextBoxContent {
  const c = contentOf<TextBoxContent>(el);
  return {
    ...c,
    contentHtml: sanitizeHtml(c.contentHtml),
    rawContent: typeof c.rawContent === "string" ? c.rawContent : "",
    textAttributes: textAttrsOf(el),
  };
}

/** A new, empty text box with its top-left at `at`. */
export function textBoxElement(pageId: string, id: string, now: string, at: Vec2, attrs: TextAttributes): Element {
  const size = defaultBoxSize(attrs.fontSize);
  const content: TextBoxContent = { contentHtml: "", rawContent: "", textAttributes: attrs };
  return {
    id,
    pageId,
    type: "text-box",
    points: [{ x: at.x, y: at.y, pressure: 0.5, timestamp: 0 }],
    color: attrs.color,
    width: 1,
    isHighlighter: false,
    boxWidth: size.width,
    boxHeight: size.height,
    content,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

/** True when `a` and `b` show the same text, formatting and box size. */
export function sameText(a: Element, b: Element): boolean {
  const ca = contentOf<TextBoxContent>(a);
  const cb = contentOf<TextBoxContent>(b);
  return (
    ca.contentHtml === cb.contentHtml &&
    ca.rawContent === cb.rawContent &&
    JSON.stringify(textAttrsOf(a)) === JSON.stringify(textAttrsOf(b)) &&
    a.boxWidth === b.boxWidth &&
    a.boxHeight === b.boxHeight
  );
}
