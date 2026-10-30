import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";
import { isLocked } from "../../model/content";
import en from "../../locales/en/translation.json";
import it_ from "../../locales/it/translation.json";

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

const s = () => useEditorStore.getState();

async function load(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
}

const stroke = (id: string, locked = false) =>
  el(id, [[0, 0], [100, 0]], locked ? { content: { locked: true } } : {});
const textBox = (id: string, x: number, y: number): Element =>
  el(id, [[x, y]], {
    type: "text-box",
    boxWidth: 100,
    boxHeight: 50,
    content: { contentHtml: "<p>hi</p>", rawContent: "hi", textAttributes: { fontFamily: "sans", fontSize: 16, color: "#000", align: "left" } },
  });

describe("lock", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("locked_element_ignores_move_delete_and_restyle", async () => {
    await load([stroke("a", true), stroke("b")]);
    s().select(["a", "b"]);
    s().moveSelection(10, 10);
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 0, y: 0 });
    expect(s().elements.get("b")!.points[0]).toMatchObject({ x: 10, y: 10 });
    s().restyleSelection({ color: "#ff0000" });
    expect(s().elements.get("a")!.color).toBe("#000000");
    expect(s().elements.get("b")!.color).toBe("#ff0000");
    s().deleteSelection();
    expect(s().elements.has("a")).toBe(true);
    expect(s().elements.has("b")).toBe(false);
  });

  it("locked_element_is_not_aligned_scaled_rotated_or_erased", async () => {
    await load([stroke("a", true), el("b", [[0, 300], [100, 300]]), el("c", [[50, 600], [150, 600]])]);
    s().select(["a", "b", "c"]);
    s().alignSelection("left");
    s().scaleSelection({ x: 0, y: 0 }, 2, 2);
    s().rotateSelection({ x: 0, y: 0 }, Math.PI / 2);
    expect(s().elements.get("a")).toEqual(stroke("a", true));
    useEditorStore.setState({ camera: { x: 0, y: 0, z: 1 } });
    s().eraser({ x: 50, y: 0 });
    s().endEraser();
    expect(s().elements.has("a")).toBe(true);
  });

  it("lock_then_unlock_restores_and_undo_reverts", async () => {
    await load([stroke("a"), stroke("b")]);
    s().select(["a"]);
    s().lockSelection();
    expect(isLocked(s().elements.get("a")!)).toBe(true);
    s().moveSelection(5, 5);
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 0, y: 0 });
    s().unlockSelection();
    expect(isLocked(s().elements.get("a")!)).toBe(false);
    expect(s().elements.get("a")!.content).toEqual({});
    s().moveSelection(5, 5);
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 5, y: 5 });
    s().undo(); // move
    s().undo(); // unlock
    expect(isLocked(s().elements.get("a")!)).toBe(true);
    s().undo(); // lock
    expect(isLocked(s().elements.get("a")!)).toBe(false);
  });

  it("copies_of_a_locked_element_are_unlocked", async () => {
    await load([stroke("a", true)]);
    s().select(["a"]);
    s().copySelection();
    s().paste();
    const [copy] = [...s().selection];
    expect(copy).not.toBe("a");
    expect(isLocked(s().elements.get(copy)!)).toBe(false);
    s().select(["a"]);
    const ids = s().duplicateSelectionInPlace();
    expect(ids).toHaveLength(1);
    const dup = s().elements.get(ids[0])!;
    expect(isLocked(dup)).toBe(false);
    expect(dup.points[0]).toMatchObject({ x: 0, y: 0 }); // zero offset
    expect([...s().selection]).toEqual(ids);
  });

  it("group_skips_locked_elements", async () => {
    await load([stroke("a", true), stroke("b"), stroke("c")]);
    s().select(["a", "b", "c"]);
    s().groupSelection();
    expect(s().elements.get("a")!.uiGroupId).toBeUndefined();
    expect(s().elements.get("b")!.uiGroupId).toBeDefined();
    expect(s().elements.get("b")!.uiGroupId).toBe(s().elements.get("c")!.uiGroupId);
  });

  it("lock_strings_exist_after_line_caps", () => {
    for (const cat of [en, it_] as Record<string, unknown>[]) {
      const keys = Object.keys(cat);
      expect(keys[keys.indexOf("lineCaps") + 1]).toBe("lock");
      expect(Object.keys(cat.lock as object).sort()).toEqual(["lock", "locked", "unlock"]);
    }
  });
});

describe("rotateSelection", () => {
  it("rotates_a_strokes_points_about_the_centre", async () => {
    await load([stroke("a")]);
    s().select(["a"]);
    s().rotateSelection({ x: 50, y: 0 }, Math.PI / 2);
    const [p, q] = s().elements.get("a")!.points;
    expect(p.x).toBeCloseTo(50);
    expect(p.y).toBeCloseTo(-50);
    expect(q.x).toBeCloseTo(50);
    expect(q.y).toBeCloseTo(50);
    expect(s().canUndo).toBe(true);
  });

  it("rotates_a_text_box_by_content_rotation_about_its_centre", async () => {
    await load([textBox("t", 0, 0)]);
    s().select(["t"]);
    s().rotateSelection({ x: 50, y: 25 }, Math.PI / 2);
    const t = s().elements.get("t")!;
    expect((t.content as { rotation: number }).rotation).toBeCloseTo(Math.PI / 2);
    expect(t.points[0]).toMatchObject({ x: 0, y: 0 });
  });

  it("orbits_a_text_box_centre_about_a_selection_centre", async () => {
    await load([textBox("t", 0, 0)]);
    s().select(["t"]);
    s().rotateSelection({ x: 0, y: 0 }, Math.PI / 2);
    const t = s().elements.get("t")!;
    // box centre (50, 25) orbits to (-25, 50): top-left (-75, 25)
    expect(t.points[0].x).toBeCloseTo(-75);
    expect(t.points[0].y).toBeCloseTo(25);
    expect((t.content as { rotation: number }).rotation).toBeCloseTo(Math.PI / 2);
  });

  it("rotates_a_shape_by_rotation_and_orbits_its_anchors", async () => {
    const shape = el("sh", [[0, 0], [100, 50]], { type: "shape", shapeType: "rectangle", content: { fillOpacity: 1 } });
    await load([shape]);
    s().select(["sh"]);
    s().rotateSelection({ x: 0, y: 0 }, Math.PI);
    const r = s().elements.get("sh")!;
    // rect centre (50, 25) -> (-50, -25); the anchors keep their size
    expect(r.points[0].x).toBeCloseTo(-100);
    expect(r.points[0].y).toBeCloseTo(-50);
    expect(r.points[1].x).toBeCloseTo(0);
    expect(r.points[1].y).toBeCloseTo(0);
    expect((r.content as { rotation: number }).rotation).toBeCloseTo(Math.PI);
  });
});

describe("fit", () => {
  beforeEach(() => vi.stubGlobal("requestAnimationFrame", undefined));

  it("fit_selection_frames_the_selection_bounds", async () => {
    await load([textBox("t", 1000, 1000)]);
    useEditorStore.setState({ viewport: { width: 296, height: 246 } });
    s().select(["t"]);
    s().fitSelection();
    // 100x50 in a room of 200x150: zoom 2, centre (1050, 1025)
    expect(s().camera).toEqual({ x: 148 - 2100, y: 123 - 2050, z: 2 });
  });

  it("fit_selection_without_a_selection_does_nothing", async () => {
    await load([textBox("t", 1000, 1000)]);
    useEditorStore.setState({ camera: { x: -3, y: -4, z: 1.5 } });
    s().fitSelection();
    expect(s().camera).toEqual({ x: -3, y: -4, z: 1.5 });
  });

  it("fit_page_frames_all_elements_in_canvas_mode", async () => {
    await load([textBox("t", 1000, 1000), textBox("u", 1100, 1050)]);
    useEditorStore.setState({ viewport: { width: 296, height: 196 } });
    s().fitPage();
    // union (1000, 1000)-(1200, 1100): 200x100 in 200x100 room, zoom 1
    expect(s().camera).toEqual({ x: 148 - 1100, y: 98 - 1050, z: 1 });
  });
});
