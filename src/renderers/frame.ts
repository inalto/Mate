// Frame renderer: a rounded rect (radius 8) filled with `content.background`, or when unset with the
// theme's paper tinted 4 % towards its ink, a 1 px border, and the title in 14 px semi-bold above
// the top-left corner (inside, below the top edge, when the frame sits in another frame). The title
// is screen-constant when zoomed out and hides when the frame is narrower than 80 px on screen; an
// empty title draws nothing. `bounds` spans the rect plus the title band above it (at zoom 1).
import { esc, n } from "../export/svgUtil";
import {
  FRAME_RADIUS,
  FRAME_TITLE_BAND,
  frameTitle,
  frameTitleHidden,
  frameTitleRect,
  isNestedFrame,
} from "../frames/contain";
import type { ThemeName } from "../ink/types";
import { contentOf, type FrameContent } from "../model/content";
import type { Element } from "../model/types";
import { safeColor } from "../text/sanitize";
import { boxRect, type Rect } from "../tools/spatialIndex";
import type { ElementRenderer } from "./registry";

/** Paper and ink of each theme (the canvas surfaces). */
const SURFACE: Record<ThemeName, { paper: string; ink: string }> = {
  light: { paper: "#ffffff", ink: "#000000" },
  sepia: { paper: "#f7efdb", ink: "#5b4a33" },
  dark: { paper: "#18181b", ink: "#ffffff" },
  "high-contrast": { paper: "#000000", ink: "#ffffff" },
};

export const FRAME_FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

const surface = (theme: ThemeName) => SURFACE[theme] ?? SURFACE.light;

/** `a` mixed towards `b` by `t` (0 to 1); both `#rrggbb`. */
export function mixHex(a: string, b: string, t: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  const out = [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Fill of frame `el` in `theme`: its background, else paper tinted 4 % towards the ink. */
export function frameFill(el: Element, theme: ThemeName): string {
  const bg = contentOf<FrameContent>(el).background;
  const s = surface(theme);
  return typeof bg === "string" && bg !== "" ? safeColor(bg, s.paper) : mixHex(s.paper, s.ink, 0.04);
}

const borderOf = (theme: ThemeName): string => {
  const s = surface(theme);
  return mixHex(s.paper, s.ink, 0.28);
};
const titleColour = (theme: ThemeName): string => {
  const s = surface(theme);
  return mixHex(s.paper, s.ink, 0.7);
};

function roundRectPath(ctx: CanvasRenderingContext2D, r: Rect, rad: number): void {
  const k = Math.max(0, Math.min(rad, r.width / 2, r.height / 2));
  const { x, y, width: w, height: h } = r;
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.lineTo(x + w - k, y);
  ctx.arc(x + w - k, y + k, k, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - k);
  ctx.arc(x + w - k, y + h - k, k, 0, Math.PI / 2);
  ctx.lineTo(x + k, y + h);
  ctx.arc(x + k, y + h - k, k, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + k);
  ctx.arc(x + k, y + k, k, Math.PI, (3 * Math.PI) / 2);
  ctx.closePath();
}

/** The title to draw at `zoom` and where, or null (empty or too narrow on screen). */
function titleAt(el: Element, zoom: number): { text: string; rect: Rect; size: number } | null {
  const text = frameTitle(el).trim();
  if (text === "" || frameTitleHidden(el, zoom)) return null;
  const rect = frameTitleRect(el, zoom, isNestedFrame(el));
  return { text, rect, size: rect.height / 1.4 };
}

/** World bounds: the rect plus the title band above it (the title at zoom 1). */
export function frameBounds(el: Element): Rect {
  const r = boxRect(el);
  return { x: r.x, y: r.y - FRAME_TITLE_BAND, width: r.width, height: r.height + FRAME_TITLE_BAND };
}

export const frameRenderer: ElementRenderer = {
  draw(ctx, el, o) {
    const r = boxRect(el);
    if (r.width <= 0 || r.height <= 0) return;
    // Frames ignore rotation (a stray `content.rotation` is never drawn).
    ctx.save();
    roundRectPath(ctx, r, FRAME_RADIUS);
    ctx.fillStyle = frameFill(el, o.theme);
    ctx.fill();
    ctx.lineWidth = 1 / Math.max(o.zoomBucket, 1e-6);
    ctx.strokeStyle = borderOf(o.theme);
    ctx.stroke();
    const title = titleAt(el, o.zoomBucket);
    if (title) {
      ctx.fillStyle = titleColour(o.theme);
      ctx.font = `600 ${title.size}px ${FRAME_FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(title.text, title.rect.x, title.rect.y + title.rect.height / 2, title.rect.width);
    }
    ctx.restore();
  },
  svg(el, o) {
    const r = boxRect(el);
    if (r.width <= 0 || r.height <= 0) return "";
    const k = Math.max(0, Math.min(FRAME_RADIUS, r.width / 2, r.height / 2));
    let out =
      `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}" rx="${n(k)}" ry="${n(k)}"` +
      ` fill="${esc(frameFill(el, o.theme))}" stroke="${esc(borderOf(o.theme))}" stroke-width="${n(1 / Math.max(o.zoomBucket, 1e-6))}"/>`;
    const title = titleAt(el, o.zoomBucket);
    if (title) {
      out +=
        `<text x="${n(title.rect.x)}" y="${n(title.rect.y + title.rect.height / 2)}" dominant-baseline="central"` +
        ` font-size="${n(title.size)}" font-weight="600" font-family="${esc(FRAME_FONT)}" fill="${esc(titleColour(o.theme))}">${esc(title.text)}</text>`;
    }
    return out;
  },
  bounds: frameBounds,
};

export { borderOf as frameBorder, titleColour as frameTitleColour };
