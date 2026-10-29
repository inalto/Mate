// Static, sanitised HTML of the boxed types that render through the foreignObject -> bitmap path
// (text boxes, typed math, tables, code blocks). One dispatch gives the snapshot cache its appearance key and
// SVG export its `<foreignObject>`, so the canvas, PNG, thumbnails and SVG agree.
import { esc, n } from "../export/svgUtil";
import { mapInkColor } from "../ink/theme";
import type { ThemeName } from "../ink/types";
import i18n from "../i18n";
import type { CodeOutput } from "../model/content";
import type { Element } from "../model/types";
import type { Rect } from "../tools/spatialIndex";
import { isMathBox } from "../math/mathBox";
import { mathForeignObject, textBoxForeignObject } from "./foreignObject";
import { safeColor } from "./sanitize";
import { FONT_STACKS, LINE_HEIGHT } from "./style";
import { codeOf, outputLines, tableRowsOf } from "./tableCode";
import { textContentOf } from "./textBox";

/** Types drawn from an HTML bitmap. */
export const HTML_BOX_TYPES: readonly string[] = ["text-box", "table", "codespace"];
export const isHtmlBox = (el: Pick<Element, "type">): boolean => HTML_BOX_TYPES.includes(el.type);

/** Font size (page units) of table and code text. */
export const TABLE_FONT_SIZE = 18;
export const CODE_FONT_SIZE = 16;

export interface BoxAppearance {
  /** Changes whenever what the box looks like changes (content, size, themed colour). */
  key: string;
  width: number;
  height: number;
  /**
   * `<foreignObject>` laying the box out in `r`. With `sharedCss` the stylesheet named by
   * `sharedCss` below is left out (the SVG export embeds it once in `<defs>`).
   */
  foreignObject(r: Rect, opts?: { sharedCss?: boolean }): string;
  /** Document-wide stylesheet the box needs ("katex" for math boxes). */
  sharedCss?: "katex";
}

const wrap = (r: Rect, style: string, body: string): string =>
  `<foreignObject x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}">` +
  `<div xmlns="http://www.w3.org/1999/xhtml" style="${esc(`box-sizing: border-box; width: ${n(r.width)}px; height: ${n(r.height)}px; overflow: hidden; ${style}`)}">${body}</div></foreignObject>`;

function tableFo(rows: string[][], color: string, r: Rect): string {
  const cell = `border: 1px solid ${color}; padding: 2px 6px; vertical-align: top; white-space: pre-wrap; overflow-wrap: anywhere;`;
  const body = rows.map((row) => `<tr>${row.map((c) => `<td style="${esc(cell)}">${esc(c)}</td>`).join("")}</tr>`).join("");
  const style = `font-family: ${FONT_STACKS.sans}; font-size: ${TABLE_FONT_SIZE}px; line-height: ${LINE_HEIGHT}; color: ${color};`;
  return wrap(r, style, `<table style="border-collapse: collapse; width: 100%; table-layout: fixed;"><tbody>${body}</tbody></table>`);
}

/** Colour of stderr lines in a code block's output pane (reads on light and dark paper). */
export const CODE_ERR_COLOR = "#e5484d";
const PRE = "margin: 0; padding: 8px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit;";

/** The output pane under a code block: the kept lines, stderr ones in `<span class="err">`, escaped. */
function outputPane(output: CodeOutput): string {
  const { dropped, lines } = outputLines(output);
  const head = dropped > 0 ? `<span class="more" style="opacity: 0.7;">${esc(i18n.t("code.moreLines", { count: dropped }))}</span>\n` : "";
  const body = lines.map((l) => (l.err ? `<span class="err" style="color: ${CODE_ERR_COLOR};">${esc(l.text)}</span>` : esc(l.text))).join("\n");
  return `<pre class="code-output" style="${PRE} border-top: 1px solid rgba(128,128,128,0.4);">${head}${body}</pre>`;
}

function codeFo(code: string, output: CodeOutput | undefined, color: string, r: Rect): string {
  const style = `font-family: ${FONT_STACKS.mono}; font-size: ${CODE_FONT_SIZE}px; line-height: ${LINE_HEIGHT}; color: ${color}; background: rgba(128,128,128,0.12); border-radius: 4px;`;
  return wrap(r, style, `<pre style="${PRE}">${esc(code)}</pre>${output ? outputPane(output) : ""}`);
}

/** Ink colour used when a stored colour is not a safe CSS colour. */
export const FALLBACK_INK = "#000000";
/** The element's colour when safe for CSS, else black. */
const inkOf = (el: Pick<Element, "color">): string => safeColor(el.color, FALLBACK_INK);

/** Appearance of a text box, table or code block; null for other types. */
export function boxAppearance(el: Element, theme: ThemeName): BoxAppearance | null {
  const width = el.boxWidth ?? 0;
  const height = el.boxHeight ?? 0;
  switch (el.type) {
    case "text-box": {
      const content = textContentOf(el);
      const color = mapInkColor(safeColor(content.textAttributes.color, inkOf(el)), theme);
      if (isMathBox(el)) {
        return {
          key: JSON.stringify(["math", content.contentHtml, content.textAttributes, width, height, color]),
          width,
          height,
          foreignObject: (r, o) => mathForeignObject(content, r, color, o?.sharedCss ?? false),
          sharedCss: "katex",
        };
      }
      return {
        key: JSON.stringify([content.contentHtml, content.textAttributes, width, height, color]),
        width,
        height,
        foreignObject: (r) => textBoxForeignObject(content, r, color),
      };
    }
    case "table": {
      const rows = tableRowsOf(el);
      const color = mapInkColor(inkOf(el), theme);
      return { key: JSON.stringify(["table", rows, width, height, color]), width, height, foreignObject: (r) => tableFo(rows, color, r) };
    }
    case "codespace": {
      const { code, language, output } = codeOf(el);
      const color = mapInkColor(inkOf(el), theme);
      return {
        key: JSON.stringify(["code", code, language, output ?? null, width, height, color, output ? i18n.language : null]),
        width,
        height,
        foreignObject: (r) => codeFo(code, output, color, r),
      };
    }
    default:
      return null;
  }
}
