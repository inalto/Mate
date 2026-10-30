import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element, Settings } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";

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

import { DEFAULT_SETTINGS } from "../../model/constants";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { createToolController, GUIDE_COLOR, smartMoveDelta } from "../toolInteractions";
import { selectionBounds } from "../../tools/lasso";

const s = () => useEditorStore.getState();

/** A horizontal stroke of length 100 starting at (x, y) (bounds 102 × 2: the width pads it). */
const bar = (id: string, x: number, y: number, opts: Partial<Element> = {}) => el(id, [[x, y], [x + 100, y]], opts);

let settings: Settings = DEFAULT_SETTINGS;
let dispose: (() => void) | null = null;

async function setup(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  s().setViewport({ width: 1000, height: 800 });
  s().setCamera({ x: 0, y: 0, z: 1 });
  s().setTool("cursor");
  const tools = createToolController({
    store: useEditorStore,
    el: document.createElement("div"),
    requestLive: () => {},
    invalidate: () => {},
    renderElement: () => {},
    getSettings: () => settings,
  });
  dispose = tools.dispose;
  return tools;
}

/** Hold (or release) modifier keys, as the window sees them. */
const keys = (mods: { altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", ...mods }));

/** A canvas context that records the stroke styles it was given. */
function recordingCtx() {
  const styles: string[] = [];
  const target: Record<string, unknown> = { measureText: () => ({ width: 10 }) };
  const ctx = new Proxy(target, {
    get: (t, k) => (k in t ? t[k as string] : () => {}),
    set: (t, k, v) => {
      if (k === "strokeStyle") styles.push(String(v));
      t[k as string] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, styles };
}

const drag = (tools: Awaited<ReturnType<typeof setup>>, from: { x: number; y: number }, to: { x: number; y: number }) => {
  tools.down(from, "cursor");
  tools.move([to]);
  tools.up();
};

describe("selection modifiers", () => {
  beforeEach(() => {
    settings = DEFAULT_SETTINGS;
  });
  afterEach(() => {
    dispose?.();
    dispose = null;
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
  });

  it("alt_drag_moves_fresh_copies_in_one_duplicate_entry", async () => {
    const tools = await setup([bar("a", 0, 0)]);
    s().select(["a"]);
    keys({ altKey: true });
    drag(tools, { x: 50, y: 0 }, { x: 50, y: 300 });
    expect(s().elements.size).toBe(2);
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 0, y: 0 });
    const copy = [...s().elements.values()].find((e) => e.id !== "a")!;
    expect(copy.points[0]).toMatchObject({ x: 0, y: 300 });
    expect([...s().selection]).toEqual([copy.id]);
    s().undo();
    expect(s().elements.size).toBe(1);
    expect(s().canUndo).toBe(false);
    // An Alt+click that never drags copies nothing.
    drag(tools, { x: 50, y: 0 }, { x: 50, y: 0 });
    expect(s().elements.size).toBe(1);
  });

  it("shift_locks_the_move_to_the_dominant_axis", async () => {
    const tools = await setup([bar("a", 0, 0)]);
    s().select(["a"]);
    keys({ shiftKey: true });
    drag(tools, { x: 50, y: 0 }, { x: 250, y: 40 });
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 200, y: 0 });
  });

  it("smart_guides_snap_and_ctrl_suspends_them", async () => {
    const tools = await setup([bar("a", 0, 0), bar("b", 200, 300)]);
    s().select(["a"]);
    // Released 3 px short of b's left edge (and every stop of b): the x snaps, y stays free.
    tools.down({ x: 50, y: 0 }, "cursor");
    tools.move([{ x: 247, y: 100 }]);
    expect(s().guides.some((g) => g.axis === "x" && g.at === 199)).toBe(true);
    const { ctx, styles } = recordingCtx();
    tools.draw(ctx, s().camera, 1);
    expect(styles).toContain(GUIDE_COLOR);
    tools.up();
    expect(s().guides).toEqual([]);
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 200, y: 100 });
    s().undo();
    keys({ ctrlKey: true });
    drag(tools, { x: 50, y: 0 }, { x: 247, y: 100 });
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 197, y: 100 });
  });

  it("ctrl_also_suspends_grid_snap", async () => {
    settings = { ...DEFAULT_SETTINGS, snapToGrid: true, smartGuides: false };
    const tools = await setup([bar("a", 0, 0)]);
    s().select(["a"]);
    keys({ ctrlKey: true });
    drag(tools, { x: 50, y: 0 }, { x: 53, y: 7 });
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 3, y: 7 });
  });

  it("rotate_handle_with_shift_snaps_to_15_degrees_in_one_entry", async () => {
    const tools = await setup([bar("a", 0, 0)]);
    s().select(["a"]);
    keys({ shiftKey: true });
    // Bounds -1..101 × -1..1: centre (50, 0), handle 24 px above the top-centre.
    tools.down({ x: 50, y: -25 }, "cursor");
    tools.move([{ x: 150, y: 10 }]); // ≈ 95.7° from the start: snaps to 90°
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 0, y: 0 }); // preview only
    const { ctx } = recordingCtx();
    expect(() => tools.draw(ctx, s().camera, 1)).not.toThrow();
    tools.up();
    const p = s().elements.get("a")!.points[0];
    expect(p.x).toBeCloseTo(50);
    expect(p.y).toBeCloseTo(-50);
    s().undo();
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 0, y: 0 });
    expect(s().canUndo).toBe(false);
  });

  it("alt_drag_ending_where_it_started_leaves_no_copies", async () => {
    // Grid snap pulls a 3 px nudge back to 0: the copies are taken back, no entry is left.
    settings = { ...DEFAULT_SETTINGS, snapToGrid: true, smartGuides: false };
    const tools = await setup([bar("a", 0, 0)]);
    s().select(["a"]);
    keys({ altKey: true });
    drag(tools, { x: 50, y: 0 }, { x: 53, y: 2 });
    expect(s().elements.size).toBe(1);
    expect(s().canUndo).toBe(false);
  });

  it("alt_drag_copies_never_snap_back_onto_their_originals", async () => {
    // Smart guides on, nothing else on the page: the originals are no guide candidates.
    const tools = await setup([bar("a", 0, 0)]);
    s().select(["a"]);
    keys({ altKey: true });
    drag(tools, { x: 50, y: 0 }, { x: 54, y: 5 });
    expect(s().elements.size).toBe(2);
    const copy = [...s().elements.values()].find((e) => e.id !== "a")!;
    expect(copy.points[0]).toMatchObject({ x: 4, y: 5 });
  });

  describe("escape cancels every live-layer gesture", () => {
    const escape = () => {
      const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const unchanged = () => {
      expect(s().elements.size).toBe(1);
      expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 0, y: 0 });
      expect(s().canUndo).toBe(false);
      expect(s().dragging).toBe(false);
    };

    it("move_alt_move_scale_and_rotate", async () => {
      const tools = await setup([bar("a", 0, 0)]);
      s().select(["a"]);
      const gestures: [{ x: number; y: number }, { x: number; y: number }][] = [
        [{ x: 50, y: 0 }, { x: 50, y: 300 }], // move
        [{ x: 101, y: 1 }, { x: 201, y: 50 }], // corner scale
        [{ x: 50, y: -25 }, { x: 150, y: 10 }], // rotate handle
      ];
      for (const [from, to] of gestures) {
        tools.down(from, "cursor");
        tools.move([to]);
        expect(escape()).toBe(true);
        tools.move([{ x: to.x + 10, y: to.y + 10 }]);
        tools.up();
        unchanged();
        // The selection stays.
        expect([...s().selection]).toEqual(["a"]);
      }
      // An Escaped Alt+drag takes its copies back.
      keys({ altKey: true });
      tools.down({ x: 50, y: 0 }, "cursor");
      tools.move([{ x: 50, y: 300 }]);
      expect(s().elements.size).toBe(2);
      expect(escape()).toBe(true);
      tools.up();
      unchanged();
    });

    it("lasso_shape_and_insert_space", async () => {
      const tools = await setup([bar("a", 0, 0)]);
      // A lasso round the bar selects nothing once Escaped.
      tools.down({ x: -20, y: -20 }, "cursor");
      tools.move([{ x: 150, y: -20 }, { x: 150, y: 20 }, { x: -20, y: 20 }]);
      expect(escape()).toBe(true);
      tools.up();
      expect(s().selection.size).toBe(0);
      // A shape drag adds no shape.
      tools.down({ x: 200, y: 200 }, "shape");
      tools.move([{ x: 400, y: 400 }]);
      expect(escape()).toBe(true);
      tools.up();
      // An insert-space drag shifts nothing.
      tools.down({ x: 0, y: -50 }, "insert-space");
      tools.move([{ x: 0, y: 100 }]);
      expect(escape()).toBe(true);
      tools.up();
      unchanged();
      // With no gesture, Escape is left to the shortcuts.
      expect(escape()).toBe(false);
    });
  });

  it("a_selection_holding_a_frame_has_no_rotate_handle", async () => {
    const frame: Element = {
      ...el("f", [[300, 300]]),
      type: "frame",
      boxWidth: 200,
      boxHeight: 100,
      content: { title: "", order: 0 },
    };
    const tools = await setup([bar("a", 0, 0), frame]);
    s().select(["a", "f"]);
    const b = selectionBounds(s().elements, s().selection)!;
    drag(tools, { x: b.x + b.width / 2, y: b.y - 24 }, { x: b.x + b.width, y: b.y + b.height / 2 });
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 0, y: 0 });
    expect(s().elements.get("f")!.points[0]).toMatchObject({ x: 300, y: 300 });
    expect((s().elements.get("f")!.content as { rotation?: number }).rotation).toBeUndefined();
    expect(s().canUndo).toBe(false);
  });

  it("a_lone_box_is_never_scaled_from_the_canvas_outside_its_overlay_handles", async () => {
    const box: Element = { ...el("t", [[0, 0]]), type: "text-box", boxWidth: 100, boxHeight: 50, content: { contentHtml: "", rawContent: "", textAttributes: {} } };
    const tools = await setup([box]);
    s().select(["t"]);
    // 6 px outside the bottom-right corner (beyond BoxFrame's handle, within the canvas slop).
    drag(tools, { x: 106, y: 56 }, { x: 206, y: 106 });
    const t = s().elements.get("t")!;
    expect([t.boxWidth, t.boxHeight]).toEqual([100, 50]);
  });

  it("locked_selection_is_clickable_but_never_moved_or_rotated", async () => {
    const tools = await setup([bar("a", 0, 0, { content: { locked: true } })]);
    drag(tools, { x: 50, y: 0 }, { x: 50, y: 0 });
    expect([...s().selection]).toEqual(["a"]);
    drag(tools, { x: 50, y: 0 }, { x: 150, y: 100 });
    drag(tools, { x: 50, y: -25 }, { x: 150, y: 10 });
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 0, y: 0 });
    expect(s().canUndo).toBe(false);
  });
});

describe("lock guard", () => {
  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it("update_elements_skips_locked_elements", async () => {
    await setup([bar("a", 0, 0, { content: { locked: true } }), bar("b", 0, 100)]);
    const moved = (e: Element): Element => ({ ...e, points: e.points.map((q) => ({ ...q, x: q.x + 5 })) });
    s().updateElements([moved(s().elements.get("a")!), moved(s().elements.get("b")!)]);
    expect(s().elements.get("a")!.points[0].x).toBe(0);
    expect(s().elements.get("b")!.points[0].x).toBe(5);
  });
});

describe("smartMoveDelta", () => {
  const id = (d: { x: number; y: number }) => d;
  it("equal_spacing_centres_a_box_between_its_neighbours", () => {
    const left = { x: 0, y: 0, width: 100, height: 50 };
    const right = { x: 300, y: 0, width: 100, height: 50 };
    // Gaps 52 and 48 within the threshold: corrected to 50 / 50 with two labelled guides.
    const r = smartMoveDelta({ x: 0, y: 200, width: 100, height: 50 }, { x: 152, y: -200 }, [left, right], 8, id);
    expect(r.delta.x).toBeCloseTo(150);
    expect(r.guides.filter((g) => g.label === "50")).toHaveLength(2);
  });

  it("locked_axis_is_never_snapped", () => {
    const other = { x: 0, y: 103, width: 100, height: 50 };
    const r = smartMoveDelta({ x: 500, y: 0, width: 100, height: 50 }, { x: 0, y: 100 }, [other], 8, id, "y");
    expect(r.delta).toEqual({ x: 0, y: 0 });
  });
});
