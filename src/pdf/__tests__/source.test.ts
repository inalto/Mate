import { afterEach, describe, expect, it, vi } from "vitest";

const getDocument = vi.fn((_opts: Record<string, unknown>) => ({
  promise: Promise.resolve({ numPages: 1, getPage: vi.fn() }),
  destroy: vi.fn(async () => {}),
}));
vi.mock("pdfjs-dist", () => ({ getDocument: (o: Record<string, unknown>) => getDocument(o), GlobalWorkerOptions: {} }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs", () => ({}));
vi.mock("../../ipc/assets", () => ({ readAsset: vi.fn(async () => new Uint8Array([37, 80, 68, 70])) }));

import { clearPdfSources, getPdfSource } from "../source";

describe("pdf.js source", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearPdfSources();
  });

  it("pdf_source_passes_resource_urls", async () => {
    vi.stubGlobal("Worker", class {});
    const src = await getPdfSource("a1");
    expect(src.pageCount).toBe(1);
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(getDocument.mock.calls[0][0]).toMatchObject({
      data: new Uint8Array([37, 80, 68, 70]),
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
    });
  });
});
