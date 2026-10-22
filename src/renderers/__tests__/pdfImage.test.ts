import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Element } from "../../model/types";
import { clearPdfTiles, preparePdfPages, renderPdfTile } from "../../pdf/render";
import { configurePdfLoader } from "../../pdf/source";
import { useSettingsStore } from "../../stores/settings";
import "../builtins";
import { drawElement, elementSvg } from "../registry";

const placement: Element = {
  id: "pl",
  pageId: "p",
  type: "image",
  points: [{ x: 0, y: 1422, pressure: 0.5, timestamp: 0 }],
  color: "#000000",
  width: 1080,
  height: 1398,
  isHighlighter: false,
  content: { pdfSourceKey: "pdf-1", pdfPageIndex: 2, zIndex: -1_000_000 },
  createdAt: "t",
  updatedAt: "t",
  version: 0,
};

function stubCtx() {
  const calls: unknown[][] = [];
  const filters: string[] = [];
  const ctx = {
    filter: "none",
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    fillRect: (...a: unknown[]) => calls.push(["fillRect", ...a]),
    strokeRect: (...a: unknown[]) => calls.push(["strokeRect", ...a]),
    drawImage: function (this: { filter: string }, ...a: unknown[]) {
      filters.push(this.filter);
      calls.push(["drawImage", ...a]);
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, filters };
}

let rendered: HTMLCanvasElement;
const render = vi.fn();

beforeEach(() => {
  clearPdfTiles();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, invertImagesInDarkMode: true } });
  rendered = document.createElement("canvas");
  rendered.toDataURL = () => "data:image/png;base64,QUJD";
  render.mockReset().mockImplementation(async () => rendered);
  configurePdfLoader(async () => ({ pageCount: 3, pageSize: async () => ({ width: 612, height: 792 }), render }));
});
afterEach(() => configurePdfLoader());

describe("image renderer: PDF pages", () => {
  it("draws a placeholder until the page is rendered, then the page bitmap in the box", async () => {
    const before = stubCtx();
    drawElement(before.ctx, placement, { theme: "light", zoomBucket: 1 });
    expect(before.calls.some((c) => c[0] === "drawImage")).toBe(false);
    expect(before.calls.some((c) => c[0] === "strokeRect" || c[0] === "fillRect")).toBe(true);

    await renderPdfTile("pdf-1", 2, 1, 1080);
    const after = stubCtx();
    drawElement(after.ctx, placement, { theme: "light", zoomBucket: 1 });
    expect(after.calls.find((c) => c[0] === "drawImage")).toEqual(["drawImage", rendered, 0, 1422, 1080, 1398]);
  });

  it("asks for the bucket matching zoom × pixel ratio", () => {
    drawElement(stubCtx().ctx, placement, { theme: "light", zoomBucket: 0.8, pixelRatio: 2 });
    return vi.waitFor(() => expect(render).toHaveBeenCalledWith(2, (2 * 1080) / 612));
  });

  it("inverts in dark themes like images", async () => {
    await renderPdfTile("pdf-1", 2, 1, 1080);
    const dark = stubCtx();
    drawElement(dark.ctx, placement, { theme: "dark", zoomBucket: 1 });
    expect(dark.filters).toEqual(["invert(1) hue-rotate(180deg)"]);
  });

  it("svg embeds the prepared page as a PNG data URL", async () => {
    expect(elementSvg(placement, { theme: "light", zoomBucket: 1 })).not.toContain("<image");
    await preparePdfPages([placement], 2, true);
    expect(render).toHaveBeenCalledWith(2, (2 * 1080) / 612);
    const svg = elementSvg(placement, { theme: "light", zoomBucket: 1 });
    expect(svg).toContain('href="data:image/png;base64,QUJD"');
    expect(svg).toContain('width="1080"');
  });
});
