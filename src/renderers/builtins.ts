// Built-in renderers: ink strokes, and the boxed types (text-box, table, codespace, graph, image)
// drawn from their editor snapshot when one exists for the current revision, else as a light
// placeholder frame so the box stays visible before its editor has produced a snapshot.
// Imported for its side effect by the scene (exports, thumbnails) and the canvas.
import { renderStroke } from "../ink/render";
import { strokeSvg } from "../ink/strokeSvg";
import { BOXED_TYPES } from "../model/content";
import type { Element } from "../model/types";
import { boxRect, contentMeta } from "../tools/spatialIndex";
import { n } from "../export/svgUtil";
import { boxSnapshots, type BoxBitmap } from "./boxSnapshot";
import { registerRenderer, type ElementRenderer, type RenderOptions } from "./registry";

export const PLACEHOLDER_COLOR = "#9aa0a6";

registerRenderer("stroke", {
  draw: (ctx, el, o) => renderStroke(ctx, el, o.theme, o.zoomBucket),
  svg: (el, o) => strokeSvg(el, o.theme, o.zoomBucket),
});

const snapshotOf = (el: Element, o: RenderOptions): BoxBitmap | null => (o.snapshots ?? boxSnapshots).get(el);

/** Snapshot-or-placeholder renderer shared by every boxed type until its own renderer replaces it. */
export const boxedRenderer: ElementRenderer = {
  draw(ctx, el, o) {
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
    const bmp = snapshotOf(el, o);
    if (bmp) {
      ctx.drawImage(bmp, r.x, r.y, r.width, r.height);
    } else {
      ctx.lineWidth = 1 / o.zoomBucket; // one output pixel
      ctx.strokeStyle = PLACEHOLDER_COLOR;
      ctx.strokeRect(r.x, r.y, r.width, r.height);
    }
    ctx.restore();
  },
  svg(el, o) {
    const r = boxRect(el);
    const rot = contentMeta(el).rotation ?? 0;
    const attrs = `x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}"`;
    const bmp = snapshotOf(el, o);
    const body =
      bmp && "toDataURL" in bmp
        ? `<image ${attrs} href="${bmp.toDataURL("image/png")}" preserveAspectRatio="none"/>`
        : `<rect ${attrs} fill="none" stroke="${PLACEHOLDER_COLOR}" stroke-width="${n(1 / o.zoomBucket)}"/>`;
    if (!rot) return body;
    const deg = (rot * 180) / Math.PI;
    return `<g transform="rotate(${n(deg)} ${n(r.x + r.width / 2)} ${n(r.y + r.height / 2)})">${body}</g>`;
  },
};

for (const t of BOXED_TYPES) registerRenderer(t, boxedRenderer);
