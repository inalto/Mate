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
