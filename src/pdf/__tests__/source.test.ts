import { afterEach, describe, expect, it, vi } from "vitest";

const getDocument = vi.fn((_opts: Record<string, unknown>) => ({
  promise: Promise.resolve({ numPages: 1, getPage: vi.fn() }),
  destroy: vi.fn(async () => {}),
}));
const modern = vi.hoisted(() => ({ GlobalWorkerOptions: {} as Record<string, unknown> }));
const legacy = vi.hoisted(() => ({ GlobalWorkerOptions: {} as Record<string, unknown> }));
vi.mock("pdfjs-dist", () => ({ getDocument: (o: Record<string, unknown>) => getDocument(o), GlobalWorkerOptions: modern.GlobalWorkerOptions }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument: (o: Record<string, unknown>) => getDocument(o), GlobalWorkerOptions: legacy.GlobalWorkerOptions }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/modern-worker.js" }));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/legacy-worker.js" }));
vi.mock("../../ipc/assets", () => ({ readAsset: vi.fn(async () => new Uint8Array([37, 80, 68, 70])) }));

import { setPlatformForTests } from "../../platform";
import { clearPdfSources, getPdfSource, resetPdfJsForTests } from "../source";

describe("pdf.js source", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearPdfSources();
    resetPdfJsForTests();
    setPlatformForTests(false);
    delete modern.GlobalWorkerOptions.workerPort;
    delete legacy.GlobalWorkerOptions.workerPort;
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

  for (const [mobile, name, opts, url] of [
    [true, "legacy", legacy, "/legacy-worker.js"],
    [false, "modern", modern, "/modern-worker.js"],
  ] as const) {
    it(`pdf_source_uses_the_${name}_build_when_mobile_is_${mobile}`, async () => {
      const urls: string[] = [];
      vi.stubGlobal("Worker", class { constructor(u: string) { urls.push(u); } });
      setPlatformForTests(mobile);
      await getPdfSource("a-" + name);
      expect(urls).toEqual([url]);
      expect(opts.GlobalWorkerOptions.workerPort).toBeDefined();
    });
  }
});
