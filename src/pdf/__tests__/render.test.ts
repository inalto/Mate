import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boxSnapshots } from "../../renderers/boxSnapshot";
import { cachedPdfTileKeys, clearPdfTiles, getPdfTile, PDF_TILE_CACHE, renderPdfTile, zoomBucketFor } from "../render";
import { configurePdfLoader, type PdfSource } from "../source";

const flush = () => new Promise((r) => setTimeout(r, 0));

let render: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearPdfTiles();
  render = vi.fn(async (_n: number, scale: number) => Object.assign(document.createElement("canvas"), { width: Math.round(612 * scale) }));
  const source: PdfSource = { pageCount: 300, pageSize: async () => ({ width: 612, height: 792 }), render: render as never };
  configurePdfLoader(async () => source);
});
afterEach(() => configurePdfLoader());

describe("pdf tiles", () => {
  it("buckets zoom to powers of two within 0.25..4", () => {
    expect(zoomBucketFor(1)).toBe(1);
    expect(zoomBucketFor(1.1)).toBe(2);
    expect(zoomBucketFor(0.3)).toBe(0.5);
    expect(zoomBucketFor(0.01)).toBe(0.25);
    expect(zoomBucketFor(30)).toBe(4);
    expect(zoomBucketFor(Number.NaN)).toBe(1);
  });

  it("renders once per (asset, page, bucket) and notifies when ready", async () => {
    const seen: string[] = [];
    const off = boxSnapshots.subscribe((id) => seen.push(id));
    expect(getPdfTile("a", 2, 1, 1080)).toBeNull();
    expect(getPdfTile("a", 2, 1, 1080)).toBeNull(); // still rendering: no second render
    await flush();
    await flush();
    const tile = getPdfTile("a", 2, 1, 1080);
    expect(tile).not.toBeNull();
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(2, 1080 / 612); // bucket × box width / page width
    expect(seen).toContain("a");
    off();
  });

  it("shows another bucket of the same page while the wanted one renders", async () => {
    const low = await renderPdfTile("a", 1, 0.5, 1080);
    expect(getPdfTile("a", 1, 2, 1080)).toBe(low);
    await flush();
    await flush();
    expect(getPdfTile("a", 1, 2, 1080)).not.toBe(low);
  });

  it("keeps at most 64 tiles", async () => {
    for (let p = 1; p <= PDF_TILE_CACHE + 6; p++) await renderPdfTile("a", p, 0.25, 1080);
    const keys = cachedPdfTileKeys();
    expect(keys).toHaveLength(PDF_TILE_CACHE);
    expect(keys).not.toContain("a|1|0.25");
    expect(keys).toContain(`a|${PDF_TILE_CACHE + 6}|0.25`);
  });

  it("a failed render resolves to null without notifying", async () => {
    configurePdfLoader(async () => {
      throw new Error("bad pdf");
    });
    const notify = vi.spyOn(boxSnapshots, "notify");
    expect(await renderPdfTile("x", 1, 1, 1080)).toBeNull();
    expect(getPdfTile("x", 1, 1, 1080)).toBeNull();
    await flush();
    expect(notify).not.toHaveBeenCalled();
    notify.mockRestore();
  });
});
