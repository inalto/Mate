import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}) },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));

import { contentOf, type TextBoxContent } from "../../model/content";
import type { Element } from "../../model/types";
import { isMathBox, latexOf } from "../../math/mathBox";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { elementBounds } from "../../tools/spatialIndex";
import { textAttrsOf } from "../../text/textBox";
import { insertResultBelow, resultLatex } from "../../math/computeResult";
import ComputeMenu from "../ComputeMenu";
import { useToastStore } from "../Toast";

const s = () => useEditorStore.getState();

async function mathBox(latex: string): Promise<Element> {
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  useEditorStore.setState({ viewport: { width: 1000, height: 800 } });
  const id = s().addMathBox()!;
  const el = s().elements.get(id)!;
  s().endEdit();
  s().updateElements([{ ...el, content: { ...(el.content as object), latex, textAttributes: { ...textAttrsOf(el), fontSize: 40, color: "#C62828" } } }]);
  s().select([id]);
  return s().elements.get(id)!;
}

const others = (id: string) => [...s().elements.values()].filter((e) => e.id !== id);

describe("ComputeMenu", () => {
  beforeEach(() => useToastStore.getState().dismiss());
  afterEach(cleanup);

  it("lists_the_five_operations", async () => {
    const src = await mathBox("2+3");
    render(<ComputeMenu store={useEditorStore} source={src} />);
    fireEvent.click(screen.getByRole("button", { name: /Compute/ }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Evaluate", "Simplify", "Expand", "Solve", "Numeric value"]);
  });

  it("inserts_the_result_below_the_source_as_one_undo_step", async () => {
    const src = await mathBox("2+3");
    render(<ComputeMenu store={useEditorStore} source={src} />);
    fireEvent.click(screen.getByRole("button", { name: /Compute/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Evaluate" }));
    await waitFor(() => expect(others(src.id)).toHaveLength(1));
    const out = others(src.id)[0];
    expect(isMathBox(out)).toBe(true);
    expect(latexOf(out)).toBe("=5");
    expect(out.points[0].x).toBe(src.points[0].x);
    const b = elementBounds(src);
    expect(out.points[0].y).toBe(b.y + b.height + 12);
    expect(textAttrsOf(out).fontSize).toBe(40);
    expect(textAttrsOf(out).color).toBe("#C62828");
    expect([...s().selection]).toEqual([out.id]);
    act(() => s().undo());
    expect(others(src.id)).toHaveLength(0);
  });

  it("shows_errors_as_a_toast", async () => {
    const src = await mathBox("2+3=5");
    render(<ComputeMenu store={useEditorStore} source={src} />);
    fireEvent.click(screen.getByRole("button", { name: /Compute/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Solve" }));
    await waitFor(() => expect(useToastStore.getState().message).toBe("Nothing to solve for"));
    expect(others(src.id)).toHaveLength(0);
  });

  it("renders_extra_items_after_the_operations", async () => {
    const src = await mathBox("x");
    const run = vi.fn();
    render(<ComputeMenu store={useEditorStore} source={src} extraItems={[{ key: "wa", label: "Ask somewhere else", run }]} />);
    fireEvent.click(screen.getByRole("button", { name: /Compute/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Ask somewhere else" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith({ store: useEditorStore, source: src }));
  });
});

describe("insertResultBelow", () => {
  afterEach(cleanup);

  it("inserts_plain_text_as_a_text_box", async () => {
    const src = await mathBox("x");
    const id = insertResultBelow(useEditorStore, src, { text: "x is 3 & more" })!;
    const out = s().elements.get(id)!;
    expect(out.type).toBe("text-box");
    expect(isMathBox(out)).toBe(false);
    const c = contentOf<TextBoxContent>(out);
    expect(c.rawContent).toBe("x is 3 & more");
    expect(c.contentHtml).toBe("<p>x is 3 &amp; more</p>");
  });

  it("refuses_when_the_page_changed", async () => {
    const src = await mathBox("x");
    expect(insertResultBelow(useEditorStore, { ...src, pageId: "other" }, { latex: "1" })).toBeNull();
  });
});

describe("resultLatex", () => {
  it("prefixes_a_relation_for_expressions_only", () => {
    expect(resultLatex("2+3", "evaluate", "5")).toBe("=5");
    expect(resultLatex("\\pi", "numeric", "3.14159")).toBe("\\approx 3.14159");
    expect(resultLatex("2x=4", "solve", "x=2")).toBe("x=2");
    expect(resultLatex("(x+1)^2=4", "expand", "x^2+2x+1=4")).toBe("x^2+2x+1=4");
  });
});
