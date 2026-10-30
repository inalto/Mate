// Renderer of the boxes drawn from an HTML bitmap (text boxes, tables, code blocks). Canvas: the box's bitmap (the published snapshot or, for an unchanged
// appearance, the remembered one), asking for a sharper render when the output scale outgrows it;
// the placeholder frame until a bitmap exists. SVG: a `<foreignObject>` with the sanitised HTML.
import i18n from "../i18n";
import type { Element } from "../model/types";
import { requestTextSnapshot, snapshotScale, textBitmapKey, textSnapshotFor } from "../overlay/snapshot";
import { boxAppearance } from "../text/boxHtml";
import { boxRect } from "../tools/spatialIndex";
import { cardSvg, drawBoxBitmap, rotatedSvg } from "./boxDraw";
import { boxSnapshots } from "./boxSnapshot";
import type { ElementRenderer } from "./registry";

export const htmlBoxRenderer: ElementRenderer = {
  draw(ctx, el: Element, o) {
    const r = boxRect(el);
    if (o.textBitmaps) {
      // Export: only the bitmaps prepared for this paint's theme.
      const bmp = o.textBitmaps.get(textBitmapKey(el.id, o.theme));
      if (!bmp) {
        if (r.width > 0 && r.height > 0) throw new Error(i18n.t("export.boxMissing", { id: el.id }));
        return;
      }
      drawBoxBitmap(ctx, el, bmp, o);
      return;
    }
    const want = snapshotScale(o.zoomBucket * (o.pixelRatio ?? 1), r.width, r.height);
    const memo = textSnapshotFor(el, o.theme);
    if (!memo || memo.scale < want) requestTextSnapshot(el, o.theme, want);
    drawBoxBitmap(ctx, el, memo?.bitmap ?? (o.snapshots ?? boxSnapshots).get(el), o);
  },
  svg(el, o) {
    const a = boxAppearance(el, o.theme);
    if (!a) return "";
    const shared = !!(o.svgStyles && a.sharedCss);
    if (shared) o.svgStyles!.add(a.sharedCss!);
    return rotatedSvg(el, cardSvg(el, o.theme) + a.foreignObject(boxRect(el), { sharedCss: shared }));
  },
};
