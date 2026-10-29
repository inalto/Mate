// Media renderer: audio and video players are live DOM (media/MediaLayer) on the canvas; this draws
// the static placeholder under them and in every export and thumbnail: a rounded box in a neutral
// fill, a play triangle and the title (or "Audio"/"Video"). A strip-shaped box (audio) puts the
// glyph at the left with the title beside it; a taller box (video) centres the glyph and puts the
// title along the bottom.
import { esc, n } from "../export/svgUtil";
import i18n from "../i18n";
import { isDarkTheme } from "../ink/theme";
import type { ThemeName } from "../ink/types";
import { contentOf, type MediaContent } from "../model/content";
import type { Element } from "../model/types";
import { boxRect, type Rect } from "../tools/spatialIndex";
import { PLACEHOLDER_COLOR, rotatedSvg } from "./boxDraw";
import { registerRenderer, type ElementRenderer } from "./registry";

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const mediaFill = (theme: ThemeName): string => (isDarkTheme(theme) ? "#2b2e33" : "#eef0f3");
export const mediaInk = (theme: ThemeName): string => (isDarkTheme(theme) ? "#d5d8dc" : "#4a4f55");

/** Player kind of a media element (unknown values read as audio). */
export const mediaKind = (el: Element): MediaContent["kind"] => (contentOf<MediaContent>(el).kind === "video" ? "video" : "audio");

/** The label drawn on the placeholder: the title, else "Audio" / "Video". */
export function mediaLabel(el: Element): string {
  const title = contentOf<MediaContent>(el).title;
  if (typeof title === "string" && title.trim()) return title.trim();
  return i18n.t(mediaKind(el) === "video" ? "media.video" : "media.audio");
}

/** `label` cut (with an ellipsis) to roughly fit `maxWidth` at font `size` (SVG has no maxWidth). */
export function fitLabel(label: string, size: number, maxWidth: number): string {
  const chars = Math.max(1, Math.floor(maxWidth / (size * 0.55)));
  return label.length <= chars ? label : `${label.slice(0, Math.max(1, chars - 1))}…`;
}

export interface MediaLayout {
  radius: number;
  /** Play triangle vertices. */
  glyph: [number, number][];
  label: { x: number; y: number; size: number; maxWidth: number };
}

/** Placeholder geometry inside box `r` (page units). */
export function mediaLayout(r: Rect): MediaLayout {
  const radius = clamp(Math.min(r.width, r.height) * 0.15, 2, 12);
  const tall = r.height >= 96 && r.height > r.width * 0.3;
  if (tall) {
    const g = clamp(Math.min(r.width, r.height) * 0.18, 12, 64);
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const size = clamp(r.height * 0.07, 10, 20);
    return {
      radius,
      glyph: [
        [cx - g * 0.4, cy - g / 2],
        [cx + g * 0.6, cy],
        [cx - g * 0.4, cy + g / 2],
      ],
      label: { x: r.x + size, y: r.y + r.height - size, size, maxWidth: Math.max(0, r.width - 2 * size) },
    };
  }
  const g = clamp(r.height * 0.45, 6, 32);
  const pad = clamp(r.height * 0.3, 4, 16);
  const cy = r.y + r.height / 2;
  const size = clamp(r.height * 0.3, 8, 18);
  const lx = r.x + pad + g + pad;
  return {
    radius,
    glyph: [
      [r.x + pad, cy - g / 2],
      [r.x + pad + g, cy],
      [r.x + pad, cy + g / 2],
    ],
    label: { x: lx, y: cy + size * 0.35, size, maxWidth: Math.max(0, r.x + r.width - pad - lx) },
  };
}

export const mediaRenderer: ElementRenderer = {
  draw(ctx, el, o) {
    const r = boxRect(el);
    if (r.width <= 0 || r.height <= 0) return;
    const L = mediaLayout(r);
    const rot = contentOf<MediaContent>(el).rotation ?? 0;
    ctx.save();
    if (rot) {
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.translate(-cx, -cy);
    }
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(r.x, r.y, r.width, r.height, L.radius);
    else ctx.rect(r.x, r.y, r.width, r.height);
    ctx.fillStyle = mediaFill(o.theme);
    ctx.fill();
    ctx.lineWidth = 1 / o.zoomBucket;
    ctx.strokeStyle = PLACEHOLDER_COLOR;
    ctx.stroke();
    ctx.beginPath();
    L.glyph.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = mediaInk(o.theme);
    ctx.fill();
    if (L.label.maxWidth > L.label.size) {
      ctx.font = `${L.label.size}px system-ui, sans-serif`;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(mediaLabel(el), L.label.x, L.label.y, L.label.maxWidth);
    }
    ctx.restore();
  },
  svg(el, o) {
    const r = boxRect(el);
    if (r.width <= 0 || r.height <= 0) return "";
    const L = mediaLayout(r);
    const ink = mediaInk(o.theme);
    const glyph = L.glyph.map(([x, y]) => `${n(x)},${n(y)}`).join(" ");
    const label =
      L.label.maxWidth > L.label.size
        ? `<text x="${n(L.label.x)}" y="${n(L.label.y)}" font-family="system-ui, sans-serif" font-size="${n(L.label.size)}" fill="${ink}">${esc(fitLabel(mediaLabel(el), L.label.size, L.label.maxWidth))}</text>`
        : "";
    const body =
      `<g data-media="${mediaKind(el)}">` +
      `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}" rx="${n(L.radius)}" fill="${mediaFill(o.theme)}" stroke="${PLACEHOLDER_COLOR}" stroke-width="${n(1 / o.zoomBucket)}"/>` +
      `<polygon points="${glyph}" fill="${ink}"/>` +
      label +
      `</g>`;
    return rotatedSvg(el, body);
  },
  bounds: (el) => boxRect(el),
};

registerRenderer("media", mediaRenderer);
