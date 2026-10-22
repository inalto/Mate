// Decoded image cache for the image renderer, keyed by asset id (LRU of 128). `getImage` never
// blocks: it returns the bitmap when ready, else starts the load and returns null (the renderer
// draws the placeholder); once loaded the canvas is told to re-raster through the snapshot hook.
// The URL resolver and decoder are injectable (jsdom cannot decode images).
import { assetUrl, readAsset } from "../ipc/assets";
import { boxSnapshots } from "../renderers/boxSnapshot";

export type DecodedImage = CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width: number; height: number };
export type ImageDecoder = (url: string) => Promise<DecodedImage>;
export type UrlResolver = (assetId: string) => Promise<string | null>;

export const IMAGE_CACHE_LIMIT = 128;

const defaultDecoder: ImageDecoder = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to decode"));
    img.src = url;
  });

let decoder: ImageDecoder = defaultDecoder;
let resolver: UrlResolver = assetUrl;

const cache = new Map<string, DecodedImage>();
const pending = new Map<string, Promise<DecodedImage | null>>();
const failed = new Set<string>();

/** Replace the decoder / URL resolver (tests); call with no arguments to restore the defaults. */
export function configureImageLoader(opts: { decoder?: ImageDecoder; resolver?: UrlResolver } = {}): void {
  decoder = opts.decoder ?? defaultDecoder;
  resolver = opts.resolver ?? assetUrl;
  clearImageCache();
}

export function clearImageCache(): void {
  cache.clear();
  pending.clear();
  failed.clear();
}

function store(id: string, img: DecodedImage): void {
  cache.set(id, img);
  while (cache.size > IMAGE_CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
}

/** Load (once) and cache the image of asset `id`; null when it is missing or undecodable. */
export function loadImage(id: string): Promise<DecodedImage | null> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(id);
  if (!p) {
    p = resolver(id)
      .then((url) => (url ? decoder(url) : null))
      .then((img) => {
        if (img) store(id, img);
        else failed.add(id);
        return img;
      })
      .catch(() => {
        failed.add(id);
        return null;
      })
      .finally(() => pending.delete(id));
    pending.set(id, p);
  }
  return p;
}

/** The decoded image if cached; otherwise starts loading and returns null. */
export function getImage(id: string): DecodedImage | null {
  const hit = cache.get(id);
  if (hit) {
    cache.delete(id); // refresh LRU position
    cache.set(id, hit);
    return hit;
  }
  if (!failed.has(id) && !pending.has(id)) void loadImage(id).then((img) => img && boxSnapshots.notify(id));
  return null;
}

/** Natural size of a decoded image in pixels (0×0 when it reports none). */
export const naturalSize = (img: DecodedImage): { width: number; height: number } => ({
  width: img.naturalWidth ?? img.width ?? 0,
  height: img.naturalHeight ?? img.height ?? 0,
});

// ---- SVG export: images embedded as data URLs ----

const dataUrls = new Map<string, string>();

const MIME_BY_MAGIC: Array<[number[], string]> = [
  [[0x89, 0x50, 0x4e, 0x47], "image/png"],
  [[0xff, 0xd8, 0xff], "image/jpeg"],
  [[0x47, 0x49, 0x46], "image/gif"],
  [[0x52, 0x49, 0x46, 0x46], "image/webp"],
];

function toDataUrl(bytes: Uint8Array): string {
  const mime = MIME_BY_MAGIC.find(([magic]) => magic.every((b, i) => bytes[i] === b))?.[1] ?? "image/svg+xml";
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

let bytesReader: (id: string) => Promise<Uint8Array> = readAsset;

/** Replace the asset byte reader (tests); no argument restores the default. */
export function configureAssetBytes(read?: (id: string) => Promise<Uint8Array>): void {
  bytesReader = read ?? readAsset;
  dataUrls.clear();
}

/** The data URL prepared for asset `id` by `prepareImages`, if any. */
export const dataUrlOf = (id: string): string | undefined => dataUrls.get(id);

interface HasImage {
  type: string;
  imageUrl?: string | null;
}

/**
 * Make the images of `elements` ready for a synchronous export: decoded for PNG/thumbnails and, with
 * `embed`, also read as data URLs for SVG. Failures are skipped (those images export as frames).
 */
export async function prepareImages(elements: Iterable<HasImage>, embed = false): Promise<void> {
  const ids = new Set<string>();
  for (const el of elements) if (el.type === "image" && el.imageUrl) ids.add(el.imageUrl);
  await Promise.all(
    [...ids].map(async (id) => {
      if (embed) {
        if (!dataUrls.has(id)) {
          try {
            dataUrls.set(id, toDataUrl(await bytesReader(id)));
          } catch {
            /* exported as a frame */
          }
        }
      } else {
        await loadImage(id);
      }
    }),
  );
}
