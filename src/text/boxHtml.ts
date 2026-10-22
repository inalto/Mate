// Static, sanitised HTML of the boxed types that render through the foreignObject -> bitmap path
// (text boxes, tables, code blocks). One dispatch gives the snapshot cache its appearance key and
// SVG export its `<foreignObject>`, so the canvas, PNG, thumbnails and SVG agree.
import { esc, n } from "../export/svgUtil";
import { mapInkColor } from "../ink/theme";
import type { ThemeName } from "../ink/types";
import type { Element } from "../model/types";
import type { Rect } from "../tools/spatialIndex";
import { textBoxForeignObject } from "./foreignObject";
import { FONT_STACKS, LINE_HEIGHT } from "./style";
import { codeOf, tableRowsOf } from "./tableCode";
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
  /** `<foreignObject>` laying the box out in `r`. */
  foreignObject(r: Rect): string;
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

function codeFo(code: string, color: string, r: Rect): string {
  const style = `font-family: ${FONT_STACKS.mono}; font-size: ${CODE_FONT_SIZE}px; line-height: ${LINE_HEIGHT}; color: ${color}; background: rgba(128,128,128,0.12); border-radius: 4px;`;
  return wrap(r, style, `<pre style="margin: 0; padding: 8px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit;">${esc(code)}</pre>`);
}

/** Appearance of a text box, table or code block; null for other types. */
export function boxAppearance(el: Element, theme: ThemeName): BoxAppearance | null {
  const width = el.boxWidth ?? 0;
  const height = el.boxHeight ?? 0;
  switch (el.type) {
    case "text-box": {
      const content = textContentOf(el);
      const color = mapInkColor(content.textAttributes.color, theme);
      return {
        key: JSON.stringify([content.contentHtml, content.textAttributes, width, height, color]),
        width,
        height,
        foreignObject: (r) => textBoxForeignObject(content, r, color),
      };
    }
    case "table": {
      const rows = tableRowsOf(el);
      const color = mapInkColor(el.color, theme);
      return { key: JSON.stringify(["table", rows, width, height, color]), width, height, foreignObject: (r) => tableFo(rows, color, r) };
    }
    case "codespace": {
      const { code, language } = codeOf(el);
      const color = mapInkColor(el.color, theme);
      return { key: JSON.stringify(["code", code, language, width, height, color]), width, height, foreignObject: (r) => codeFo(code, color, r) };
    }
    default:
      return null;
  }
}
