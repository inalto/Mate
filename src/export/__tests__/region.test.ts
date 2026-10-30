import { describe, expect, it, vi } from "vitest";
import { copySelectionAsImage } from "../copyImage";
import { renderToCanvas } from "../renderToCanvas";
import { renderToSvg } from "../renderToSvg";
import { createEditorStore } from "../../stores/editor";
import type { Element, Page } from "../../model/types";

const STAMP = "2026-01-01T00:00:00.000Z";
const page: Page = {
  id: "p1", sectionId: "s1", title: "T", isExpanded: false, isFavourite: false, depth: 0, mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 }, thumbnailVersion: 0, orderIndex: 0,
  createdAt: STAMP, updatedAt: STAMP, version: 0,
};
const box: Element = {
  id: "a", pageId: "p1", type: "shape", points: [{ x: 500, y: 500, pressure: 1, timestamp: 0 }, { x: 900, y: 800, pressure: 1, timestamp: 1 }],
  color: "#000000", width: 4, createdAt: STAMP, updatedAt: STAMP, version: 1,
} as unknown as Element;
const opts = { scale: 1, theme: "light" as const, background: "plain" as const, pageFrame: true };
const region = { x: 100, y: 200, width: 300, height: 150 };

describe("region export", () => {
  it("svg uses the region as viewBox", () => {
    const svg = renderToSvg([box], page, { ...opts, region });
    expect(svg).toContain('viewBox="100 200 300 150"');
    expect(svg).toContain('width="300"');
  });

  it("png canvas has the region size at scale", () => {
    // jsdom has no 2d context: a no-op one is enough to check the canvas geometry.
    const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    try {
      const canvas = renderToCanvas([], page, { ...opts, scale: 2, region });
      expect(canvas.width).toBe(600);
      expect(canvas.height).toBe(300);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("copySelectionAsImage", () => {
  it("returns false without a clipboard API", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      expect(await copySelectionAsImage(createEditorStore())).toBe(false);
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });

  it("returns false with no selection", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { write: async () => {} }, configurable: true });
    try {
      expect(await copySelectionAsImage(createEditorStore())).toBe(false);
    } finally {
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });
});
