// PDF sources: an open PDF document behind a small interface (page count, page sizes, render a page
// to a bitmap), cached per asset id (LRU of 4 open documents). The default loader uses pdf.js,
// imported lazily so the main chunk stays small; the bytes come from the asset store over IPC (no
// network fetch, so no CSP connect-src change). Tests inject a stub loader (jsdom cannot run pdf.js).
import { readAsset } from "../ipc/assets";

/** A rendered PDF page. */
export type PdfBitmap = HTMLCanvasElement;

export interface PdfSource {
  pageCount: number;
  /** Size of page `n` (1-based) in PDF points, rotation applied. */
  pageSize(n: number): Promise<{ width: number; height: number }>;
  /** Render page `n` (1-based) at `scale` device pixels per PDF point. */
  render(n: number, scale: number): Promise<PdfBitmap>;
  /** Release the document (called when evicted from the cache). */
  destroy?(): void;
}

export type PdfLoader = (assetId: string) => Promise<PdfSource>;

export const PDF_SOURCE_CACHE = 4;

// ---- pdf.js ----

type PdfJs = typeof import("pdfjs-dist");
let pdfjs: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= import("pdfjs-dist").then((m) => {
    // A module worker bundled by Vite (served from 'self'; CSP worker-src allows it).
    m.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
    return m;
  });
  pdfjs.catch(() => (pdfjs = null));
  return pdfjs;
}

/** Device-pixel ceiling for one rendered page (keeps a 4× zoom of a large page in memory bounds). */
export const MAX_RENDER_PIXELS = 16_000_000;

const pdfJsLoader: PdfLoader = async (assetId) => {
  const [lib, bytes] = await Promise.all([loadPdfJs(), readAsset(assetId)]);
  const task = lib.getDocument({ data: bytes });
  const doc = await task.promise;
  return {
    pageCount: doc.numPages,
    async pageSize(n) {
      const vp = (await doc.getPage(n)).getViewport({ scale: 1 });
      return { width: vp.width, height: vp.height };
    },
    async render(n, scale) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const cap = Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, base.width * base.height));
      const viewport = page.getViewport({ scale: Math.min(scale, cap) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      await page.render({ canvas, viewport }).promise;
      page.cleanup();
      return canvas;
    },
    destroy() {
      void task.destroy();
    },
  };
};

// ---- cache ----

let loader: PdfLoader = pdfJsLoader;
const sources = new Map<string, Promise<PdfSource>>();

/** Replace the loader (tests); no argument restores pdf.js. Clears the cache. */
export function configurePdfLoader(l?: PdfLoader): void {
  loader = l ?? pdfJsLoader;
  clearPdfSources();
}

export function clearPdfSources(): void {
  for (const p of sources.values()) void p.then((s) => s.destroy?.(), () => {});
  sources.clear();
}

/** The open document of asset `assetId` (loaded once; least recently used beyond 4 are closed). */
export function getPdfSource(assetId: string): Promise<PdfSource> {
  let p = sources.get(assetId);
  if (p) {
    sources.delete(assetId); // refresh LRU position
    sources.set(assetId, p);
    return p;
  }
  p = loader(assetId);
  sources.set(assetId, p);
  p.catch(() => {
    if (sources.get(assetId) === p) sources.delete(assetId);
  });
  while (sources.size > PDF_SOURCE_CACHE) {
    const [oldest, op] = sources.entries().next().value!;
    sources.delete(oldest);
    void op.then((s) => s.destroy?.(), () => {});
  }
  return p;
}

/** Asset ids with an open (or opening) document, least recent first (tests). */
export const openPdfSourceIds = (): string[] => [...sources.keys()];
