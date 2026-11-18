// Clean-up modes for a rectified page: grey, and a shadow-removing "black and white" that stays
// anti-aliased rather than 1-bit so thin ink does not break up.
import type { Pixels, ScanMode } from "./types";

/** Rec. 601 luminance into r = g = b; alpha kept; new buffer. */
export function toGrey(p: Pixels): Pixels {
  const s = p.data;
  const out = new Uint8ClampedArray(s.length);
  for (let i = 0; i < s.length; i += 4) {
    const y = 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
    out[i] = out[i + 1] = out[i + 2] = y;
    out[i + 3] = s[i + 3];
  }
  return { data: out, width: p.width, height: p.height };
}

// Ratio of a pixel to its local paper level: below LO is ink, above HI is paper.
const LO = 0.55;
const HI = 0.9;

/** Divide luminance by its box blur (the paper estimate), then a steep curve; new buffer. */
export function toBlackWhite(p: Pixels): Pixels {
  const { width: w, height: h } = p;
  const s = p.data;
  const lum = new Float32Array(w * h);
  for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];

  // Integral image, one extra row and column of zeros; Float64 keeps sums exact for big pages.
  const stride = w + 1;
  const ii = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += lum[y * w + x];
      ii[(y + 1) * stride + x + 1] = ii[y * stride + x + 1] + row;
    }
  }

  const r = Math.max(4, Math.round(Math.min(w, h) / 8 / 2)); // window ~ shortSide / 8, at least 8 px
  const out = new Uint8ClampedArray(s.length);
  const span = HI - LO;
  for (let y = 0; y < h; y++) {
    const ya = y - r < 0 ? 0 : y - r;
    const yb = y + r + 1 > h ? h : y + r + 1;
    for (let x = 0; x < w; x++) {
      const xa = x - r < 0 ? 0 : x - r;
      const xb = x + r + 1 > w ? w : x + r + 1;
      const sum = ii[yb * stride + xb] - ii[ya * stride + xb] - ii[yb * stride + xa] + ii[ya * stride + xa];
      const mean = sum / ((xb - xa) * (yb - ya));
      const ratio = mean > 1 ? lum[y * w + x] / mean : 1;
      let t = (ratio - LO) / span;
      t = t <= 0 ? 0 : t >= 1 ? 1 : t;
      const v = t * t * (3 - 2 * t) * 255; // smoothstep
      const i = (y * w + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = s[i + 3];
    }
  }
  return { data: out, width: w, height: h };
}

/** "colour" returns the input itself; the others return a new buffer. */
export function applyMode(p: Pixels, mode: ScanMode): Pixels {
  return mode === "grey" ? toGrey(p) : mode === "bw" ? toBlackWhite(p) : p;
}
