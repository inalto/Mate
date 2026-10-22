import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}) },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));

import { graphDataOf } from "../../graph/data";
import { mathElement } from "../../math/mathBox";
import { elementBounds } from "../../tools/spatialIndex";
import { useEditorStore } from "../editor";
import { useNotebookStore } from "../notebook";

const s = () => useEditorStore.getState();

async function setup() {
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  useEditorStore.setState({ viewport: { width: 1000, height: 800 }, spaceMode: "insert", spaceCutImages: false });
}
const addBox = (x: number, y: number, w: number, h: number) => {
  const id = s().addTextBox({ x, y })!;
  const cur = s().elements.get(id)!;
  s().endEdit();
  useEditorStore.setState({ elements: new Map(s().elements).set(id, { ...cur, boxWidth: w, boxHeight: h }) });
  return id;
};

describe("editor insert space and alignment", () => {
  beforeEach(setup);

  it("insert_space_is_one_history_entry_and_undoable", () => {
    const a = addBox(0, 100, 50, 50);
    s().insertSpace(50, 40);
    expect(elementBounds(s().elements.get(a)!).y).toBe(140);
    s().undo();
    expect(elementBounds(s().elements.get(a)!).y).toBe(100);
  });

  it("zero_delta_adds_no_entry", () => {
    addBox(0, 100, 50, 50);
    const redoBefore = s().canUndo;
    s().insertSpace(50, 0);
    s().insertSpace(5000, 30); // nothing below the line
    expect(s().canUndo).toBe(redoBefore);
  });

  it("remove_mode_ignores_downward_drags", () => {
    const a = addBox(0, 100, 50, 50);
    useEditorStore.setState({ spaceMode: "remove" });
    s().insertSpace(50, 40);
    expect(elementBounds(s().elements.get(a)!).y).toBe(100);
    s().insertSpace(50, -30);
    expect(elementBounds(s().elements.get(a)!).y).toBe(70);
  });

  it("aligns_and_distributes_the_selection_as_single_entries", () => {
    const a = addBox(10, 0, 20, 20);
    const b = addBox(100, 0, 20, 20);
    const c = addBox(300, 0, 20, 20);
    s().select([a, b, c]);
    s().distributeSelection("horizontal");
    expect(elementBounds(s().elements.get(b)!).x).toBe(155);
    s().alignSelection("left");
    expect([a, b, c].map((id) => elementBounds(s().elements.get(id)!).x)).toEqual([10, 10, 10]);
    s().undo();
    expect(elementBounds(s().elements.get(b)!).x).toBe(155);
  });

  it("graph_from_equation_adds_a_graph_below_with_that_latex", () => {
    const m = mathElement("pg", "m1", new Date().toISOString(), { x: 40, y: 40 }, "#000000");
    const withLatex = { ...m, content: { ...(m.content as object), latex: "y=x^2" } };
    useEditorStore.setState({ elements: new Map(s().elements).set("m1", withLatex) });
    s().select(["m1"]);
    const id = s().graphFromSelectedEquation()!;
    const g = s().elements.get(id)!;
    expect(g.type).toBe("graph");
    expect(graphDataOf(g).expressions[0].latex).toBe("y=x^2");
    expect(elementBounds(g).y).toBeGreaterThanOrEqual(elementBounds(withLatex).y + elementBounds(withLatex).height);
    s().undo();
    expect(s().elements.has(id)).toBe(false);
  });

  it("graph_from_equation_uses_inferred_kind", () => {
    const m = mathElement("pg", "m2", new Date().toISOString(), { x: 40, y: 40 }, "#000000");
    useEditorStore.setState({ elements: new Map(s().elements).set("m2", { ...m, content: { ...(m.content as object), latex: String.raw`\sin(2\theta)` } }) });
    s().select(["m2"]);
    const id = s().graphFromSelectedEquation()!;
    expect(graphDataOf(s().elements.get(id)!).kind).toBe("2d-polar");
  });
});
