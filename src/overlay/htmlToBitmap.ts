// Text box → bitmap: the box's `<foreignObject>` in a standalone SVG, rasterised by an injectable
// rasterizer. The default loads the SVG as an image and draws it on a canvas (needs a real browser
// engine; jsdom never loads it). Fonts are referenced by name: an SVG image cannot load web fonts,
// so faces not installed on the system fall back to the stack's next family.
import type { BoxBitmap } from "../renderers/boxSnapshot";
import { n } from "../export/svgUtil";
import type { Rect } from "../tools/spatialIndex";

/** Rasterise a standalone SVG document to a `width`×`height` device-pixel bitmap. */
export type HtmlRasterizer = (svg: string, width: number, height: number) => Promise<BoxBitmap>;

export const svgImageRasterizer: HtmlRasterizer = (svg, width, height) =>
  new Promise((resolve, reject) => {
    const img = new Image(width, height);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no 2D context for the text snapshot"));
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas);
    };
    img.onerror = () => reject(new Error("text snapshot image failed to load"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });

let rasterizer: HtmlRasterizer = svgImageRasterizer;

/** Replace the rasterizer (tests); `null` restores the default. */
export function setHtmlRasterizer(r: HtmlRasterizer | null): void {
  rasterizer = r ?? svgImageRasterizer;
}

/**
 * Bitmap of a box laid out in a `width` by `height` (page units) box, at `scale` px per unit;
 * `foreignObject(r)` builds the box's `<foreignObject>` for the rectangle `r`.
 */
export function htmlToBitmap(foreignObject: (r: Rect) => string, width: number, height: number, scale: number): Promise<BoxBitmap> {
  const w = Math.max(1, Math.ceil(width * scale));
  const h = Math.max(1, Math.ceil(height * scale));
  const fo = foreignObject({ x: 0, y: 0, width, height });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${n(width)} ${n(height)}">${fo}</svg>`;
  return rasterizer(svg, w, h);
}
