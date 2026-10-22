// Renderer of the boxes drawn from an HTML bitmap (text boxes, tables, code blocks). Canvas: the box's bitmap (the published snapshot or, for an unchanged
// appearance, the remembered one), asking for a sharper render when the output scale outgrows it;
// the placeholder frame until a bitmap exists. SVG: a `<foreignObject>` with the sanitised HTML.
import type { Element } from "../model/types";
import { requestTextSnapshot, snapshotScale, textSnapshotFor } from "../overlay/snapshot";
import { boxAppearance } from "../text/boxHtml";
import { boxRect } from "../tools/spatialIndex";
import { drawBoxBitmap, rotatedSvg } from "./boxDraw";
import { boxSnapshots } from "./boxSnapshot";
import type { ElementRenderer } from "./registry";

export const htmlBoxRenderer: ElementRenderer = {
  draw(ctx, el: Element, o) {
    const r = boxRect(el);
    const want = snapshotScale(o.zoomBucket * (o.pixelRatio ?? 1), r.width, r.height);
    const memo = textSnapshotFor(el, o.theme);
    if (!memo || memo.scale < want) requestTextSnapshot(el, o.theme, want);
    drawBoxBitmap(ctx, el, memo?.bitmap ?? (o.snapshots ?? boxSnapshots).get(el), o);
  },
  svg(el, o) {
    const a = boxAppearance(el, o.theme);
    return a ? rotatedSvg(el, a.foreignObject(boxRect(el))) : "";
  },
};
