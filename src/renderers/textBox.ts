// Text-box renderer. Canvas: the box's bitmap (the published snapshot or, for an unchanged
// appearance, the remembered one), asking for a sharper render when the output scale outgrows it;
// the placeholder frame until a bitmap exists. SVG: a `<foreignObject>` with the sanitised HTML.
import { mapInkColor } from "../ink/theme";
import type { Element } from "../model/types";
import { requestTextSnapshot, snapshotScale, textSnapshotFor } from "../overlay/snapshot";
import { textBoxForeignObject } from "../text/foreignObject";
import { textContentOf } from "../text/textBox";
import { boxRect } from "../tools/spatialIndex";
import { drawBoxBitmap, rotatedSvg } from "./boxDraw";
import { boxSnapshots } from "./boxSnapshot";
import type { ElementRenderer } from "./registry";

export const textBoxRenderer: ElementRenderer = {
  draw(ctx, el: Element, o) {
    const r = boxRect(el);
    const want = snapshotScale(o.zoomBucket * (o.pixelRatio ?? 1), r.width, r.height);
    const memo = textSnapshotFor(el, o.theme);
    if (!memo || memo.scale < want) requestTextSnapshot(el, o.theme, want);
    drawBoxBitmap(ctx, el, memo?.bitmap ?? (o.snapshots ?? boxSnapshots).get(el), o);
  },
  svg(el, o) {
    const content = textContentOf(el);
    return rotatedSvg(el, textBoxForeignObject(content, boxRect(el), mapInkColor(content.textAttributes.color, o.theme)));
  },
};
