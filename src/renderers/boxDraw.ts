// Drawing helpers shared by the boxed-element renderers: a bitmap (or the placeholder frame) in the
// element's box, and SVG rotated about the box centre.
import { n } from "../export/svgUtil";
import type { Element } from "../model/types";
import { boxRect, contentMeta } from "../tools/spatialIndex";
import type { BoxBitmap } from "./boxSnapshot";
import type { RenderOptions } from "./registry";

export const PLACEHOLDER_COLOR = "#9aa0a6";

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
