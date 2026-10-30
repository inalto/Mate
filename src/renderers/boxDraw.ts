// Drawing helpers shared by the boxed-element renderers: a bitmap (or the placeholder frame) in the
// element's box, and SVG rotated about the box centre.
import { esc, n } from "../export/svgUtil";
import { noteBackground } from "../components/noteColors";
import { mapInkColor } from "../ink/theme";
import type { ThemeName } from "../ink/types";
import { cardOf, type CardStyle } from "../model/content";
import type { Element } from "../model/types";
import { safeColor } from "../text/sanitize";
import { textContentOf } from "../text/textBox";
import { boxRect, contentMeta } from "../tools/spatialIndex";
import type { BoxBitmap } from "./boxSnapshot";
import type { RenderOptions } from "./registry";

export const PLACEHOLDER_COLOR = "#9aa0a6";

/** Render options plus `noCard`: the PDF export paints cards as vectors itself, so its box bitmaps leave them out. */
export type BoxRenderOptions = RenderOptions & { noCard?: boolean };

/** Soft card shadow: blur 12, offset (0, 4), 18 % black. "paper": hard offset (3, 3), 25 % black. Page units. */
export const CARD_SHADOWS_PX = {
  soft: { blur: 12, dx: 0, dy: 4, color: "rgba(0,0,0,0.18)" },
  paper: { blur: 0, dx: 3, dy: 3, color: "rgba(0,0,0,0.25)" },
} as const;
/** Alpha of a card's 1 px border (the ink colour). */
export const CARD_BORDER_ALPHA = 0.25;
/** Id of the SVG filter of a card's soft shadow (one per element, so ids stay unique in a document). */
export const cardFilterId = (el: Pick<Element, "id">): string => `card-shadow-${el.id}`;

/** The ink colour of a card box (its text colour, mapped for the theme). */
export function cardInk(el: Element, theme: ThemeName): string {
  return mapInkColor(safeColor(textContentOf(el).textAttributes.color, safeColor(el.color, "#000000")), theme);
}

/** Draw the card of `el` (fill, optional border, shadow) in its unrotated box; no-op without one. */
function drawCard(ctx: CanvasRenderingContext2D, el: Element, card: CardStyle, o: RenderOptions): void {
  const r = boxRect(el);
  const scale = o.zoomBucket * (o.pixelRatio ?? 1); // shadows are in device pixels, not page units
  ctx.save();
  ctx.beginPath();
  if (card.radius > 0 && typeof ctx.roundRect === "function") ctx.roundRect(r.x, r.y, r.width, r.height, card.radius);
  else ctx.rect(r.x, r.y, r.width, r.height);
  if (card.shadow !== "none") {
    const sh = CARD_SHADOWS_PX[card.shadow];
    ctx.shadowColor = sh.color;
    ctx.shadowBlur = sh.blur * scale;
    ctx.shadowOffsetX = sh.dx * scale;
    ctx.shadowOffsetY = sh.dy * scale;
  }
  ctx.fillStyle = noteBackground(card.background, o.theme);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  if (card.border) {
    ctx.globalAlpha *= CARD_BORDER_ALPHA;
    ctx.lineWidth = 1;
    ctx.strokeStyle = cardInk(el, o.theme);
    ctx.stroke();
  }
  ctx.restore();
}

/** SVG of the card of `el` in page units (a `<rect>`, plus the soft-shadow filter reference); "" without a card. */
export function cardSvg(el: Element, theme: ThemeName): string {
  const card = cardOf(el);
  if (!card) return "";
  const r = boxRect(el);
  const fill = esc(noteBackground(card.background, theme));
  const stroke = card.border ? ` stroke="${esc(cardInk(el, theme))}" stroke-opacity="${CARD_BORDER_ALPHA}" stroke-width="1"` : "";
  const filter = card.shadow === "soft" ? ` filter="url(#${cardFilterId(el)})"` : "";
  const rect = (dx: number, dy: number, extra: string) =>
    `<rect x="${n(r.x + dx)}" y="${n(r.y + dy)}" width="${n(r.width)}" height="${n(r.height)}" rx="${card.radius}" ry="${card.radius}" fill="${extra}"`;
  // "paper": the hard shadow is a second rect behind the card.
  const paper = card.shadow === "paper" ? `${rect(CARD_SHADOWS_PX.paper.dx, CARD_SHADOWS_PX.paper.dy, "rgba(0,0,0,0.25)")}/>` : "";
  const def =
    card.shadow === "soft"
      ? `<filter id="${cardFilterId(el)}" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="${CARD_SHADOWS_PX.soft.dx}" dy="${CARD_SHADOWS_PX.soft.dy}" stdDeviation="${CARD_SHADOWS_PX.soft.blur / 2}" flood-color="#000" flood-opacity="0.18"/></filter>`
      : "";
  return `${def}${paper}${rect(0, 0, fill)}${stroke}${filter}/>`;
}

/** Draw `bmp` in `el`'s box (rotated), or the placeholder frame when there is none. */
export function drawBoxBitmap(ctx: CanvasRenderingContext2D, el: Element, bmp: BoxBitmap | null, o: RenderOptions): void {
  const r = boxRect(el);
  const rot = contentMeta(el).rotation ?? 0;
  ctx.save();
  if (rot) {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.translate(-cx, -cy);
  }
  const card = cardOf(el);
  if (card && !(o as BoxRenderOptions).noCard) drawCard(ctx, el, card, o);
  if (bmp) {
    ctx.drawImage(bmp, r.x, r.y, r.width, r.height);
  } else {
    ctx.lineWidth = 1 / o.zoomBucket; // one output pixel
    ctx.strokeStyle = PLACEHOLDER_COLOR;
    ctx.strokeRect(r.x, r.y, r.width, r.height);
  }
  ctx.restore();
}

/** `body` (SVG in page units) rotated about the centre of `el`'s box. */
export function rotatedSvg(el: Element, body: string): string {
  const rot = contentMeta(el).rotation ?? 0;
  if (!rot) return body;
  const r = boxRect(el);
  const deg = (rot * 180) / Math.PI;
  return `<g transform="rotate(${n(deg)} ${n(r.x + r.width / 2)} ${n(r.y + r.height / 2)})">${body}</g>`;
}
