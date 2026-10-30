import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

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
import { useSettingsStore } from "../settings";
import { frameCamera } from "../../canvas/presentCamera";
import { DEFAULT_SETTINGS } from "../../model/constants";

const STAMP = "2026-01-01T00:00:00.000Z";
const s = () => useEditorStore.getState();

const frame = (id: string, x: number, order: number, createdAt = STAMP): Element => ({
  id,
  pageId: "pg",
  type: "frame",
  points: [{ x, y: 0, pressure: 0.5, timestamp: 0 }],
  color: "#000000",
  width: 1,
  isHighlighter: false,
  boxWidth: 400,
  boxHeight: 300,
  content: { title: id.toUpperCase(), order },
  createdAt,
  updatedAt: createdAt,
  version: 0,
});

const stroke = (id: string, x: number): Element => ({
  id,
  pageId: "pg",
  type: "stroke",
  points: [
    { x, y: 10, pressure: 0.5, timestamp: 0 },
    { x: x + 10, y: 20, pressure: 0.5, timestamp: 1 },
  ],
  color: "#000000",
  width: 2,
  isHighlighter: false,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
});

async function load(els: Element[]): Promise<void> {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  s().setViewport({ width: 1000, height: 600 });
}

const ids = () => s().orderedFrames().map((f) => f.id);

describe("presentation mode", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", undefined); // camera moves land at once
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    queue.enqueueUpsert.mockClear();
    queue.enqueueDelete.mockClear();
  });

  it("orders_frames_by_order_then_created_at", async () => {
    await load([frame("c", 900, 1), frame("b", 450, 0, "2026-01-02T00:00:00.000Z"), frame("a", 0, 0), stroke("s", 10)]);
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("starts_at_the_index_fits_the_frame_and_selects_the_cursor", async () => {
    await load([frame("a", 0, 0), frame("b", 450, 1), stroke("s", 10)]);
    s().select(["s"]);
    s().setTool("pen");
    s().startPresentation(1);
    expect(s().presenting).toEqual({ index: 1, fill: false });
    expect(s().tool).toBe("cursor");
    expect(s().selection.size).toBe(0);
    expect(s().camera).toEqual(frameCamera(s().elements.get("b")!, s().viewport, false));
  });

  it("does_nothing_without_frames", async () => {
    await load([stroke("s", 10)]);
    s().startPresentation();
    expect(s().presenting).toBeNull();
  });

  it("next_and_previous_clamp_at_the_ends_without_wrapping", async () => {
    await load([frame("a", 0, 0), frame("b", 450, 1), frame("c", 900, 2)]);
    s().startPresentation();
    s().presentPrev();
    expect(s().presenting?.index).toBe(0);
    s().presentNext();
    s().presentNext();
    expect(s().presenting?.index).toBe(2);
    s().presentNext();
    expect(s().presenting?.index).toBe(2);
    expect(s().camera).toEqual(frameCamera(s().elements.get("c")!, s().viewport, false));
    s().presentGo(-5);
    expect(s().presenting?.index).toBe(0);
    s().presentGo(99);
    expect(s().presenting?.index).toBe(2);
  });

  it("fill_follows_the_setting", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, presentFill: true } });
    await load([frame("a", 0, 0)]);
    s().startPresentation();
    expect(s().presenting?.fill).toBe(true);
    expect(s().camera).toEqual(frameCamera(s().elements.get("a")!, s().viewport, true));
    s().setPresentFill(false);
    expect(s().presenting?.fill).toBe(false);
    expect(s().camera).toEqual(frameCamera(s().elements.get("a")!, s().viewport, false));
  });

  it("refits_the_frame_when_the_viewport_changes", async () => {
    await load([frame("a", 0, 0)]);
    s().startPresentation();
    s().setViewport({ width: 1400, height: 900 }); // the toolbar hid
    expect(s().camera).toEqual(frameCamera(s().elements.get("a")!, { width: 1400, height: 900 }, false));
  });

  it("stop_restores_the_camera_and_the_tool", async () => {
    await load([frame("a", 0, 0)]);
    s().setTool("lasso");
    s().setCamera({ x: -40, y: -30, z: 1.5 });
    s().startPresentation();
    s().stopPresentation();
    expect(s().presenting).toBeNull();
    expect(s().camera).toEqual({ x: -40, y: -30, z: 1.5 });
    expect(s().tool).toBe("lasso");
  });

  it("presenting is read-only", async () => {
    await load([frame("a", 0, 0), frame("b", 450, 1), stroke("s", 10)]);
    const before = s().elements;
    s().startPresentation();
    s().presentNext();
    // Edits, tools and the selection are refused while presenting.
    s().setTool("pen");
    expect(s().tool).toBe("cursor");
    s().addElement(stroke("t", 50));
    s().select(["s"]);
    s().selectAll();
    expect(s().selection.size).toBe(0);
    s().removeElements(["s"]);
    s().updateElements([{ ...stroke("s", 10), color: "#ff0000" }]);
    s().eraser({ x: 15, y: 15 });
    s().endEraser();
    s().undo();
    s().beginEdit("a");
    expect(s().editingId).toBeNull();
    s().presentPrev();
    s().stopPresentation();
    expect(s().elements).toBe(before);
    expect(queue.enqueueUpsert).not.toHaveBeenCalled();
    expect(queue.enqueueDelete).not.toHaveBeenCalled();
    expect(s().canUndo).toBe(false);
  });

  it("reordering_while_presenting_keeps_the_current_frame", async () => {
    await load([frame("a", 0, 0), frame("b", 450, 1), frame("c", 900, 2)]);
    s().startPresentation(1);
    expect(s().reorderFrames(["c", "a", "b"])).toBe(true);
    expect(ids()).toEqual(["c", "a", "b"]);
    expect(s().presenting?.index).toBe(2);
  });

  it("loading_a_page_ends_the_presentation", async () => {
    await load([frame("a", 0, 0)]);
    s().startPresentation();
    await load([frame("a", 0, 0)]);
    expect(s().presenting).toBeNull();
  });
});
