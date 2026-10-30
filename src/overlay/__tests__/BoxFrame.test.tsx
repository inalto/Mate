import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
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

import { contentMeta } from "../../tools/spatialIndex";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import AutoCompleteHandles from "../AutoCompleteHandles";
import BoxFrame from "../BoxFrame";

const box = (id: string, x: number, y: number, opts: Partial<Element> = {}) =>
  el(id, [[x, y]], { type: "text-box", boxWidth: 200, boxHeight: 80, width: 1, ...opts });

let store: EditorStore;
const s = () => store.getState();

async function load(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  s().setViewport({ width: 1000, height: 800 });
  s().setCamera({ x: 0, y: 0, z: 1 });
}

const frame = (id: string) => render(<BoxFrame el={s().elements.get(id)!} store={store} zoom={1} handles />);

describe("BoxFrame", () => {
  beforeEach(() => {
    store = createEditorStore();
  });
  afterEach(cleanup);

  it("locked_box_shows_a_lock_glyph_and_no_handles", async () => {
    await load([box("a", 100, 100, { content: { locked: true } })]);
    s().select(["a"]);
    const { container } = frame("a");
    expect(container.querySelectorAll(".box-frame-handle")).toHaveLength(0);
    expect(container.querySelector("[data-rotate-handle]")).toBeNull();
    expect(container.querySelectorAll(".box-frame-edge")).toHaveLength(0);
    expect(container.querySelector("[data-lock-glyph]")).not.toBeNull();
  });

  it("unlocked_box_has_handles_and_a_rotate_handle", async () => {
    await load([box("a", 100, 100)]);
    s().select(["a"]);
    const { container } = frame("a");
    expect(container.querySelectorAll(".box-frame-handle")).toHaveLength(8);
    expect(container.querySelector("[data-rotate-handle]")).not.toBeNull();
    expect(container.querySelector("[data-lock-glyph]")).toBeNull();
  });

  it("a_frame_has_resize_handles_but_no_rotate_handle", async () => {
    await load([el("f", [[100, 100]], { type: "frame", boxWidth: 300, boxHeight: 200, width: 1 })]);
    s().select(["f"]);
    const { container } = frame("f");
    expect(container.querySelectorAll(".box-frame-handle")).toHaveLength(8);
    expect(container.querySelector("[data-rotate-handle]")).toBeNull();
  });

  it("a_drag_sets_the_dragging_flag_so_auto_complete_arrows_hide_until_it_ends", async () => {
    await load([box("a", 100, 100)]);
    s().select(["a"]);
    s().setTool("cursor");
    const { container } = render(
      <div className="pane">
        <BoxFrame el={s().elements.get("a")!} store={store} zoom={1} handles />
        <AutoCompleteHandles store={store} />
      </div>,
    );
    const arrows = () => container.querySelectorAll(".auto-complete-handle").length;
    expect(arrows()).toBe(4);
    const edge = container.querySelector(".box-frame-edge.top") as HTMLElement;
    act(() => void fireEvent.pointerDown(edge, { clientX: 150, clientY: 100, pointerId: 1, button: 0 }));
    expect(s().dragging).toBe(true);
    expect(arrows()).toBe(0);
    act(() => void fireEvent.pointerMove(edge, { clientX: 190, clientY: 100, pointerId: 1 }));
    act(() => void fireEvent.pointerUp(edge, { clientX: 190, clientY: 100, pointerId: 1 }));
    expect(s().dragging).toBe(false);
    expect(arrows()).toBe(4);
    // Cancel and a corner resize clear it too.
    const corner = container.querySelector('[data-handle="se"]') as HTMLElement;
    act(() => void fireEvent.pointerDown(corner, { clientX: 300, clientY: 180, pointerId: 2, button: 0 }));
    expect(s().dragging).toBe(true);
    act(() => void fireEvent.pointerCancel(corner, { pointerId: 2 }));
    expect(s().dragging).toBe(false);
  });

  it("unmounting_mid_drag_clears_the_dragging_flag", async () => {
    await load([box("a", 100, 100)]);
    s().select(["a"]);
    const { container, unmount } = frame("a");
    fireEvent.pointerDown(container.querySelector(".box-frame-edge.top")!, { clientX: 150, clientY: 100, pointerId: 1, button: 0 });
    expect(s().dragging).toBe(true);
    unmount();
    expect(s().dragging).toBe(false);
  });

  it("rotate_handle_with_shift_snaps_to_15_degrees_once", async () => {
    await load([box("a", 100, 100)]);
    s().select(["a"]);
    const { container } = frame("a");
    const knob = container.querySelector("[data-rotate-handle]") as HTMLElement;
    // jsdom lays nothing out: the frame's client centre is (0, 0); the press starts straight above it.
    fireEvent.pointerDown(knob, { clientX: 0, clientY: -100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(knob, { clientX: 100, clientY: 10, pointerId: 1, shiftKey: true });
    expect(container.querySelector(".box-frame-angle")?.textContent).toBe("90°");
    expect(contentMeta(s().elements.get("a")!).rotation ?? 0).toBe(0); // draft only
    fireEvent.pointerUp(knob, { clientX: 100, clientY: 10, pointerId: 1, shiftKey: true });
    const a = s().elements.get("a")!;
    expect(contentMeta(a).rotation).toBeCloseTo(Math.PI / 2);
    expect(a.points[0]).toMatchObject({ x: 100, y: 100 }); // about its own centre
    s().undo();
    expect(contentMeta(s().elements.get("a")!).rotation ?? 0).toBe(0);
    expect(s().canUndo).toBe(false);
  });

  it("edge_move_snaps_to_smart_guides_unless_ctrl", async () => {
    await load([box("a", 100, 100), box("b", 400, 400)]);
    s().select(["a"]);
    const { container } = frame("a");
    const edge = container.querySelector(".box-frame-edge.top") as HTMLElement;
    fireEvent.pointerDown(edge, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
    fireEvent.pointerMove(edge, { clientX: 297, clientY: 150, pointerId: 1 });
    expect(s().guides.some((g) => g.axis === "x" && g.at === 400)).toBe(true);
    fireEvent.pointerUp(edge, { clientX: 297, clientY: 150, pointerId: 1 });
    expect(s().guides).toEqual([]);
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 400, y: 250 });
    s().undo();
    fireEvent.pointerDown(edge, { clientX: 0, clientY: 0, pointerId: 2, button: 0 });
    fireEvent.pointerMove(edge, { clientX: 297, clientY: 150, pointerId: 2, ctrlKey: true });
    expect(s().guides).toEqual([]);
    fireEvent.pointerUp(edge, { clientX: 297, clientY: 150, pointerId: 2, ctrlKey: true });
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 397, y: 250 });
  });

  const startSnappedDrag = (container: HTMLElement) => {
    const edge = container.querySelector(".box-frame-edge.top") as HTMLElement;
    fireEvent.pointerDown(edge, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
    fireEvent.pointerMove(edge, { clientX: 297, clientY: 150, pointerId: 1 });
    expect(s().guides.length).toBeGreaterThan(0);
    return edge;
  };

  it("unmounting_mid_drag_clears_the_guides", async () => {
    await load([box("a", 100, 100), box("b", 400, 400)]);
    s().select(["a"]);
    const { container, unmount } = frame("a");
    startSnappedDrag(container);
    unmount(); // e.g. deselect, undo or delete mid-drag
    expect(s().guides).toEqual([]);
  });

  it("escape_cancels_the_drag_without_committing", async () => {
    await load([box("a", 100, 100), box("b", 400, 400)]);
    s().select(["a"]);
    const { container } = frame("a");
    const edge = startSnappedDrag(container);
    const key = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(s().guides).toEqual([]);
    fireEvent.pointerUp(edge, { clientX: 297, clientY: 150, pointerId: 1 });
    expect(s().elements.get("a")!.points[0]).toMatchObject({ x: 100, y: 100 });
    expect(s().canUndo).toBe(false);
    expect([...s().selection]).toEqual(["a"]);
  });

  it("lost_pointer_capture_clears_the_guides", async () => {
    await load([box("a", 100, 100), box("b", 400, 400)]);
    s().select(["a"]);
    const { container } = frame("a");
    const edge = startSnappedDrag(container);
    fireEvent.lostPointerCapture(edge, { pointerId: 1 });
    expect(s().guides).toEqual([]);
    expect(container.querySelector(".box-frame")).not.toBeNull();
  });
});
