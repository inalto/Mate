import { describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
import { contentOf, type FrameContent } from "../../model/content";
import { boxRect } from "../../tools/spatialIndex";

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

import { DUPLICATE_OFFSET, FRAME_DUPLICATE_GAP, useEditorStore } from "../editor";
import { useNotebookStore } from "../notebook";
import { closeLabelPopover, useLabelPopoverStore } from "../labelPopover";
import { createToolController } from "../../canvas/toolInteractions";
import { DEFAULT_SETTINGS } from "../../model/constants";

const STAMP = "2026-01-01T00:00:00.000Z";
const s = () => useEditorStore.getState();

const stroke = (id: string, x: number, y: number, content?: unknown): Element => ({
  id,
  pageId: "pg",
  type: "stroke",
  points: [
    { x, y, pressure: 0.5, timestamp: 0 },
    { x: x + 10, y: y + 10, pressure: 0.5, timestamp: 1 },
  ],
  color: "#000000",
  width: 2,
  isHighlighter: false,
  ...(content ? { content } : {}),
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
});

const at = (id: string) => s().elements.get(id)!.points[0];
const fc = (id: string) => contentOf<FrameContent>(s().elements.get(id)!);

async function load(els: Element[]): Promise<void> {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
}

describe("frames store", () => {
  it("adds_a_titled_frame_selects_it_and_returns_to_the_cursor", async () => {
    await load([]);
    s().setTool("frame");
    const a = s().addFrame({ x: 10, y: 20, width: 300, height: 200 })!;
    expect(s().tool).toBe("cursor");
    expect([...s().selection]).toEqual([a]);
    const el = s().elements.get(a)!;
    expect(el.type).toBe("frame");
    expect(boxRect(el)).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    expect(fc(a)).toMatchObject({ title: "Frame 1", order: 0 });
    const b = s().addFrame({ x: 400, y: 20, width: -100, height: 100 })!;
    expect(fc(b)).toMatchObject({ title: "Frame 2", order: 1 });
    expect(boxRect(s().elements.get(b)!)).toEqual({ x: 300, y: 20, width: 100, height: 100 });
    s().undo();
    expect(s().elements.has(b)).toBe(false);
  });

  it("moving_a_frame_moves_its_children_and_locked_children_stay", async () => {
    await load([stroke("free", 50, 50), stroke("pinned", 80, 80, { locked: true }), stroke("away", 900, 900)]);
    const f = s().addFrame({ x: 0, y: 0, width: 200, height: 200 })!;
    s().select([f]);
    s().moveSelection(100, 10);
    expect(at(f)).toMatchObject({ x: 100, y: 10 });
    expect(at("free")).toMatchObject({ x: 150, y: 60 });
    expect(at("pinned")).toMatchObject({ x: 80, y: 80 });
    expect(at("away")).toMatchObject({ x: 900, y: 900 });
    // One entry: undo puts both back.
    s().undo();
    expect(at(f)).toMatchObject({ x: 0, y: 0 });
    expect(at("free")).toMatchObject({ x: 50, y: 50 });
  });

  it("nested_frames_move_with_the_outer_frame", async () => {
    await load([stroke("deep", 120, 120)]);
    const outer = s().addFrame({ x: 0, y: 0, width: 1000, height: 1000 })!;
    const inner = s().addFrame({ x: 100, y: 100, width: 200, height: 200 })!;
    s().select([outer]);
    s().moveSelection(5, 5);
    expect(at(inner)).toMatchObject({ x: 105, y: 105 });
    expect(at("deep")).toMatchObject({ x: 125, y: 125 });
    // Moving the inner frame leaves the outer one.
    s().select([inner]);
    s().moveSelection(1, 0);
    expect(at(outer)).toMatchObject({ x: 5, y: 5 });
    expect(at("deep")).toMatchObject({ x: 126, y: 125 });
  });

  it("duplicating_a_frame_copies_its_children", async () => {
    await load([stroke("kid", 50, 50)]);
    const f = s().addFrame({ x: 0, y: 0, width: 200, height: 200 })!;
    s().select([f]);
    s().duplicateSelection();
    expect(s().selection.size).toBe(2);
    expect(s().elements.size).toBe(4);
    const copies = [...s().selection].map((id) => s().elements.get(id)!);
    expect(copies.map((e) => e.type).sort()).toEqual(["frame", "stroke"]);
    // Beside the source (its width plus the gap), never overlapping it.
    expect(copies.find((e) => e.type === "stroke")!.points[0]).toMatchObject({ x: 50 + 200 + FRAME_DUPLICATE_GAP, y: 50 });
    expect(boxRect(copies.find((e) => e.type === "frame")!)).toEqual({ x: 200 + FRAME_DUPLICATE_GAP, y: 0, width: 200, height: 200 });
  });

  it("moving_a_duplicated_frame_takes_only_its_own_copies", async () => {
    await load([stroke("tl", 20, 20), stroke("br", 150, 150)]);
    const f = s().addFrame({ x: 0, y: 0, width: 200, height: 200 })!;
    s().select([f]);
    s().duplicateSelection();
    const copyFrame = [...s().selection].map((id) => s().elements.get(id)!).find((e) => e.type === "frame")!;
    const copied = [...s().selection].filter((id) => id !== copyFrame.id);
    const before = new Map(copied.map((id) => [id, at(id)]));
    s().select([copyFrame.id]);
    s().moveSelection(0, 500);
    // Every original child stays; every copied child moved with the copy.
    expect(at(f)).toMatchObject({ x: 0, y: 0 });
    expect(at("tl")).toMatchObject({ x: 20, y: 20 });
    expect(at("br")).toMatchObject({ x: 150, y: 150 });
    for (const id of copied) expect(at(id)).toMatchObject({ x: before.get(id)!.x, y: before.get(id)!.y + 500 });
  });

  it("duplicating_without_a_frame_keeps_the_small_offset", async () => {
    await load([stroke("a", 50, 50)]);
    s().select(["a"]);
    s().duplicateSelection();
    const copy = s().elements.get([...s().selection][0])!;
    expect(copy.points[0]).toMatchObject({ x: 50 + DUPLICATE_OFFSET, y: 50 + DUPLICATE_OFFSET });
  });

  it("deleting_a_frame_deletes_only_the_frame", async () => {
    await load([stroke("kid", 50, 50)]);
    const f = s().addFrame({ x: 0, y: 0, width: 200, height: 200 })!;
    s().select([f]);
    s().deleteSelection();
    expect(s().elements.has(f)).toBe(false);
    expect(s().elements.has("kid")).toBe(true);
  });

  it("rotating_a_selection_never_rotates_its_frames", async () => {
    await load([stroke("kid", 50, 50), stroke("away", 900, 900)]);
    const f = s().addFrame({ x: 0, y: 0, width: 200, height: 200 })!;
    s().select([f, "away"]);
    s().rotateSelection({ x: 500, y: 500 }, Math.PI / 2);
    expect(at(f)).toMatchObject({ x: 0, y: 0 });
    expect((s().elements.get(f)!.content as { rotation?: number }).rotation).toBeUndefined();
    expect(at("away")).not.toMatchObject({ x: 900, y: 900 });
    // Only the stroke is in the entry: undo puts it back and leaves the frame as it was.
    s().undo();
    expect(at("away")).toMatchObject({ x: 900, y: 900 });
  });

  it("align_and_distribute_carry_each_frames_contents", async () => {
    await load([stroke("kid", 50, 50), stroke("pinned", 80, 80, { locked: true }), stroke("other", 600, 400)]);
    const f = s().addFrame({ x: 0, y: 0, width: 200, height: 200 })!;
    // Bottom-align the frame with the stroke below it: the frame drops by the same delta as its child.
    s().select([f, "other"]);
    s().alignSelection("bottom");
    const dy = at(f).y;
    expect(dy).toBeGreaterThan(0);
    expect(at("kid")).toMatchObject({ x: 50, y: 50 + dy });
    expect(at("pinned")).toMatchObject({ x: 80, y: 80 });
    // One entry.
    s().undo();
    expect(at(f)).toMatchObject({ x: 0, y: 0 });
    expect(at("kid")).toMatchObject({ x: 50, y: 50 });
    // Distribute: the frame in the middle moves, its child with it.
    await load([stroke("kid", 450, 50), stroke("left", 0, 0), stroke("right", 1000, 0)]);
    const g = s().addFrame({ x: 400, y: 0, width: 200, height: 200 })!;
    s().select(["left", g, "right"]);
    s().distributeSelection("horizontal");
    const dx = at(g).x - 400;
    expect(dx).not.toBe(0);
    expect(at("kid").x).toBeCloseTo(450 + dx);
  });

  it("copy_and_cut_of_a_frame_take_its_contents", async () => {
    await load([stroke("kid", 50, 50), stroke("pinned", 80, 80, { locked: true })]);
    const f = s().addFrame({ x: 0, y: 0, width: 200, height: 200 })!;
    s().select([f]);
    s().copySelection();
    s().paste();
    // Frame + unlocked child pasted (the locked child is no part of the copy).
    expect(s().selection.size).toBe(2);
    expect(s().elements.size).toBe(5);
    s().undo();
    s().select([f]);
    s().cutSelection();
    expect(s().elements.has(f)).toBe(false);
    expect(s().elements.has("kid")).toBe(false);
    expect(s().elements.has("pinned")).toBe(true);
    s().paste();
    expect(s().selection.size).toBe(2);
  });

  it("rename_background_reorder_and_select_contents", async () => {
    await load([stroke("kid", 50, 50), stroke("pinned", 60, 60, { locked: true })]);
    const a = s().addFrame({ x: 0, y: 0, width: 200, height: 200 })!;
    const b = s().addFrame({ x: 500, y: 0, width: 200, height: 200 })!;
    expect(s().renameFrame(a, "  Intro ")).toBe(true);
    expect(fc(a).title).toBe("Intro");
    expect(s().renameFrame(a, "   ")).toBe(false);
    expect(s().setFrameBackground(a, "#FFF59D")).toBe(true);
    expect(fc(a).background).toBe("#FFF59D");
    expect(s().setFrameBackground(a, null)).toBe(true);
    expect(fc(a).background).toBeUndefined();
    expect(s().reorderFrames([b, a])).toBe(true);
    expect([fc(b).order, fc(a).order]).toEqual([0, 1]);
    s().undo();
    expect([fc(a).order, fc(b).order]).toEqual([0, 1]);
    s().selectFrameContents(a);
    expect([...s().selection]).toEqual(["kid"]);
  });
});

describe("frame tool", () => {
  let now = 0;
  const controller = () =>
    createToolController({
      store: useEditorStore,
      el: document.createElement("div"),
      requestLive: () => {},
      invalidate: () => {},
      renderElement: () => {},
      getSettings: () => ({ ...DEFAULT_SETTINGS, snapToGrid: false }),
      now: () => now,
    });
  const ready = async (els: Element[] = []) => {
    await load(els);
    useEditorStore.setState({ viewport: { width: 1000, height: 800 }, camera: { x: 0, y: 0, z: 1 } });
  };

  it("drags_one_frame_then_returns_to_the_cursor", async () => {
    await ready();
    const tools = controller();
    s().setTool("frame");
    tools.down({ x: 10, y: 10 }, "frame");
    tools.move([{ x: 210, y: 160 }]);
    tools.up();
    const frames = [...s().elements.values()].filter((e) => e.type === "frame");
    expect(frames).toHaveLength(1);
    expect(boxRect(frames[0])).toEqual({ x: 10, y: 10, width: 200, height: 150 });
    expect(s().tool).toBe("cursor");
    tools.dispose();
  });

  it("a_press_inside_a_selected_frame_reaches_its_content", async () => {
    await ready([stroke("kid", 100, 100)]);
    const f = s().addFrame({ x: 0, y: 0, width: 400, height: 300 })!;
    const tools = controller();
    s().select([f]);
    tools.down({ x: 104, y: 104 }, "cursor");
    tools.up();
    expect([...s().selection]).toEqual(["kid"]);
    // Empty space inside: nothing hit, the selection clears (a lasso starts).
    s().select([f]);
    tools.down({ x: 300, y: 250 }, "cursor");
    tools.up();
    expect(s().selection.size).toBe(0);
    tools.dispose();
  });

  it("alt_drag_on_a_frame_moves_the_copies_with_their_children_and_leaves_the_originals", async () => {
    await load([stroke("tl", 20, 20), stroke("br", 150, 150)]);
    useEditorStore.setState({ viewport: { width: 1000, height: 800 }, camera: { x: 0, y: 0, z: 1 } });
    const f = s().addFrame({ x: 0, y: 0, width: 200, height: 200 })!;
    const tools = createToolController({
      store: useEditorStore,
      el: document.createElement("div"),
      requestLive: () => {},
      invalidate: () => {},
      renderElement: () => {},
      getSettings: () => ({ ...DEFAULT_SETTINGS, snapToGrid: false, smartGuides: false }),
      now: () => now,
    });
    s().select([f]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true }));
    // Press on the frame's left border band, drag 300 down.
    tools.down({ x: 2, y: 100 }, "cursor");
    tools.move([{ x: 2, y: 400 }]);
    tools.up();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    expect(s().elements.size).toBe(6);
    expect(at(f)).toMatchObject({ x: 0, y: 0 });
    expect(at("tl")).toMatchObject({ x: 20, y: 20 });
    expect(at("br")).toMatchObject({ x: 150, y: 150 });
    const copies = [...s().elements.values()].filter((e) => ![f, "tl", "br"].includes(e.id));
    expect(copies.map((e) => e.type).sort()).toEqual(["frame", "stroke", "stroke"]);
    expect(copies.map((e) => e.points[0]).map((p) => [p.x, p.y]).sort((a, b) => a[0] - b[0])).toEqual([
      [0, 300],
      [20, 320],
      [150, 450],
    ]);
    // One undo removes the copies and the move together.
    s().undo();
    expect(s().elements.size).toBe(3);
    expect(at(f)).toMatchObject({ x: 0, y: 0 });
    tools.dispose();
  });

  it("double_click_on_the_title_opens_the_rename_popover", async () => {
    await ready();
    const f = s().addFrame({ x: 0, y: 0, width: 400, height: 300 })!;
    const tools = controller();
    tools.down({ x: 8, y: -12 }, "cursor");
    tools.up();
    now = 100;
    tools.down({ x: 8, y: -12 }, "cursor");
    tools.up();
    expect(useLabelPopoverStore.getState().target?.id).toBe(f);
    closeLabelPopover();
    tools.dispose();
  });
});
