// Rendered PDF pages for the canvas, thumbnails and exports. A page is rendered whole into an
// offscreen canvas at a zoom bucket (a power of two of device pixels per page unit), cached LRU (64
// tiles, and a pixel budget) by (asset, page, bucket). `getPdfTile` never blocks: it returns the
// wanted tile when cached, else starts rendering it and returns another cached bucket of the same
// page (or null: the renderer draws the placeholder); when the render lands the canvas is told to
// re-raster through `boxSnapshots.notify`.
import { boxSnapshots } from "../renderers/boxSnapshot";
import { getPdfSource, type PdfBitmap } from "./source";

export const PDF_TILE_CACHE = 64;
/** Total pixels kept across cached tiles (~384 MB of RGBA). */
export const PDF_TILE_PIXEL_BUDGET = 96_000_000;
const MIN_BUCKET = 0.25;
const MAX_BUCKET = 4;
/** A failed render is not retried for this long (a broken or missing PDF must not re-render per frame). */
const RETRY_AFTER_MS = 5000;

/** Smallest power of two ≥ `scale` (device pixels per page unit), clamped to 0.25..4. */
export function zoomBucketFor(scale: number): number {
  if (!(scale > 0) || !Number.isFinite(scale)) return scale === Infinity ? MAX_BUCKET : 1;
  const b = 2 ** Math.ceil(Math.log2(scale) - 1e-9);
  return Math.min(MAX_BUCKET, Math.max(MIN_BUCKET, b));
}

const keyOf = (assetId: string, page: number, bucket: number) => `${assetId}|${page}|${bucket}`;

const tiles = new Map<string, PdfBitmap>();
const pending = new Map<string, Promise<PdfBitmap | null>>();
const failedAt = new Map<string, number>();
const dataUrls = new Map<string, string>();

const pixels = (b: PdfBitmap) => b.width * b.height;

function store(key: string, bmp: PdfBitmap): void {
  tiles.delete(key);
  tiles.set(key, bmp);
  let total = 0;
  for (const t of tiles.values()) total += pixels(t);
  for (const [k, t] of tiles) {
    if (tiles.size <= 1 || (tiles.size <= PDF_TILE_CACHE && total <= PDF_TILE_PIXEL_BUDGET)) break;
    if (k === key) continue;
    tiles.delete(k);
    total -= pixels(t);
  }
}

export function clearPdfTiles(): void {
  tiles.clear();
  pending.clear();
  failedAt.clear();
  dataUrls.clear();
}

/** Cached tile keys `asset|page|bucket`, least recent first (tests). */
export const cachedPdfTileKeys = (): string[] => [...tiles.keys()];

/**
 * Render (once) page `page` (1-based) of PDF asset `assetId` at `bucket` device pixels per page unit
 * for a box `boxWidth` units wide; null when the PDF cannot be rendered.
 */
export function renderPdfTile(assetId: string, page: number, bucket: number, boxWidth: number): Promise<PdfBitmap | null> {
  const key = keyOf(assetId, page, bucket);
  const hit = tiles.get(key);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(key);
  if (!p) {
    p = (async () => {
      try {
        const src = await getPdfSource(assetId);
        const size = await src.pageSize(page);
        const bmp = await src.render(page, (bucket * boxWidth) / Math.max(1, size.width));
        store(key, bmp);
        failedAt.delete(key);
        return bmp;
      } catch {
        failedAt.set(key, Date.now());
        return null;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, p);
  }
  return p;
}

/** The tile if cached (else another bucket of the same page, or null), starting its render. */
export function getPdfTile(assetId: string, page: number, bucket: number, boxWidth: number): PdfBitmap | null {
  const key = keyOf(assetId, page, bucket);
  const hit = tiles.get(key);
  if (hit) {
    tiles.delete(key); // refresh LRU position
    tiles.set(key, hit);
    return hit;
  }
  const failed = failedAt.get(key);
  if (!pending.has(key) && (failed === undefined || Date.now() - failed > RETRY_AFTER_MS)) {
    void renderPdfTile(assetId, page, bucket, boxWidth).then((bmp) => {
      if (bmp) boxSnapshots.notify(assetId);
    });
  }
  // Meanwhile: the sharpest other bucket of this page.
  const prefix = `${assetId}|${page}|`;
  let best: PdfBitmap | null = null;
  for (const [k, t] of tiles) if (k.startsWith(prefix) && (!best || pixels(t) > pixels(best))) best = t;
  return best;
}

interface HasPdf {
  type: string;
  width: number;
  content?: unknown;
}

/** Key of a PDF page in a prepared tile set (`asset|page`). */
export const pdfPageKey = (assetId: string, page: number): string => `${assetId}|${page}`;

/** Tiles prepared for one synchronous paint, by `pdfPageKey` (see RenderOptions.pdfTiles). */
export type PdfTileSet = ReadonlyMap<string, PdfBitmap>;

/** Renders `preparePdfPages` runs at once (each allocates its whole canvas up front). */
export const PREPARE_CONCURRENCY = 3;

/** Distinct PDF pages shown by `elements` (first box width wins), in element order. */
function placements(elements: Iterable<HasPdf>): Array<{ assetId: string; page: number; boxWidth: number }> {
  const out = new Map<string, { assetId: string; page: number; boxWidth: number }>();
  for (const el of elements) {
    if (el.type !== "image" || !el.content || typeof el.content !== "object") continue;
    const c = el.content as { pdfSourceKey?: unknown; pdfPageIndex?: unknown };
    if (typeof c.pdfSourceKey !== "string") continue;
    const page = typeof c.pdfPageIndex === "number" && c.pdfPageIndex >= 1 ? Math.floor(c.pdfPageIndex) : 1;
    const key = pdfPageKey(c.pdfSourceKey, page);
    if (!out.has(key)) out.set(key, { assetId: c.pdfSourceKey, page, boxWidth: el.width });
  }
  return [...out.values()];
}

/** Render one page for an export without touching the on-screen LRU (a cached tile is reused). */
async function renderUncached(assetId: string, page: number, bucket: number, boxWidth: number): Promise<PdfBitmap | null> {
  const key = keyOf(assetId, page, bucket);
  const hit = tiles.get(key) ?? (await pending.get(key));
  if (hit) return hit;
  try {
    const src = await getPdfSource(assetId);
    const size = await src.pageSize(page);
    return await src.render(page, (bucket * boxWidth) / Math.max(1, size.width));
  } catch {
    return null;
  }
}

/**
 * Render the PDF pages of `elements` at `scale` (output pixels per page unit) for one synchronous
 * paint: at most 3 renders at a time, in element order, never through the on-screen tile LRU (an
 * export of a long PDF must neither evict what the canvas shows nor lose its own tiles to eviction).
 * With `keep` the bitmaps are returned, to be passed to the paint as `pdfTiles`; with `embed` each
 * page becomes a PNG data URL for SVG (`pdfDataUrlOf`) as soon as it is rendered, and its canvas is
 * let go.
 */
export async function preparePdfPages(
  elements: Iterable<HasPdf>,
  scale: number,
  opts: { keep?: boolean; embed?: boolean } = {},
): Promise<Map<string, PdfBitmap>> {
  const bucket = zoomBucketFor(scale);
  const kept = new Map<string, PdfBitmap>();
  if (opts.embed) dataUrls.clear(); // only the export being prepared needs them
  const queue = placements(elements);
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const { assetId, page, boxWidth } = queue[next++];
      const bmp = await renderUncached(assetId, page, bucket, boxWidth);
      if (!bmp) continue;
      const key = pdfPageKey(assetId, page);
      if (opts.keep) kept.set(key, bmp);
      if (opts.embed) {
        try {
          dataUrls.set(key, bmp.toDataURL("image/png"));
        } catch {
          /* exported as a frame */
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PREPARE_CONCURRENCY, queue.length) }, worker));
  return kept;
}

/** PNG data URL of a PDF page prepared by `preparePdfPages(.., { embed: true })`, if any. */
export const pdfDataUrlOf = (assetId: string, page: number): string | undefined => dataUrls.get(pdfPageKey(assetId, page));
