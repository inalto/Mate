import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const builds = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../graph/plot", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../graph/plot")>();
  return {
    ...real,
    buildPlotScene: (...args: Parameters<typeof real.buildPlotScene>) => {
      builds.count++;
      return real.buildPlotScene(...args);
    },
  };
});

import { DEFAULT_SETTINGS } from "../../model/constants";
import { DEFAULT_DOMAIN, GRAPH_PALETTE, graphDataOf } from "../../graph/data";
import { loadEngine } from "../../graph/engine";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { isTypingTarget } from "../../keys/shortcuts";
import { hasEditor, registerEditor } from "../editorRegistry";
import OverlayLayer from "../OverlayLayer";
import GraphEditor from "../GraphEditor";

registerEditor("graph", GraphEditor);

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
let frames: FrameRequestCallback[] = [];
/** Run the pending animation frames. */
const flushFrames = () =>
  act(() => {
    for (const f of frames.splice(0)) f(0);
  });

describe("GraphEditor", () => {
  beforeAll(async () => {
    await loadEngine();
  });

  beforeEach(async () => {
    frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
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

  it("new_graphs_start_from_the_default_preset_of_the_kind", () => {
    const fn = { id: "p1", name: "Wide", kind: "2d-function" as const, domain: { xMin: -50, xMax: 50, yMin: -5, yMax: 5 }, grid: false, isDefault: true };
    const polar = { ...fn, id: "p2", kind: "2d-polar" as const, domain: { xMin: -1, xMax: 1, yMin: -1, yMax: 1 } };
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, graphPresets: [fn, polar] } });
    const { id } = insert();
    expect(data(id)).toMatchObject({ kind: "2d-function", grid: false, domain: fn.domain });
    expect(data(id).expressions).toHaveLength(1); // the preset has no expressions: the blank row stays
  });

  it("insert_places_default_graph_at_viewport_centre_and_edits", () => {
    const { id } = insert();
    const el = s().elements.get(id)!;
    expect(el.type).toBe("graph");
    expect([el.boxWidth, el.boxHeight]).toEqual([400, 400]); // square, like the default view
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
    act(() => void fireEvent.click(ui.getByRole("button", { name: "Add function" })));
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
    const err = document.querySelector(".graph-expr-error");
    expect(err?.textContent).toBeTruthy();
    act(() => void fireEvent.change(input, { target: { value: "\\sqrt{x}" } }));
    expect(document.querySelector(".graph-expr-error")).toBeNull();
    act(() => void fireEvent.change(input, { target: { value: "\\sqrt{" } }));
    act(() => s().endEdit());
    expect(data(id).expressions[0].latex).toBe("\\sqrt{"); // kept as typed
  });

  it("shows_how_the_input_was_read", () => {
    const { ui } = insert();
    const input = ui.getByLabelText("Expression 1");
    expect(document.querySelector(".graph-expr-preview")).toBeNull(); // nothing for an empty row
    act(() => void fireEvent.change(input, { target: { value: "y = sqrt(x) + x^10" } }));
    const preview = ui.getByLabelText("How expression 1 is read");
    expect(preview.querySelector(".katex")).not.toBeNull();
    expect(preview.querySelector(".katex annotation, .katex-mathml")).toBeNull(); // html output only
    expect(preview.textContent).toContain("10");
    expect(preview.querySelector(".sqrt")).not.toBeNull();
    expect(document.querySelector(".graph-expr-error")).toBeNull();
    // An error keeps its line under the preview.
    act(() => void fireEvent.change(input, { target: { value: "y = z" } }));
    expect(document.querySelector(".graph-expr-error")?.textContent).toBe("Unknown symbol: z");
  });

  it("delete_removes_a_row", () => {
    const { id, ui } = insert();
    act(() => void fireEvent.click(ui.getByRole("button", { name: "Add function" })));
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

  it("press_on_the_page_ends_editing_and_drops_the_frame", () => {
    const { id, ui } = insert();
    const page = document.createElement("div");
    page.className = "canvas-view";
    document.body.appendChild(page);
    expect(ui.container.querySelector(".box-frame-handle")).not.toBeNull();
    act(() => void fireEvent.pointerDown(page, { pointerId: 1, button: 0 }));
    expect(s().editingId).toBeNull();
    expect(s().selection.size).toBe(0);
    expect(ui.container.querySelector(".box-frame-handle")).toBeNull();
    page.remove();

    // A press on other chrome (a toolbar button) ends editing but keeps the graph selected.
    act(() => s().beginEdit(id));
    const chrome = document.createElement("button");
    document.body.appendChild(chrome);
    act(() => void fireEvent.pointerDown(chrome, { pointerId: 1, button: 0 }));
    expect(s().editingId).toBeNull();
    expect([...s().selection]).toEqual([id]);
    chrome.remove();
  });

  it("plot_area_draws_the_live_scene", () => {
    const { ui } = insert();
    expect(canvasCtx.strokes).not.toContain(GRAPH_PALETTE[0]);
    act(() => void fireEvent.change(ui.getByLabelText("Expression 1"), { target: { value: "y = 2x" } }));
    expect(canvasCtx.strokes).not.toContain(GRAPH_PALETTE[0]); // drawn on the next frame
    flushFrames();
    expect(canvasCtx.strokes).toContain(GRAPH_PALETTE[0]);
  });

  it("editor_rebuilds_scene_at_most_once_per_frame", () => {
    const { ui } = insert();
    act(() => void fireEvent.change(ui.getByLabelText("Expression 1"), { target: { value: "\\sin(x)" } }));
    flushFrames();
    const plot = plotOf(ui);
    builds.count = 0;
    for (let i = 0; i < 10; i++) act(() => void fireEvent.wheel(plot, { deltaY: -20, clientX: 240, clientY: 180 }));
    expect(builds.count).toBe(0);
    flushFrames();
    expect(builds.count).toBe(1);
    flushFrames();
    expect(builds.count).toBe(1);
  });

  it("unchanged_session_records_nothing", () => {
    const { id } = insert();
    act(() => s().endEdit());
    act(() => s().undo());
    expect(s().elements.has(id)).toBe(false);
  });

  it("opens_a_full_page_dialog_on_the_body_with_three_panes", () => {
    const { ui } = insert();
    const dialog = ui.getByRole("dialog", { name: "Edit graph" });
    expect(ui.container.contains(dialog)).toBe(false); // portaled out of the camera-transformed layer
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(ui.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Functions", "Graph", "Study"]);
    expect(ui.getAllByRole("tabpanel")).toHaveLength(3);
    expect(document.activeElement).toBe(ui.getByLabelText("Expression 1"));
    act(() => void fireEvent.click(ui.getByRole("tab", { name: "Study" })));
    expect(dialog.getAttribute("data-tab")).toBe("study");
    expect(ui.getByRole("tab", { name: "Study" }).getAttribute("aria-selected")).toBe("true");
  });

  it("a_press_inside_the_dialog_keeps_editing_and_done_commits_once", () => {
    const { id, ui } = insert();
    act(() => void fireEvent.change(ui.getByLabelText("Expression 1"), { target: { value: "x^2" } }));
    act(() => void fireEvent.pointerDown(ui.getByRole("dialog"), { pointerId: 1, button: 0 }));
    act(() => void fireEvent.pointerDown(document.querySelector(".graph-backdrop")!, { pointerId: 1, button: 0 }));
    act(() => void fireEvent.pointerDown(ui.getByTestId("graph-plot"), { pointerId: 1, button: 0 }));
    expect(s().editingId).toBe(id);
    act(() => void fireEvent.click(ui.getByRole("button", { name: "Done" })));
    expect(s().editingId).toBeNull();
    expect(ui.queryByRole("dialog")).toBeNull();
    expect(data(id).expressions[0].latex).toBe("x^2");
    act(() => s().undo());
    expect(data(id).expressions[0].latex).toBe("");
    // The close button ends the session the same way.
    act(() => s().beginEdit(id));
    act(() => void fireEvent.click(ui.getByRole("button", { name: "Close" })));
    expect(s().editingId).toBeNull();
  });

  it("pieces_with_bounds_and_open_or_closed_ends_are_saved", () => {
    const { id, ui } = insert();
    act(() => void fireEvent.change(ui.getByLabelText("Expression 1"), { target: { value: "x^2" } }));
    act(() => void fireEvent.click(ui.getByRole("button", { name: "Add piece" })));
    act(() => void fireEvent.change(ui.getByLabelText("Expression 1, piece 2"), { target: { value: "x" } }));
    act(() => void fireEvent.change(ui.getByLabelText("End of piece 1 of expression 1"), { target: { value: "1" } }));
    act(() => void fireEvent.click(ui.getByLabelText("Include the end of piece 1 of expression 1")));
    act(() => void fireEvent.change(ui.getByLabelText("Start of piece 2 of expression 1"), { target: { value: "1" } }));
    act(() => void fireEvent.click(ui.getByLabelText("Include the start of piece 2 of expression 1")));
    expect(ui.getByLabelText("Include the end of piece 1 of expression 1").textContent).toBe("]");
    expect(ui.getByLabelText("Include the start of piece 2 of expression 1").textContent).toBe("(");
    act(() => s().endEdit());
    const e = data(id).expressions[0];
    expect(e.latex).toBe("x^2");
    expect(e.pieces).toEqual([
      { latex: "x^2", max: 1, maxClosed: true },
      { latex: "x", min: 1, minClosed: false },
    ]);
    // Removing a piece leaves one bounded piece.
    act(() => s().beginEdit(id));
    act(() => void fireEvent.click(ui.getByLabelText("Remove piece 2 of expression 1")));
    act(() => s().endEdit());
    expect(data(id).expressions[0].pieces).toEqual([{ latex: "x^2", max: 1, maxClosed: true }]);
  });

  it("a_restricted_domain_accepts_simple_expressions_and_folds_back_when_unbounded", () => {
    const { id, ui } = insert();
    act(() => void fireEvent.change(ui.getByLabelText("Expression 1"), { target: { value: "sin(x)" } }));
    act(() => void fireEvent.click(ui.getByRole("button", { name: "Restrict domain" })));
    act(() => void fireEvent.change(ui.getByLabelText("Start of piece 1 of expression 1"), { target: { value: "0" } }));
    act(() => void fireEvent.change(ui.getByLabelText("End of piece 1 of expression 1"), { target: { value: "pi" } }));
    act(() => s().endEdit());
    expect(data(id).expressions[0].pieces).toEqual([{ latex: "sin(x)", min: 0, max: Math.PI }]);
    act(() => s().beginEdit(id));
    act(() => void fireEvent.change(ui.getByLabelText("Start of piece 1 of expression 1"), { target: { value: "" } }));
    act(() => void fireEvent.change(ui.getByLabelText("End of piece 1 of expression 1"), { target: { value: "" } }));
    act(() => s().endEdit());
    expect(data(id).expressions[0]).not.toHaveProperty("pieces");
    expect(data(id).expressions[0].latex).toBe("sin(x)");
  });

  it("a_piece_that_is_not_a_function_of_x_is_an_error", () => {
    const { ui } = insert();
    act(() => void fireEvent.change(ui.getByLabelText("Expression 1"), { target: { value: "x" } }));
    act(() => void fireEvent.click(ui.getByRole("button", { name: "Add piece" })));
    act(() => void fireEvent.change(ui.getByLabelText("Expression 1, piece 2"), { target: { value: "r = 1" } }));
    expect([...document.querySelectorAll(".graph-expr-error")].map((e) => e.textContent)).toContain("Each piece must be a function of x (y = …)");
  });

  it("the_symbol_bar_inserts_at_the_caret", () => {
    const { ui } = insert();
    const input = ui.getByLabelText("Expression 1") as HTMLInputElement;
    act(() => void fireEvent.focus(input));
    const bar = ui.getByRole("toolbar", { name: "Maths symbols" });
    act(() => void fireEvent.click(within(bar).getByRole("button", { name: "Square root" })));
    expect(input.value).toBe("sqrt()");
    // the caret goes inside the brackets
    expect(input.selectionStart).toBe(5);
    act(() => void fireEvent.click(within(bar).getByRole("button", { name: "Pi" })));
    expect(input.value).toBe("sqrt(pi)");
  });

  it("the_study_shows_results_and_its_switches_are_saved", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { id, ui } = insert();
      act(() => void fireEvent.change(ui.getByLabelText("Expression 1"), { target: { value: "x^2 - 4" } }));
      act(() => void vi.advanceTimersByTime(500));
      expect(ui.getByRole("heading", { name: "Study of f" })).toBeTruthy();
      expect(ui.getByText("x = −2, x = 2")).toBeTruthy();
      expect(ui.getByText("(0, −4)")).toBeTruthy(); // the minimum
      expect(ui.getByText(/In the visible range/).textContent).toBe("In the visible range: x from −10 to 10.");
      act(() => void fireEvent.click(ui.getByRole("switch", { name: "Show zeros" })));
      act(() => void fireEvent.click(ui.getByRole("switch", { name: "Show maxima and minima" })));
      act(() => void fireEvent.click(ui.getByRole("switch", { name: "Shade the area" })));
      act(() => s().endEdit());
      expect(data(id).expressions[0].study).toEqual({ zeros: true, extrema: true, area: { from: 0, to: 1 } });
      // A switch turned off again goes away.
      act(() => s().beginEdit(id));
      act(() => void vi.advanceTimersByTime(500));
      act(() => void fireEvent.click(ui.getByRole("switch", { name: "Show zeros" })));
      act(() => s().endEdit());
      expect(data(id).expressions[0].study).toEqual({ extrema: true, area: { from: 0, to: 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the_study_is_for_functions_of_x_only", () => {
    const { ui } = insert();
    act(() => void fireEvent.change(ui.getByLabelText("Expression 1"), { target: { value: "r = 1 + cos(theta)" } }));
    expect(ui.getByText("The study is available for functions y = f(x) only.")).toBeTruthy();
    expect(ui.queryByRole("button", { name: "Add piece" })).toBeNull();
  });
});
