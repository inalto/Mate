import { afterEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
import { effectiveCaps } from "../../model/content";
import { shapeElement, shapeFromDrag } from "../../shapes/geometry";

const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {}),
  pending: () => 0,
  failed: () => 0,
}));
const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => loaded.els) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { useEditorStore } from "../editor";
import { useNotebookStore } from "../notebook";
import { closeLineCaps, LINE_CAPS_IDLE_MS, openLineCaps, touchLineCaps, useLineCapsStore } from "../lineCaps";

const style = { shapeType: "arrow" as const, color: "#000000", fillColor: "transparent", width: 2, fillOpacity: 1 };
const arrow = shapeElement(style, shapeFromDrag("arrow", { x: 0, y: 0 }, { x: 100, y: 0 }, false), "pg", "ar", "2026-01-01T00:00:00.000Z");
const rect = shapeElement({ ...style, shapeType: "rectangle" }, shapeFromDrag("rectangle", { x: 0, y: 0 }, { x: 10, y: 10 }, false), "pg", "rc", "2026-01-01T00:00:00.000Z");

async function load(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await useEditorStore.getState().loadPage("pg");
}

describe("setLineCaps", () => {
  it("is_one_undoable_entry", async () => {
    await load([arrow, rect]);
    const s = () => useEditorStore.getState();
    expect(s().setLineCaps("ar", { start: "dot", end: "bar" })).toBe(true);
    expect(effectiveCaps(s().elements.get("ar")!)).toEqual({ start: "dot", end: "bar" });
    expect(s().elements.get("ar")!.shapeType).toBe("arrow");
    expect(queue.enqueueUpsert).toHaveBeenLastCalledWith(s().elements.get("ar"));
    s().undo();
    expect(s().elements.get("ar")).toEqual(arrow);
    expect(effectiveCaps(s().elements.get("ar")!)).toEqual({ start: "none", end: "arrow" });
    s().redo();
    expect(effectiveCaps(s().elements.get("ar")!)).toEqual({ start: "dot", end: "bar" });
    // Unchanged caps, other shapes and missing ids add no entry.
    expect(s().setLineCaps("ar", { start: "dot", end: "bar" })).toBe(false);
    expect(s().setLineCaps("rc", { start: "dot", end: "bar" })).toBe(false);
    expect(s().setLineCaps("nope", { start: "dot", end: "bar" })).toBe(false);
  });
});

describe("line caps popover store", () => {
  afterEach(() => {
    closeLineCaps();
    vi.useRealTimers();
  });

  it("opens_and_closes_after_idle", () => {
    vi.useFakeTimers();
    openLineCaps(useEditorStore, "ar");
    expect(useLineCapsStore.getState().target).toMatchObject({ id: "ar" });
    vi.advanceTimersByTime(LINE_CAPS_IDLE_MS - 100);
    touchLineCaps();
    vi.advanceTimersByTime(LINE_CAPS_IDLE_MS - 100);
    expect(useLineCapsStore.getState().target).not.toBeNull();
    vi.advanceTimersByTime(200);
    expect(useLineCapsStore.getState().target).toBeNull();
  });

  it("close_clears_the_target", () => {
    openLineCaps(useEditorStore, "ar");
    closeLineCaps();
    expect(useLineCapsStore.getState().target).toBeNull();
  });
});
