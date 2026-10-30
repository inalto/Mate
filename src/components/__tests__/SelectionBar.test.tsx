import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}) },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));

import { contentOf, type TextBoxContent } from "../../model/content";
import { shapeFromDrag } from "../../shapes/geometry";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import SelectionBar from "../SelectionBar";
import { disposeAll, setWorkerFactory, type WorkerLike } from "../../code/runtime";
import { codeOf } from "../../text/tableCode";

describe("SelectionBar", () => {
  afterEach(cleanup);

  it("restyles_selected_shapes_fill_stroke_and_width", async () => {
    useNotebookStore.setState({ loaded: true });
    await useEditorStore.getState().loadPage("pg");
    useEditorStore.setState({ viewport: { width: 1000, height: 800 } });
    const s = () => useEditorStore.getState();
    const id = s().addShape(
      { shapeType: "rectangle", color: "#000000", fillColor: "transparent", width: 2, fillOpacity: 1 },
      shapeFromDrag("rectangle", { x: 100, y: 200 }, { x: 300, y: 300 }, false),
    )!;
    s().select([id]);
    render(<SelectionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Colour #1565C0" }));
    expect(s().elements.get(id)!.color).toBe("#1565C0");
    fireEvent.click(screen.getByRole("button", { name: "Fill colour" }));
    fireEvent.click(screen.getByRole("button", { name: "Fill #C62828" }));
    expect(s().elements.get(id)!.fillColor).toBe("#C62828");
    fireEvent.click(screen.getByRole("button", { name: "Fill colour" }));
    fireEvent.click(screen.getByRole("button", { name: "No fill" }));
    expect(s().elements.get(id)!.fillColor).toBe("transparent");
    fireEvent.change(screen.getByRole("slider", { name: "Selection width" }), { target: { value: "10" } });
    expect(s().elements.get(id)!.width).toBe(4);
  });

  it("a_labelled_shape_keeps_its_text_colour_behind_one_menu", async () => {
    useNotebookStore.setState({ loaded: true });
    await useEditorStore.getState().loadPage("pg");
    useEditorStore.setState({ viewport: { width: 1000, height: 800 } });
    const s = () => useEditorStore.getState();
    const id = s().addShape(
      { shapeType: "rectangle", color: "#000000", fillColor: "transparent", width: 2, fillOpacity: 1 },
      shapeFromDrag("rectangle", { x: 100, y: 200 }, { x: 300, y: 300 }, false),
    )!;
    s().setShapeLabel(id, { text: "hi", fontSize: 16, color: "#000000", align: "center" });
    s().select([id]);
    render(<SelectionBar />);
    // One swatch row (the stroke) on the bar; the text colours only in the menu.
    expect(screen.queryByRole("button", { name: "Text colour #1565C0" })).toBeNull();
    expect(screen.getByRole("button", { name: "Colour #1565C0" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Text colour" }));
    fireEvent.click(screen.getByRole("button", { name: "Text colour #1565C0" }));
    expect((contentOf<{ label?: { color: string } }>(s().elements.get(id)!).label)?.color).toBe("#1565C0");
    expect(screen.queryByRole("button", { name: "Text colour #1565C0" })).toBeNull(); // closed after the pick
  });

  it("formats_a_selected_text_box_as_a_whole", async () => {
    useNotebookStore.setState({ loaded: true });
    await useEditorStore.getState().loadPage("pg");
    useEditorStore.setState({ viewport: { width: 1000, height: 800 } });
    const s = () => useEditorStore.getState();
    const id = s().addTextBox({ x: 100, y: 200 })!;
    s().commitTextEdit({ ...s().elements.get(id)!, content: { ...(s().elements.get(id)!.content as object), contentHtml: "<p>hi</p>" } });
    s().endEdit();
    s().select([id]);
    const attrs = () => contentOf<TextBoxContent>(s().elements.get(id)!).textAttributes;
    render(<SelectionBar />);
    expect(screen.queryByRole("button", { name: "Bold" })).toBeNull(); // marks need the editor
    fireEvent.change(screen.getByRole("combobox", { name: "Font" }), { target: { value: "serif" } });
    fireEvent.click(screen.getByRole("button", { name: "Smaller text" }));
    fireEvent.click(screen.getByRole("button", { name: "Text colour #1565C0" }));
    fireEvent.click(screen.getByRole("button", { name: "Align right" }));
    expect(attrs()).toEqual({ fontFamily: "serif", fontSize: 18, color: "#1565C0", align: "right" });
    expect(screen.queryByRole("slider", { name: "Selection width" })).toBeNull();
    // While the box is being edited its own bar is shown instead.
    act(() => s().beginEdit(id));
    expect(screen.queryByRole("toolbar", { name: "Selection" })).toBeNull();
    act(() => s().endEdit());
  });

  it("copies_a_selected_equation_as_latex", async () => {
    useNotebookStore.setState({ loaded: true });
    await useEditorStore.getState().loadPage("pg");
    useEditorStore.setState({ viewport: { width: 1000, height: 800 } });
    const s = () => useEditorStore.getState();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const id = s().addMathBox()!;
    const el = s().elements.get(id)!;
    s().endEdit();
    s().updateElements([{ ...el, content: { ...(el.content as object), latex: "x^2" } }]);
    s().select([id]);
    render(<SelectionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Copy as LaTeX" }));
    expect(writeText).toHaveBeenCalledWith("x^2");
    // Other boxes do not offer it.
    const t = s().addTextBox({ x: 10, y: 10 })!;
    s().endEdit();
    act(() => s().select([t]));
    expect(screen.queryByRole("button", { name: "Copy as LaTeX" })).toBeNull();
  });
});

describe("SelectionBar align and math", () => {
  afterEach(cleanup);

  const setup = async () => {
    useNotebookStore.setState({ loaded: true });
    await useEditorStore.getState().loadPage("pg");
    useEditorStore.setState({ viewport: { width: 1000, height: 800 } });
    return () => useEditorStore.getState();
  };

  it("align_menu_needs_two_and_distribute_needs_three", async () => {
    const s = await setup();
    const rect = (x: number) =>
      s().addShape({ shapeType: "rectangle", color: "#000000", fillColor: "transparent", width: 2, fillOpacity: 1 }, shapeFromDrag("rectangle", { x, y: 10 * x }, { x: x + 20, y: 10 * x + 20 }, false))!;
    const a = rect(10);
    s().select([a]);
    const { unmount } = render(<SelectionBar />);
    expect(screen.queryByRole("button", { name: /Align/ })).toBeNull();
    unmount();
    const b = rect(50);
    s().select([a, b]);
    const r2 = render(<SelectionBar />);
    fireEvent.click(screen.getByRole("button", { name: /Align/ }));
    expect(screen.queryByRole("menuitem", { name: "Distribute horizontally" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Align left" }));
    expect(s().elements.get(b)!.points[0].x).toBe(s().elements.get(a)!.points[0].x);
    r2.unmount();
    const c = rect(90);
    s().select([a, b, c]);
    render(<SelectionBar />);
    fireEvent.click(screen.getByRole("button", { name: /Align/ }));
    expect(screen.getByRole("menuitem", { name: "Distribute vertically" })).toBeTruthy();
  });

  it("offers_compute_for_exactly_one_math_box", async () => {
    const s = await setup();
    const a = s().addMathBox()!;
    s().endEdit();
    const b = s().addMathBox()!;
    s().endEdit();
    s().select([a]);
    const { unmount } = render(<SelectionBar />);
    fireEvent.click(screen.getByRole("button", { name: /Compute/ }));
    expect(screen.getByRole("menuitem", { name: "Solve" })).toBeTruthy();
    unmount();
    s().select([a, b]);
    render(<SelectionBar />);
    expect(screen.queryByRole("button", { name: /Compute/ })).toBeNull();
  });

  it("runs_a_selected_runnable_code_block", async () => {
    const s = await setup();
    const posted: { type: string; id?: number; code?: string }[] = [];
    let worker: WorkerLike | null = null;
    setWorkerFactory(() => {
      worker = { onmessage: null, onerror: null, postMessage: (m: never) => void posted.push(m), terminate: () => {} };
      return worker;
    });
    try {
      const id = s().addCodespace()!;
      s().endEdit();
      const el = s().elements.get(id)!;
      s().updateElements([{ ...el, content: { subtype: "codespace", code: "6 * 7", language: "javascript" } }]);
      s().select([id]);
      const { unmount } = render(<SelectionBar />);
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      expect(posted[0]).toMatchObject({ type: "run", code: "6 * 7" });
      await act(async () => worker!.onmessage!({ data: { type: "result", id: posted[0].id, stdout: "42\n", stderr: "", status: "ok" } } as MessageEvent));
      expect(codeOf(s().elements.get(id)!).output).toMatchObject({ stdout: "42\n", status: "ok" });
      unmount();
      // Plain text blocks have nothing to run.
      s().updateElements([{ ...s().elements.get(id)!, content: { subtype: "codespace", code: "x", language: "plain" } }]);
      render(<SelectionBar />);
      expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    } finally {
      disposeAll();
      setWorkerFactory(null);
    }
  });
});
