import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));
vi.mock("../ipc/notebook", () => ({}));
vi.mock("../ipc/thumbnails", () => ({ saveThumbnail: vi.fn() }));

import type { Element, Page } from "../model/types";
import { thumbnailRegion } from "../thumbnails";

const page = (mode: Page["mode"]): Page => ({
  id: "p", sectionId: "s", title: "t", isExpanded: true, isFavourite: false, depth: 0, mode,
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 }, thumbnailVersion: 0, orderIndex: 0,
  createdAt: "", updatedAt: "", version: 0,
});
const stroke = (x: number, y: number): Element => ({
  id: "e", pageId: "p", type: "stroke", color: "#000000", width: 2, isHighlighter: false,
  points: [{ x, y, pressure: 0.5, timestamp: 0 }, { x: x + 100, y: y + 50, pressure: 0.5, timestamp: 1 }],
  createdAt: "", updatedAt: "", version: 0,
});

describe("thumbnailRegion", () => {
  it("page_mode_uses_first_sheet", () => {
    expect(thumbnailRegion(page("page"), [], "a4")).toEqual({ x: 0, y: 0, width: 1080, height: 1528 });
  });
  it("canvas_mode_frames_content_with_padding", () => {
    const r = thumbnailRegion(page("canvas"), [stroke(500, 500)], "a4");
    expect(r.x).toBeLessThan(500);
    expect(r.y).toBeLessThan(500);
    expect(r.x + r.width).toBeGreaterThan(600);
    expect(r.y + r.height).toBeGreaterThan(550);
  });
  it("empty_canvas_has_default_region", () => {
    expect(thumbnailRegion(page("canvas"), [], "a4").width).toBeGreaterThan(0);
  });
});

describe("watchThumbnails", () => {
  it("thumbnail_captured_for_previous_page_on_switch_within_debounce", async () => {
    vi.useFakeTimers();
    const { saveThumbnail } = await import("../ipc/thumbnails");
    const { useEditorStore } = await import("../stores/editor");
    const { watchThumbnails } = await import("../thumbnails");
    const blob = new Blob([new Uint8Array([1])]);
    const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {}, scale() {}, translate() {}, save() {}, restore() {}, beginPath() {}, rect() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, arc() {}, roundRect() {} }), toBlob: (cb: (b: Blob) => void) => cb(blob) };
    vi.spyOn(document, "createElement").mockReturnValue(canvas as unknown as HTMLElement);
    const pa = { ...page("canvas"), id: "A" };
    const pb = { ...page("canvas"), id: "B" };
    useEditorStore.setState({ pageId: "A", loadedPageId: "A", page: pa, elements: new Map() });
    const stop = watchThumbnails();
    useEditorStore.setState({ elements: new Map([["e", stroke(0, 0)]]) });
    vi.advanceTimersByTime(500);
    useEditorStore.setState({ pageId: "B", loadedPageId: null, page: pa, elements: new Map() });
    await vi.runAllTimersAsync();
    useEditorStore.setState({ loadedPageId: "B", page: pb });
    await vi.advanceTimersByTimeAsync(3000);
    stop();
    expect(saveThumbnail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveThumbnail).mock.calls[0][0]).toBe("A");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});
