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
import { isRecording, recordingOf } from "../recording/types";
import { totalMs } from "../recording/timeline";
import { formatElapsed } from "../speech/elapsed";
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

/** Geometry of a recording marker (a round icon with a microphone and the duration) inside box `r`. */
export interface MarkerLayout {
  cx: number;
  cy: number;
  radius: number;
  /** Microphone capsule. */
  capsule: Rect & { radius: number };
  /** Arc under the capsule (its lower half). */
  arc: { cx: number; cy: number; radius: number; width: number };
  /** Stem from the arc down. */
  stem: { x: number; y1: number; y2: number };
  label: { x: number; y: number; size: number };
}

/** Marker geometry in box `r`, scaled from the 44 × 44 design. */
export function markerLayout(r: Rect): MarkerLayout {
  const s = Math.min(r.width, r.height) / 44;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  return {
    cx,
    cy,
    radius: Math.min(r.width, r.height) / 2,
    capsule: { x: cx - 3.5 * s, y: cy - 15 * s, width: 7 * s, height: 13 * s, radius: 3.5 * s },
    arc: { cx, cy: cy - 5 * s, radius: 7 * s, width: 1.6 * s },
    stem: { x: cx, y1: cy + 2 * s, y2: cy + 6 * s },
    label: { x: cx, y: cy + 17 * s, size: 11 * s },
  };
}

/** The duration shown under a recording marker's microphone. */
export const markerDuration = (el: Element): string => formatElapsed(totalMs(recordingOf(el)!));

function drawMarker(ctx: CanvasRenderingContext2D, el: Element, r: Rect, theme: ThemeName, zoomBucket: number): void {
  const L = markerLayout(r);
  const ink = mediaInk(theme);
  ctx.beginPath();
  ctx.arc(L.cx, L.cy, L.radius, 0, Math.PI * 2);
  ctx.fillStyle = mediaFill(theme);
  ctx.fill();
  ctx.lineWidth = 1 / zoomBucket;
  ctx.strokeStyle = PLACEHOLDER_COLOR;
  ctx.stroke();
  const c = L.capsule;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(c.x, c.y, c.width, c.height, c.radius);
  else ctx.rect(c.x, c.y, c.width, c.height);
  ctx.fillStyle = ink;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(L.arc.cx, L.arc.cy, L.arc.radius, 0, Math.PI);
  ctx.moveTo(L.stem.x, L.stem.y1);
  ctx.lineTo(L.stem.x, L.stem.y2);
  ctx.lineWidth = L.arc.width;
  ctx.lineCap = "round";
  ctx.strokeStyle = ink;
  ctx.stroke();
  ctx.font = `${L.label.size}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = ink;
  ctx.fillText(markerDuration(el), L.label.x, L.label.y);
}

function markerSvg(el: Element, r: Rect, theme: ThemeName, zoomBucket: number): string {
  const L = markerLayout(r);
  const ink = mediaInk(theme);
  const c = L.capsule;
  const a = L.arc;
  return (
    `<g data-media="recording">` +
    `<circle cx="${n(L.cx)}" cy="${n(L.cy)}" r="${n(L.radius)}" fill="${mediaFill(theme)}" stroke="${PLACEHOLDER_COLOR}" stroke-width="${n(1 / zoomBucket)}"/>` +
    `<rect x="${n(c.x)}" y="${n(c.y)}" width="${n(c.width)}" height="${n(c.height)}" rx="${n(c.radius)}" fill="${ink}"/>` +
    `<path d="M${n(a.cx - a.radius)} ${n(a.cy)}A${n(a.radius)} ${n(a.radius)} 0 0 0 ${n(a.cx + a.radius)} ${n(a.cy)}M${n(L.stem.x)} ${n(L.stem.y1)}L${n(L.stem.x)} ${n(L.stem.y2)}" fill="none" stroke="${ink}" stroke-width="${n(a.width)}" stroke-linecap="round"/>` +
    `<text x="${n(L.label.x)}" y="${n(L.label.y)}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${n(L.label.size)}" fill="${ink}">${esc(markerDuration(el))}</text>` +
    `</g>`
  );
}

export const mediaRenderer: ElementRenderer = {
  draw(ctx, el, o) {
    const r = boxRect(el);
    if (r.width <= 0 || r.height <= 0) return;
    const marker = isRecording(el);
    const rot = contentOf<MediaContent>(el).rotation ?? 0;
    ctx.save();
    if (rot) {
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.translate(-cx, -cy);
    }
    if (marker) {
      drawMarker(ctx, el, r, o.theme, o.zoomBucket);
      ctx.restore();
      return;
    }
    const L = mediaLayout(r);
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
    if (isRecording(el)) return rotatedSvg(el, markerSvg(el, r, o.theme, o.zoomBucket));
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
