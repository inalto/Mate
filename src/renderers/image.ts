// Image renderer. Canvas: the decoded bitmap (cropped by `content.crop*` fractions, rotated about
// the box centre), the placeholder frame until it has loaded. In dark themes, images are inverted
// (invert + hue-rotate keeps hues) when the setting is on and the image is black-and-white
// (`isBW`, default true). SVG: the image embedded as a data URL (prepared by `prepareImages`),
// cropped through a clipPath. PDF page placements (`content.pdfSourceKey`) draw the rendered page
// tile for the current zoom bucket instead (pdf/render), with the same dark-theme inversion; SVG
// embeds the page rendered by `preparePdfPages` as a PNG data URL.
import { n } from "../export/svgUtil";
import { dataUrlOf, getImage, naturalSize } from "../images/load";
import { isDarkTheme } from "../ink/theme";
import type { ThemeName } from "../ink/types";
import { contentOf, type ImageContent } from "../model/content";
import { getPdfTile, pdfDataUrlOf, pdfPageKey, zoomBucketFor } from "../pdf/render";
import type { Element } from "../model/types";
import { useSettingsStore } from "../stores/settings";
import { boxRect } from "../tools/spatialIndex";
import { drawBoxBitmap, PLACEHOLDER_COLOR, rotatedSvg } from "./boxDraw";
import { registerRenderer, type ElementRenderer, type RenderOptions } from "./registry";

export const INVERT_FILTER = "invert(1) hue-rotate(180deg)";

const clamp01 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Crop fractions of the source image (each axis drops its crop if nothing would remain). */
export function cropOf(el: Element): { left: number; top: number; right: number; bottom: number } {
  const c = contentOf<ImageContent>(el);
  let left = clamp01(c.cropLeft);
  let right = clamp01(c.cropRight);
  let top = clamp01(c.cropTop);
  let bottom = clamp01(c.cropBottom);
  if (left + right > 0.99) [left, right] = [0, 0];
  if (top + bottom > 0.99) [top, bottom] = [0, 0];
  return { left, top, right, bottom };
}

export function shouldInvert(el: Element, theme: ThemeName): boolean {
  if (!isDarkTheme(theme) || !useSettingsStore.getState().settings.invertImagesInDarkMode) return false;
  return contentOf<ImageContent>(el).isBW ?? true;
}

/** The PDF page an element shows, if it is a PDF placement. */
function pdfPageOf(el: Element): { assetId: string; page: number } | null {
  const c = contentOf<ImageContent>(el);
  if (typeof c.pdfSourceKey !== "string") return null;
  const page = typeof c.pdfPageIndex === "number" && c.pdfPageIndex >= 1 ? Math.floor(c.pdfPageIndex) : 1;
  return { assetId: c.pdfSourceKey, page };
}

function drawPdfPage(ctx: CanvasRenderingContext2D, el: Element, pdf: { assetId: string; page: number }, o: RenderOptions): void {
  const r = boxRect(el);
  const bucket = zoomBucketFor(o.zoomBucket * (o.pixelRatio ?? 1));
  const tile = o.pdfTiles?.get(pdfPageKey(pdf.assetId, pdf.page)) ?? getPdfTile(pdf.assetId, pdf.page, bucket, r.width);
  if (!tile) return drawBoxBitmap(ctx, el, null, o);
  ctx.save();
  if (shouldInvert(el, o.theme)) ctx.filter = INVERT_FILTER;
  ctx.drawImage(tile, r.x, r.y, r.width, r.height);
  ctx.restore();
}

function pdfPageSvg(el: Element, pdf: { assetId: string; page: number }, o: RenderOptions): string {
  const r = boxRect(el);
  const href = pdfDataUrlOf(pdf.assetId, pdf.page);
  if (!href) {
    return `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}" fill="none" stroke="${PLACEHOLDER_COLOR}" stroke-width="${n(1 / o.zoomBucket)}"/>`;
  }
  const filter = shouldInvert(el, o.theme) ? ` style="filter:${INVERT_FILTER}"` : "";
  return `<image x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}" href="${href}" preserveAspectRatio="none"${filter}/>`;
}

export const imageRenderer: ElementRenderer = {
  draw(ctx, el, o) {
    const pdf = pdfPageOf(el);
    if (pdf) return drawPdfPage(ctx, el, pdf, o);
    const img = el.imageUrl ? getImage(el.imageUrl) : null;
    if (!img) return drawBoxBitmap(ctx, el, null, o);
    const r = boxRect(el);
    const rot = contentOf<ImageContent>(el).rotation ?? 0;
    const { width: nw, height: nh } = naturalSize(img);
    const crop = cropOf(el);
    ctx.save();
    if (rot) {
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.translate(-cx, -cy);
    }
    if (shouldInvert(el, o.theme)) ctx.filter = INVERT_FILTER;
    ctx.drawImage(
      img,
      nw * crop.left,
      nh * crop.top,
      nw * (1 - crop.left - crop.right),
      nh * (1 - crop.top - crop.bottom),
      r.x,
      r.y,
      r.width,
      r.height,
    );
    ctx.restore();
  },
  svg(el, o) {
    const pdf = pdfPageOf(el);
    if (pdf) return pdfPageSvg(el, pdf, o);
    const r = boxRect(el);
    const href = el.imageUrl ? dataUrlOf(el.imageUrl) : undefined;
    if (!href) {
      const frame = `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}" fill="none" stroke="${PLACEHOLDER_COLOR}" stroke-width="${n(1 / o.zoomBucket)}"/>`;
      return rotatedSvg(el, frame);
    }
    const crop = cropOf(el);
    // The full (uncropped) image is laid out so the kept part exactly fills the box.
    const fw = r.width / (1 - crop.left - crop.right);
    const fh = r.height / (1 - crop.top - crop.bottom);
    const fx = r.x - crop.left * fw;
    const fy = r.y - crop.top * fh;
    const clipId = `clip-${el.id.replace(/[^A-Za-z0-9_-]/g, "")}`;
    const filter = shouldInvert(el, o.theme) ? ` style="filter:${INVERT_FILTER}"` : "";
    const body =
      `<clipPath id="${clipId}"><rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}"/></clipPath>` +
      `<g clip-path="url(#${clipId})"><image x="${n(fx)}" y="${n(fy)}" width="${n(fw)}" height="${n(fh)}" href="${href}" preserveAspectRatio="none"${filter}/></g>`;
    return rotatedSvg(el, body);
  },
};

registerRenderer("image", imageRenderer);
