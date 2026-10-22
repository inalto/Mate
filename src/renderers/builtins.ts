// Built-in renderers: ink strokes, and the boxed types (text-box, table, codespace, graph, image)
// drawn from their editor snapshot when one exists for the current revision, else as a light
// placeholder frame so the box stays visible before its editor has produced a snapshot. Text boxes, tables and code
// blocks render their own snapshots on demand and export to SVG as a `<foreignObject>` (./htmlBox).
// Imported for its side effect by the scene (exports, thumbnails) and the canvas.
import { renderStroke } from "../ink/render";
import { strokeSvg } from "../ink/strokeSvg";
import { BOXED_TYPES } from "../model/content";
import type { Element } from "../model/types";
import { boxRect } from "../tools/spatialIndex";
import { n } from "../export/svgUtil";
import { drawBoxBitmap, PLACEHOLDER_COLOR, rotatedSvg } from "./boxDraw";
import { boxSnapshots, type BoxBitmap } from "./boxSnapshot";
import { registerRenderer, type ElementRenderer, type RenderOptions } from "./registry";
import { htmlBoxRenderer } from "./htmlBox";
// Types with their own renderer module (registered on import).
import "./shape";
import "./image";

export { PLACEHOLDER_COLOR };

registerRenderer("stroke", {
  draw: (ctx, el, o) => renderStroke(ctx, el, o.theme, o.zoomBucket),
  svg: (el, o) => strokeSvg(el, o.theme, o.zoomBucket),
});

const snapshotOf = (el: Element, o: RenderOptions): BoxBitmap | null => (o.snapshots ?? boxSnapshots).get(el);

/** Snapshot-or-placeholder renderer shared by every boxed type until its own renderer replaces it. */
export const boxedRenderer: ElementRenderer = {
  draw: (ctx, el, o) => drawBoxBitmap(ctx, el, snapshotOf(el, o), o),
  svg(el, o) {
    const r = boxRect(el);
    const attrs = `x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}"`;
    const bmp = snapshotOf(el, o);
    const body =
      bmp && "toDataURL" in bmp
        ? `<image ${attrs} href="${bmp.toDataURL("image/png")}" preserveAspectRatio="none"/>`
        : `<rect ${attrs} fill="none" stroke="${PLACEHOLDER_COLOR}" stroke-width="${n(1 / o.zoomBucket)}"/>`;
    return rotatedSvg(el, body);
  },
};

for (const t of BOXED_TYPES) if (t !== "image") registerRenderer(t, boxedRenderer);
for (const t of ["text-box", "table", "codespace"] as const) registerRenderer(t, htmlBoxRenderer);
