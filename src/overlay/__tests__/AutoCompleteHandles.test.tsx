import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import AutoCompletePopover from "../../components/AutoCompletePopover";
import { createToolController } from "../../canvas/toolInteractions";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { contentOf, type ConnectorContent } from "../../model/content";
import { shapeElement, shapeFromDrag, shapeRectOf } from "../../shapes/geometry";
import { closeAutoComplete, useAutoCompleteStore } from "../../stores/autoComplete";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { AUTO_COMPLETE_GAP } from "../../tools/autoComplete";
import AutoCompleteHandles from "../AutoCompleteHandles";

const STAMP = "2026-01-01T00:00:00.000Z";
const style = { shapeType: "rectangle" as const, color: "#000000", fillColor: "transparent", width: 2, fillOpacity: 1 };
const rect = (id: string, x: number, y: number): Element =>
  shapeElement(style, shapeFromDrag("rectangle", { x, y }, { x: x + 100, y: y + 100 }, false), "pg", id, STAMP);

let store: EditorStore;
const s = () => store.getState();
const connectors = () => [...s().elements.values()].filter((e) => e.type === "connector");
const ends = (el: Element) => contentOf<ConnectorContent>(el);

async function ready() {
  loaded.els = [rect("a", 0, 0), rect("b", 400, 0)];
  useNotebookStore.setState({ loaded: true });
  store = createEditorStore();
  await s().loadPage("pg");
  store.setState({ viewport: { width: 1000, height: 800 }, camera: { x: 0, y: 0, z: 1 } });
  s().setTool("cursor");
  s().select(["a"]);
}

function controller() {
  return createToolController({
    store,
    el: document.createElement("div"),
    requestLive: () => {},
    invalidate: () => {},
    renderElement: () => {},
    getSettings: () => DEFAULT_SETTINGS,
  });
}

/** Press the `side` handle of the selected element and drag the canvas pointer through `path`. */
function dragFromHandle(tools: ReturnType<typeof controller>, side: "right" | "bottom", path: { x: number; y: number }[]) {
  store.setState({ autoCompleteDrag: { sourceId: "a", side } });
  tools.down(path[0], "cursor");
  tools.move(path.slice(1));
  tools.up();
}

const ui = () =>
  render(
    <div className="pane">
      <AutoCompleteHandles store={store} />
      <AutoCompletePopover store={store} />
    </div>,
  );

describe("AutoCompleteHandles", () => {
  beforeEach(async () => {
    await ready();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultConnectorMode: "elbow", defaultConnectorColor: "#C62828" } });
  });
  afterEach(() => {
    cleanup();
    closeAutoComplete();
  });

  it("shows_four_arrows_outside_a_lone_closed_shape_and_hides_them_otherwise", () => {
    const { container } = ui();
    const buttons = () => [...container.querySelectorAll<HTMLButtonElement>(".auto-complete-handle")];
    expect(buttons().map((b) => b.dataset.side)).toEqual(["top", "right", "bottom", "left"]);
    // Hit area ≥ 24 px, outside the element (right side at x = 101 with the stroke).
    const right = buttons()[1];
    expect(parseFloat(right.style.width)).toBeGreaterThanOrEqual(24);
    expect(parseFloat(right.style.left)).toBeGreaterThan(101);
    act(() => store.setState({ dragging: true }));
    expect(buttons()).toHaveLength(0);
    act(() => store.setState({ dragging: false, editingId: "a" }));
    expect(buttons()).toHaveLength(0);
    act(() => store.setState({ editingId: null, selection: new Set(["a", "b"]) }));
    expect(buttons()).toHaveLength(0);
    act(() => store.setState({ selection: new Set(["a"]), tool: "pen" }));
    expect(buttons()).toHaveLength(0);
    act(() => store.setState({ tool: "cursor" }));
    expect(buttons()).toHaveLength(4);
  });

  it("click_adds_element_and_connector_in_one_undo_step", () => {
    const tools = controller();
    const { getByRole } = ui();
    // A tap on the right arrow (no drag): the popover opens next to it.
    act(() => dragFromHandle(tools, "right", [{ x: 140, y: 50 }]));
    expect(useAutoCompleteStore.getState().target).toMatchObject({ sourceId: "a", side: "right", at: null });
    fireEvent.click(getByRole("button", { name: "Ellipse" }));
    expect(useAutoCompleteStore.getState().target).toBeNull();
    const added = [...s().elements.values()].find((e) => e.shapeType === "ellipse")!;
    expect(shapeRectOf(added).x).toBe(100 + AUTO_COMPLETE_GAP);
    expect(s().selection).toEqual(new Set([added.id]));
    expect(s().editingId).toBe(added.id);
    const [c] = connectors();
    expect(ends(c).source).toEqual({ id: "a", side: "right" });
    expect(ends(c).target).toEqual({ id: added.id, side: "left" });
    expect(ends(c).mode).toBe("elbow");
    expect(c.color).toBe("#C62828");
    expect(s().elements.size).toBe(4);
    act(() => s().endEdit());
    s().undo();
    expect(s().elements.size).toBe(2);
    expect(connectors()).toHaveLength(0);
    s().redo();
    expect(s().elements.size).toBe(4);
  });

  it("drag_release_on_a_shape_binds_without_creating_an_element", () => {
    const tools = controller();
    dragFromHandle(tools, "right", [{ x: 120, y: 50 }, { x: 300, y: 50 }, { x: 402, y: 50 }]);
    expect(s().elements.size).toBe(3);
    const [c] = connectors();
    expect(ends(c).source).toEqual({ id: "a", side: "right" });
    expect(ends(c).target?.id).toBe("b");
    expect(useAutoCompleteStore.getState().target).toBeNull();
    expect(s().dragging).toBe(false);
  });

  it("drag_release_in_empty_space_opens_the_popover_there_and_binds_the_choice", () => {
    const tools = controller();
    const { getByRole } = ui();
    act(() => dragFromHandle(tools, "bottom", [{ x: 50, y: 120 }, { x: 60, y: 300 }]));
    const [free] = connectors();
    expect(ends(free).target).toBeUndefined();
    expect(useAutoCompleteStore.getState().target).toMatchObject({ sourceId: "a", side: "bottom", at: { x: 60, y: 300 }, connectorId: free.id });
    fireEvent.click(getByRole("button", { name: "Text" }));
    const text = [...s().elements.values()].find((e) => e.type === "text-box")!;
    expect([text.points[0].x + 100, text.points[0].y + 30]).toEqual([60, 300]);
    expect(connectors()).toHaveLength(1);
    expect(ends(connectors()[0]).target).toEqual({ id: text.id, side: "top" });
    // One undo takes back the text box and the connector drawn for it.
    store.setState({ editingId: null });
    s().undo();
    expect(s().elements.size).toBe(2);
  });

  it("escape_at_the_popover_keeps_the_free_ended_connector", () => {
    const tools = controller();
    ui();
    act(() => dragFromHandle(tools, "right", [{ x: 120, y: 50 }, { x: 250, y: 300 }]));
    expect(useAutoCompleteStore.getState().target).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useAutoCompleteStore.getState().target).toBeNull();
    expect(connectors()).toHaveLength(1);
    expect(ends(connectors()[0]).target).toBeUndefined();
    expect(s().elements.size).toBe(3);
  });

  it("note_choice_adds_a_200_square_card", () => {
    const id = s().autoComplete("a", "left", { kind: "note" });
    const note = s().elements.get(id!)!;
    expect([note.type, note.boxWidth, note.boxHeight]).toEqual(["text-box", 200, 200]);
    expect(contentOf<{ card: { radius: number; shadow: string; border: boolean } }>(note).card).toMatchObject({ radius: 8, shadow: "soft", border: false });
    expect(note.points[0].x).toBe(-AUTO_COMPLETE_GAP - 200);
  });

  it("hands_the_press_to_the_pane_canvas", () => {
    const { container } = render(
      <div className="pane">
        <canvas className="canvas-layer canvas-live" />
        <AutoCompleteHandles store={store} />
      </div>,
    );
    const canvas = container.querySelector("canvas")!;
    let seen: unknown = null;
    canvas.addEventListener("pointerdown", () => {
      seen = s().autoCompleteDrag;
    });
    const right = container.querySelector<HTMLButtonElement>('[data-side="right"]')!;
    fireEvent.pointerDown(right, { pointerId: 7, pointerType: "mouse", button: 0, buttons: 1, clientX: 150, clientY: 50 });
    expect(seen).toEqual({ sourceId: "a", side: "right" });
    // The controller was not there to take it: nothing is left pending.
    expect(s().autoCompleteDrag).toBeNull();
  });
});
