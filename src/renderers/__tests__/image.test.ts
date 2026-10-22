import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Element } from "../../model/types";
import { configureAssetBytes, configureImageLoader, loadImage, prepareImages } from "../../images/load";
import { useSettingsStore } from "../../stores/settings";
import "../builtins";
import { drawElement, elementSvg } from "../registry";

const IMG = { width: 200, height: 100, naturalWidth: 200, naturalHeight: 100 };

function image(content?: unknown): Element {
  return {
    id: "i1",
    pageId: "p",
    type: "image",
    points: [{ x: 10, y: 20, pressure: 0.5, timestamp: 0 }],
    color: "#000",
    width: 100,
    height: 50,
    isHighlighter: false,
    imageUrl: "asset-1",
    content,
    createdAt: "t",
    updatedAt: "t",
    version: 0,
  };
}

function stubCtx() {
  const calls: unknown[][] = [];
  const filters: string[] = [];
  const ctx = {
    filter: "none",
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    translate: () => {},
    rotate: () => {},
    strokeRect: (...a: unknown[]) => calls.push(["strokeRect", ...a]),
    drawImage: function (this: { filter: string }, ...a: unknown[]) {
      filters.push(this.filter);
      calls.push(["drawImage", ...a.slice(1)]);
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, filters };
}

const setInvert = (v: boolean) => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, invertImagesInDarkMode: v } });

beforeEach(async () => {
  configureImageLoader({ resolver: async (id) => `asset://${id}`, decoder: async () => IMG as never });
  await loadImage("asset-1");
});
afterEach(() => {
  configureImageLoader();
  configureAssetBytes();
});

describe("image renderer", () => {
  it("draws the placeholder frame until the bitmap has loaded", () => {
    configureImageLoader({ resolver: () => new Promise(() => {}) });
    const { ctx, calls } = stubCtx();
    drawElement(ctx, image(), { theme: "light", zoomBucket: 1 });
    expect(calls.some((c) => c[0] === "strokeRect")).toBe(true);
    expect(calls.some((c) => c[0] === "drawImage")).toBe(false);
  });

  it("draws the bitmap into its box, honouring the crop fractions", () => {
    const { ctx, calls } = stubCtx();
    drawElement(ctx, image({ cropLeft: 0.25, cropTop: 0.5 }), { theme: "light", zoomBucket: 1 });
    expect(calls.find((c) => c[0] === "drawImage")).toEqual(["drawImage", 50, 50, 150, 50, 10, 20, 100, 50]);
  });

  it("dark_mode_inverts_when_enabled", () => {
    setInvert(true);
    const dark = stubCtx();
    drawElement(dark.ctx, image(), { theme: "dark", zoomBucket: 1 });
    expect(dark.filters).toEqual(["invert(1) hue-rotate(180deg)"]);

    const light = stubCtx();
    drawElement(light.ctx, image(), { theme: "light", zoomBucket: 1 });
    expect(light.filters).toEqual(["none"]);

    setInvert(false);
    const off = stubCtx();
    drawElement(off.ctx, image(), { theme: "dark", zoomBucket: 1 });
    expect(off.filters).toEqual(["none"]);

    setInvert(true);
    const colour = stubCtx();
    drawElement(colour.ctx, image({ isBW: false }), { theme: "high-contrast", zoomBucket: 1 });
    expect(colour.filters).toEqual(["none"]);
  });

  it("svg embeds the prepared data URL with a clipPath crop, the dark filter and rotation", async () => {
    setInvert(true);
    configureAssetBytes(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const el = image({ cropLeft: 0.25, cropRight: 0.25, rotation: Math.PI / 2 });
    await prepareImages([el], true);
    const svg = elementSvg(el, { theme: "dark", zoomBucket: 1 });
    expect(svg).toContain('href="data:image/png;base64,');
    expect(svg).toContain("<clipPath");
    expect(svg).toContain("invert(1) hue-rotate(180deg)");
    expect(svg).toContain("rotate(90");
  });

  it("svg falls back to a frame when the bytes were not prepared", () => {
    configureAssetBytes();
    const svg = elementSvg(image(), { theme: "light", zoomBucket: 1 });
    expect(svg).toContain("<rect");
    expect(svg).not.toContain("<image");
  });
});
