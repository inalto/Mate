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
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { DEFAULT_DOMAIN, GRAPH_PALETTE, graphDataOf } from "../../graph/data";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { isTypingTarget } from "../../keys/shortcuts";
import { hasEditor } from "../editorRegistry";
import OverlayLayer from "../OverlayLayer";
import "../GraphEditor";

let store: EditorStore;
const s = () => store.getState();

async function load(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
}

function insert(): { id: string; ui: ReturnType<typeof render> } {
  const ui = render(<OverlayLayer store={store} />);
  let id = "";
  act(() => {
    id = s().addGraph()!;
  });
  return { id, ui };
}

const data = (id: string) => graphDataOf(s().elements.get(id)!);

function plotOf(ui: ReturnType<typeof render>): HTMLElement {
  const plot = ui.getByTestId("graph-plot");
  plot.getBoundingClientRect = () => ({ left: 0, top: 0, right: 480, bottom: 360, width: 480, height: 360, x: 0, y: 0, toJSON: () => ({}) });
  return plot;
}

/** A 2D context stand-in recording the stroke colour of each stroke() (jsdom has no canvas). */
function recordingContext() {
  const strokes: string[] = [];
  const props: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(props, {
    get: (t, k) => (k in t ? t[k] : k === "stroke" ? () => strokes.push(String(t.strokeStyle)) : () => {}),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes };
}
let canvasCtx: ReturnType<typeof recordingContext>;

describe("GraphEditor", () => {
  beforeEach(async () => {
    canvasCtx = recordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => canvasCtx.ctx) as never);
    store = createEditorStore();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    await load([]);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("is_registered_for_graphs", () => expect(hasEditor("graph")).toBe(true));

  it("insert_places_default_graph_at_viewport_centre_and_edits", () => {
    const { id } = insert();
    const el = s().elements.get(id)!;
    expect(el.type).toBe("graph");
    expect([el.boxWidth, el.boxHeight]).toEqual([480, 360]);
    expect(s().editingId).toBe(id);
    const g = data(id);
    expect(g.domain).toEqual(DEFAULT_DOMAIN);
    expect(g.grid).toBe(true);
    expect(g.expressions).toHaveLength(1);
    expect(g.expressions[0]).toMatchObject({ latex: "", color: GRAPH_PALETTE[0], visible: true });
  });

  it("edits_persist_on_end_edit_as_one_history_entry", () => {
    const { id, ui } = insert();
    const input = ui.getByLabelText("Expression 1") as HTMLInputElement;
    expect(isTypingTarget(input)).toBe(true);
    act(() => void fireEvent.change(input, { target: { value: "\\sin(x)" } }));
    act(() => void fireEvent.click(ui.getByRole("button", { name: "Add expression" })));
    act(() => void fireEvent.change(ui.getByLabelText("Expression 2"), { target: { value: "x^2" } }));
    act(() => void fireEvent.click(ui.getByLabelText("Colour of expression 2")));
    act(() => void fireEvent.click(ui.getByLabelText("Hide expression 1")));
    act(() => void fireEvent.change(ui.getByLabelText("x max"), { target: { value: "20" } }));
    act(() => void fireEvent.click(ui.getByLabelText("Grid")));
    expect(data(id).expressions[0].latex).toBe(""); // nothing written while editing
    act(() => void fireEvent.keyDown(input, { key: "Escape" }));
    expect(s().editingId).toBeNull();
    const g = data(id);
    expect(g.expressions.map((e) => e.latex)).toEqual(["\\sin(x)", "x^2"]);
    expect(g.expressions.map((e) => e.visible)).toEqual([false, true]);
    expect(g.expressions[1].color).toBe(GRAPH_PALETTE[2]); // second row starts at palette[1], one click on
    expect(g.domain).toEqual({ ...DEFAULT_DOMAIN, xMax: 20 });
    expect(g.grid).toBe(false);
    // One entry for the session: undo restores the inserted default, a second undo the insert.
    act(() => s().undo());
    expect(data(id).expressions.map((e) => e.latex)).toEqual([""]);
    act(() => s().undo());
    expect(s().elements.has(id)).toBe(false);
  });

  it("parse_errors_show_inline_and_do_not_block", () => {
    const { id, ui } = insert();
    const input = ui.getByLabelText("Expression 1");
    act(() => void fireEvent.change(input, { target: { value: "\\sqrt{" } }));
    const err = ui.container.querySelector(".graph-expr-error");
    expect(err?.textContent).toBeTruthy();
    act(() => void fireEvent.change(input, { target: { value: "\\sqrt{x}" } }));
    expect(ui.container.querySelector(".graph-expr-error")).toBeNull();
    act(() => void fireEvent.change(input, { target: { value: "\\sqrt{" } }));
    act(() => s().endEdit());
    expect(data(id).expressions[0].latex).toBe("\\sqrt{"); // kept as typed
  });

  it("delete_removes_a_row", () => {
    const { id, ui } = insert();
    act(() => void fireEvent.click(ui.getByRole("button", { name: "Add expression" })));
    act(() => void fireEvent.change(ui.getByLabelText("Expression 2"), { target: { value: "x" } }));
    act(() => void fireEvent.click(ui.getByLabelText("Delete expression 1")));
    act(() => s().endEdit());
    expect(data(id).expressions.map((e) => e.latex)).toEqual(["x"]);
  });

  it("wheel_zooms_about_the_cursor_and_drag_pans", () => {
    const { id, ui } = insert();
    const plot = plotOf(ui);
    // Zoom in about the right edge's middle (x = 10, y = 0): that point stays put.
    act(() => void fireEvent.wheel(plot, { deltaY: -200, clientX: 480, clientY: 180 }));
    const dom = (ui.getByLabelText("x max") as HTMLInputElement).value;
    expect(Number(dom)).toBeCloseTo(10);
    expect(Number((ui.getByLabelText("x min") as HTMLInputElement).value)).toBeGreaterThan(-10);
    act(() => s().endEdit());
    const z = data(id).domain;
    expect(z.xMax).toBeCloseTo(10);
    expect(z.xMax - z.xMin).toBeLessThan(20);
    expect(z.yMin + z.yMax).toBeCloseTo(0);

    // Drag 24 px right over a 480 px wide 20-unit view: the domain moves 1 unit left.
    act(() => s().beginEdit(id));
    const plot2 = plotOf(ui);
    act(() => {
      fireEvent.pointerDown(plot2, { clientX: 100, clientY: 100, pointerId: 1, button: 0 });
      fireEvent.pointerMove(plot2, { clientX: 124, clientY: 100, pointerId: 1 });
      fireEvent.pointerUp(plot2, { clientX: 124, clientY: 100, pointerId: 1 });
    });
    act(() => s().endEdit());
    const range = z.xMax - z.xMin;
    expect(data(id).domain.xMin).toBeCloseTo(z.xMin - (24 / 480) * range);
    expect(data(id).domain.yMin).toBeCloseTo(z.yMin);
  });

  it("plot_area_draws_the_live_scene", () => {
    const { ui } = insert();
    expect(canvasCtx.strokes).not.toContain(GRAPH_PALETTE[0]);
    act(() => void fireEvent.change(ui.getByLabelText("Expression 1"), { target: { value: "y = 2x" } }));
    expect(canvasCtx.strokes).toContain(GRAPH_PALETTE[0]);
  });

  it("unchanged_session_records_nothing", () => {
    const { id } = insert();
    act(() => s().endEdit());
    act(() => s().undo());
    expect(s().elements.has(id)).toBe(false);
  });
});
