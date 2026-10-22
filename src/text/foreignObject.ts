// A text box as an SVG `<foreignObject>`: the sanitised HTML (as XHTML) in a div styled like the DOM
// editor. Used for SVG export (in page units) and, at the origin, for the bitmap snapshot.
import type { TextBoxContent } from "../model/content";
import type { Rect } from "../tools/spatialIndex";
import { esc, n } from "../export/svgUtil";
import { getEmbeddedKatexCss } from "../math/katexCss";
import { toXhtml } from "./sanitize";
import { boxCss, CONTENT_CLASS, CONTENT_CSS, cssText } from "./style";

/** `<foreignObject>` for `content` laid out in `r`; `color` is the (theme-mapped) box colour. */
export function textBoxForeignObject(content: TextBoxContent, r: Rect, color: string): string {
  const style = `${cssText(boxCss(content.textAttributes, color))} width: ${n(r.width)}px; height: ${n(r.height)}px; overflow: hidden;`;
  const body = toXhtml(content.contentHtml);
  return (
    `<foreignObject x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="${CONTENT_CLASS}" style="${esc(style)}">` +
    `<style>${CONTENT_CSS}</style>${body}</div></foreignObject>`
  );
}

/** CSS of a math box: katex.css plus a zero margin on the display wrapper. */
const mathCss = (): string => `${getEmbeddedKatexCss()} .katex-display{margin:0}`;

/** `<foreignObject>` for a typed-math box: the sanitised KaTeX HTML with katex.css inlined. */
export function mathForeignObject(content: TextBoxContent, r: Rect, color: string): string {
  const style = `${cssText(boxCss(content.textAttributes, color))} width: ${n(r.width)}px; height: ${n(r.height)}px; overflow: hidden;`;
  const body = toXhtml(content.contentHtml);
  return (
    `<foreignObject x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="math-box" style="${esc(style)}">` +
    `<style>${mathCss()}</style>${body}</div></foreignObject>`
  );
}
