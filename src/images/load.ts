// Decoded image cache for the image renderer, keyed by asset id (LRU of 128). `getImage` never
// blocks: it returns the bitmap when ready, else starts the load and returns null (the renderer
// draws the placeholder); once loaded the canvas is told to re-raster through the snapshot hook.
// The URL resolver and decoder are injectable (jsdom cannot decode images).
import { assetUrl, readAsset } from "../ipc/assets";
import { boxSnapshots } from "../renderers/boxSnapshot";

export type DecodedImage = CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width: number; height: number };
export type ImageDecoder = (url: string) => Promise<DecodedImage>;
export type UrlResolver = (assetId: string) => Promise<string | null>;

export const IMAGE_CACHE_LIMIT = 512;

let cacheLimit = IMAGE_CACHE_LIMIT;

/**
 * Decoder using `ImageCtor`. Assets are served from `http://asset.localhost`, cross-origin to the
 * app: without `crossOrigin` they would taint the canvas and break PNG export and thumbnails.
 */
export const createDecoder =
  (ImageCtor: new () => HTMLImageElement = Image): ImageDecoder =>
  (url) =>
    new Promise((resolve, reject) => {
      const img = new ImageCtor();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image failed to decode"));
      img.crossOrigin = "anonymous"; // must precede src
      img.src = url;
    });

const defaultDecoder: ImageDecoder = (url) => createDecoder()(url);

let decoder: ImageDecoder = defaultDecoder;
let resolver: UrlResolver = assetUrl;

interface Entry {
  img: DecodedImage;
  /** Generation (raster pass) in which the entry was last requested or stored. */
  gen: number;
}

const cache = new Map<string, Entry>();
/** Generation of the last request per asset id (pruned to the last few generations). */
const requested = new Map<string, number>();
// A raster pass runs synchronously, so the generation advances on a microtask after the first
// request of a pass. Entries touched in the current generation are never evicted: a pass that
// needs more images than the cap would otherwise evict what it just drew and never settle.
let gen = 0;
let advancing = false;
function touchGeneration(): void {
  if (advancing) return;
  advancing = true;
  queueMicrotask(() => {
    advancing = false;
    gen++;
    for (const [id, g] of requested) if (g < gen - 2) requested.delete(id);
  });
}
const pending = new Map<string, Promise<DecodedImage | null>>();
const failed = new Set<string>();

/** Replace the decoder / URL resolver (tests); call with no arguments to restore the defaults. */
export function configureImageLoader(opts: { decoder?: ImageDecoder; resolver?: UrlResolver; cacheLimit?: number } = {}): void {
  cacheLimit = opts.cacheLimit ?? IMAGE_CACHE_LIMIT;
  decoder = opts.decoder ?? defaultDecoder;
  resolver = opts.resolver ?? assetUrl;
  clearImageCache();
}

export function clearImageCache(): void {
  cache.clear();
  requested.clear();
  pending.clear();
  failed.clear();
}

function store(id: string, img: DecodedImage): void {
  cache.set(id, { img, gen });
  for (const [k, e] of cache) {
    if (cache.size <= cacheLimit) break;
    if (e.gen < gen) cache.delete(k);
  }
}

/** Ids currently cached (tests). */
export const cachedImageIds = (): string[] => [...cache.keys()];

/** Load (once) and cache the image of asset `id`; null when it is missing or undecodable. */
export function loadImage(id: string): Promise<DecodedImage | null> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit.img);
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
  touchGeneration();
  requested.set(id, gen);
  const hit = cache.get(id);
  if (hit) {
    cache.delete(id); // refresh LRU position
    hit.gen = gen;
    cache.set(id, hit);
    return hit.img;
  }
  if (!failed.has(id) && !pending.has(id)) {
    void loadImage(id).then((img) => {
      // Tell the canvas only if a recent raster still wants this image.
      if (img && gen - (requested.get(id) ?? -10) <= 2) boxSnapshots.notify(id);
    });
  }
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
