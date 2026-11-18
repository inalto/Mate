// Perspective warp: rectifies the photographed page quad into an upright rectangle.
// H maps the output rectangle onto the quad, so no matrix inversion is needed per pixel.
import { solveHomography } from "./homography";
import type { Pixels, Quad } from "./types";

/** Bilinear sample at output pixel centres, border clamped, alpha 255. Throws on a degenerate quad. */
export function warpPerspective(src: Pixels, quad: Quad, outW: number, outH: number): Pixels {
  const rect: Quad = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  const H = solveHomography(rect, quad);
  if (!H) throw new Error("degenerate quad");
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;
  const sw = src.width;
  const sh = src.height;
  const s = src.data;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const maxX = sw - 1;
  const maxY = sh - 1;
  let o = 0;
  for (let y = 0; y < outH; y++) {
    const py = y + 0.5;
    for (let x = 0; x < outW; x++) {
      const px = x + 0.5;
      const w = h6 * px + h7 * py + h8;
      // -0.5: source pixel centres sit at integer + 0.5.
      let sx = (h0 * px + h1 * py + h2) / w - 0.5;
      let sy = (h3 * px + h4 * py + h5) / w - 0.5;
      if (!(sx > 0)) sx = 0; // also catches NaN
      else if (sx > maxX) sx = maxX;
      if (!(sy > 0)) sy = 0;
      else if (sy > maxY) sy = maxY;
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = sx - x0;
      const fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      out[o] = s[i00] * w00 + s[i10] * w10 + s[i01] * w01 + s[i11] * w11;
      out[o + 1] = s[i00 + 1] * w00 + s[i10 + 1] * w10 + s[i01 + 1] * w01 + s[i11 + 1] * w11;
      out[o + 2] = s[i00 + 2] * w00 + s[i10 + 2] * w10 + s[i01 + 2] * w01 + s[i11 + 2] * w11;
      out[o + 3] = 255;
      o += 4;
    }
  }
  return { data: out, width: outW, height: outH };
}
