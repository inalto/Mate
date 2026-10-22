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
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));

import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { resizeBox } from "../boxGeometry";
import { registerEditor } from "../editorRegistry";
import OverlayLayer from "../OverlayLayer";

const box = el("box", [[100, 100]], { type: "text-box", boxWidth: 200, boxHeight: 80, width: 1 });
const img = el("img", [[400, 100]], { type: "image", width: 200, height: 100 });
const ink = el("ink", [[0, 400], [300, 400]]);

let store: EditorStore;
const s = () => store.getState();

async function load(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
}

describe("OverlayLayer", () => {
  beforeEach(async () => {
    store = createEditorStore();
    await load([box, img, ink]);
  });
  afterEach(cleanup);

  it("follows_the_camera", () => {
    const { getByTestId } = render(<OverlayLayer store={store} />);
    act(() => store.setState({ camera: { x: 12, y: -30, z: 1.5 } }));
    const layer = getByTestId("overlay-layer");
    expect(layer.style.transform).toBe("translate(12px, -30px) scale(1.5)");
    expect(layer.style.transformOrigin).toBe("0 0");
  });

  it("frames_selected_boxed_elements_only", () => {
    const { container } = render(<OverlayLayer store={store} />);
    expect(container.querySelectorAll("[data-box-frame]")).toHaveLength(0);
    act(() => s().select(["box"]));
    const frame = container.querySelector('[data-box-frame="box"]') as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.style.left).toBe("100px");
    expect(frame.style.top).toBe("100px");
    expect(frame.style.width).toBe("200px");
    expect(frame.style.height).toBe("80px");
    expect(frame.querySelectorAll("[data-handle]")).toHaveLength(8);
    // Strokes get no DOM frame; with several boxes selected the frames are outlines only.
    act(() => s().select(["box", "img", "ink"]));
    expect(container.querySelectorAll("[data-box-frame]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-handle]")).toHaveLength(0);
  });

  it("hosts_the_editor_for_editingId", () => {
    const Editor = ({ el: e }: { el: Element }) => <span data-testid="tb-editor">{e.id}</span>;
    const unregister = registerEditor("text-box", Editor);
    const { container, queryByTestId } = render(<OverlayLayer store={store} />);
    expect(container.querySelector("[data-editor-for]")).toBeNull();
    act(() => s().beginEdit("box"));
    expect(container.querySelector('[data-editor-for="box"]')).not.toBeNull();
    expect(queryByTestId("tb-editor")?.textContent).toBe("box");
    // Types without an editor get an empty slot (no-op default).
    act(() => s().beginEdit("img"));
    expect(container.querySelector('[data-editor-for="img"]')!.childElementCount).toBe(0);
    unregister();
  });

  it("dragging_a_handle_resizes_in_page_units", () => {
    const { container } = render(<OverlayLayer store={store} />);
    act(() => {
      store.setState({ camera: { x: 0, y: 0, z: 2 } });
      s().select(["box"]);
    });
    const se = container.querySelector('[data-handle="se"]') as HTMLElement;
    fireEvent.pointerDown(se, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
    fireEvent.pointerMove(se, { clientX: 40, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(se, { clientX: 40, clientY: 20, pointerId: 1 });
    const b = s().elements.get("box")!;
    expect([b.boxWidth, b.boxHeight]).toEqual([220, 90]);
    expect(b.points[0]).toMatchObject({ x: 100, y: 100 });
    s().undo();
    expect(s().elements.get("box")!.boxWidth).toBe(200);
  });
});

describe("resizeBox", () => {
  const r = { x: 0, y: 0, width: 100, height: 50 };
  it("moves_the_dragged_edges", () => {
    expect(resizeBox(r, "e", 10, 99, false)).toEqual({ x: 0, y: 0, width: 110, height: 50 });
    expect(resizeBox(r, "nw", 10, 5, false)).toEqual({ x: 10, y: 5, width: 90, height: 45 });
    expect(resizeBox(r, "s", 0, -100, false)).toEqual({ x: 0, y: 0, width: 100, height: 8 });
  });
  it("keeps_aspect_when_asked", () => {
    const out = resizeBox(r, "se", 100, 0, true);
    expect(out.width / out.height).toBeCloseTo(2);
    expect(out.width).toBe(200);
  });
});
