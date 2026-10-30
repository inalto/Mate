import { describe, expect, it, vi } from "vitest";

const png = vi.hoisted(() => ({ render: vi.fn(async () => new Uint8Array([137, 80, 78, 71])) }));
vi.mock("../exportPage", () => ({ renderPagePng: png.render }));

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

  it("svg region carries only the elements it overlaps", () => {
    const near = { ...box, id: "near", points: [{ x: 150, y: 250, pressure: 1, timestamp: 0 }, { x: 200, y: 300, pressure: 1, timestamp: 1 }] } as Element;
    const svg = renderToSvg([box, near], page, { ...opts, region });
    // Same output as exporting only `near` over the region: `box` (500..900) is not in the file.
    expect(svg).toBe(renderToSvg([near], page, { ...opts, region }));
    expect(svg).not.toBe(renderToSvg([], page, { ...opts, region })); // `near` is drawn
  });

  it("page_mode_region_keeps_the_ruled_lines_of_its_sheet", () => {
    const ruled: Page = { ...page, mode: "page", backgroundConfig: { type: "ruled", spacing: 40, dotRadius: 1.5 } };
    const ys = (s: string) => [...s.matchAll(/<line x1="[^"]*" y1="([^"]*)" x2="[^"]*" y2="([^"]*)"/g)].filter((m) => m[1] === m[2]).map((m) => Number(m[1]));
    // A region well down the stack (sheet 2 and later): every horizontal rule it draws lies on a
    // rule of the full page export (same per-sheet origin), none is shifted by the page gap.
    const deep = { ...box, points: [{ x: 10, y: 5000, pressure: 1, timestamp: 0 }, { x: 20, y: 5010, pressure: 1, timestamp: 1 }] } as Element;
    const fullYs = new Set(ys(renderToSvg([deep], ruled, { ...opts, pageFrame: false })));
    const part = ys(renderToSvg([deep], ruled, { ...opts, region: { x: 50, y: 1500, width: 300, height: 1200 } }));
    expect(part.length).toBeGreaterThan(0);
    for (const y of part) expect(fullYs.has(y)).toBe(true);
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

  class FakeItem {
    readonly items: Record<string, Promise<Blob> | Blob>;
    constructor(items: Record<string, Promise<Blob> | Blob>) {
      this.items = items;
    }
  }

  it("returns false with no selection", async () => {
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
    vi.stubGlobal("ClipboardItem", FakeItem);
    try {
      expect(await copySelectionAsImage(createEditorStore())).toBe(false);
      expect(write).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });

  it("writes a pending png item synchronously and returns false when the write is refused", async () => {
    const write = vi.fn(async (_items: FakeItem[]) => {});
    Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
    vi.stubGlobal("ClipboardItem", FakeItem);
    try {
      const store = createEditorStore();
      store.setState({ elements: new Map([[box.id, box]]), selection: new Set([box.id]), loadedPageId: "p1" });
      const done = copySelectionAsImage(store);
      // Called before anything is awaited (WebKit user-activation rule), with a Promise<Blob>.
      expect(write).toHaveBeenCalledTimes(1);
      const item = write.mock.calls[0][0][0];
      expect(item.items["image/png"]).toBeInstanceOf(Promise);
      expect(await done).toBe(true);
      const blob = await item.items["image/png"];
      expect(blob.type).toBe("image/png");
      expect(png.render).toHaveBeenCalledWith("p1", expect.objectContaining({ region: { x: 482, y: 482, width: 436, height: 336 } }));
      write.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
      expect(await copySelectionAsImage(store)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });
});
