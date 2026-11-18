// Browser I/O for the scan screen: the only scan module that touches Image, canvas or toBlob.
// Everything else in src/scan works on plain Pixels. Decode and encode are injectable because jsdom
// can neither decode an image nor give a canvas a 2D context.
import type { Pixels } from "./types";

/**
 * Long side of the decoded working copy. iOS refuses canvases much above ~16 megapixels, and the
 * output is capped at 2400 px anyway, so a 12-megapixel photo is never held at full size.
 */
export const WORKING_MAX = 3000;

type Decode = (source: Blob | CanvasImageSource, max?: number) => Promise<Pixels>;
type Encode = (p: Pixels, type: "image/jpeg" | "image/png", quality?: number) => Promise<Blob>;

/** Natural size of anything drawImage accepts (a video reports its frame, not its box). */
function sourceSize(s: CanvasImageSource): { width: number; height: number } {
  if (typeof HTMLVideoElement !== "undefined" && s instanceof HTMLVideoElement) return { width: s.videoWidth, height: s.videoHeight };
  if (typeof HTMLImageElement !== "undefined" && s instanceof HTMLImageElement) return { width: s.naturalWidth, height: s.naturalHeight };
  const any = s as { width: number | SVGAnimatedLength; height: number | SVGAnimatedLength };
  const n = (v: number | SVGAnimatedLength) => (typeof v === "number" ? v : v.baseVal.value);
  return { width: n(any.width), height: n(any.height) };
}

/** An <img> rather than createImageBitmap: WebKit applies the EXIF orientation reliably only here. */
function decodeBlob(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to decode"));
    img.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

const defaultDecode: Decode = async (source, max = WORKING_MAX) => {
  const img = source instanceof Blob ? await decodeBlob(source) : source;
  const { width, height } = sourceSize(img);
  if (!(width > 0 && height > 0)) throw new Error("empty image");
  const k = Math.min(1, max / Math.max(width, height));
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  return { data, width: w, height: h };
};

const defaultEncode: Encode = (p, type, quality) =>
  new Promise((resolve, reject) => {
    const canvas = pixelsToCanvas(p);
    if (!canvas.getContext("2d")) return reject(new Error("no 2d context"));
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))), type, quality);
  });

let decode: Decode = defaultDecode;
let encode: Encode = defaultEncode;

/** Decoded with the browser (EXIF orientation applied), long side capped at `max`. */
export function sourceToPixels(source: Blob | CanvasImageSource, max = WORKING_MAX): Promise<Pixels> {
  return decode(source, max);
}

export function pixelsToBlob(p: Pixels, type: "image/jpeg" | "image/png", quality?: number): Promise<Blob> {
  return encode(p, type, quality);
}

/** Replace decode / encode (tests); no argument restores the browser implementations. */
export function configureScanPixels(io: { decode?: typeof sourceToPixels; encode?: typeof pixelsToBlob } = {}): void {
  decode = io.decode ?? defaultDecode;
  encode = io.encode ?? defaultEncode;
}

/** Quarter turn clockwise into a new buffer: source (x, y) lands at (height − 1 − y, x). */
export function rotate90(p: Pixels): Pixels {
  const { width: w, height: h } = p;
  // Whole pixels move as one 32-bit word; a view needs a 4-aligned offset, so copy the rare one that is not.
  const s = p.data.byteOffset % 4 === 0 ? p.data : new Uint8ClampedArray(p.data);
  const out = new Uint8ClampedArray(s.length);
  const u32in = new Uint32Array(s.buffer, s.byteOffset, w * h);
  const u32out = new Uint32Array(out.buffer, 0, w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const nx = h - 1 - y;
    for (let x = 0; x < w; x++) u32out[x * h + nx] = u32in[row + x];
  }
  return { data: out, width: h, height: w };
}

/** A canvas holding `p` at its own size; blank where there is no 2D context (jsdom). */
export function pixelsToCanvas(p: Pixels): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = p.width;
  canvas.height = p.height;
  canvas.getContext("2d")?.putImageData(new ImageData(p.data, p.width, p.height), 0, 0);
  return canvas;
}
