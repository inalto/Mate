// Restyling a selection that holds recall covers: a cover keeps hiding what is under it. A box
// cover's fill is always its colour; a width meant for ink never thins a stroke cover.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => loaded.els) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { coverBoxElement } from "../../covers/cover";
import { shapeFromDrag } from "../../shapes/geometry";
import { createEditorStore, type EditorStore } from "../editor";
import { useNotebookStore } from "../notebook";

const box = coverBoxElement("#334155", shapeFromDrag("rectangle", { x: 0, y: 0 }, { x: 100, y: 50 }, false), "pg", "box", "T");
const stroke = el("cv", [[0, 200], [100, 200]], { width: 28, penStyle: "cover", color: "#334155" });
const shape = { ...box, id: "rect", content: { fillOpacity: 1 }, width: 2, fillColor: "transparent" };
const ink = el("ink", [[0, 400], [100, 400]]);

let store: EditorStore;
const s = () => store.getState();
const get = (id: string) => s().elements.get(id)!;

beforeEach(async () => {
  store = createEditorStore();
  loaded.els = [box, stroke, shape, ink];
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
});

describe("restyling a selection with covers", () => {
  it("a fill applied to a mixed selection leaves the covers' fill alone", () => {
    s().select(["box", "cv", "rect"]);
    s().restyleSelection({ fillColor: "transparent" });
    expect(get("box").fillColor).toBe("#334155");
    expect(get("cv").fillColor).toBeUndefined();
    s().restyleSelection({ fillColor: "#FF0000" });
    expect(get("rect").fillColor).toBe("#FF0000");
    expect(get("box").fillColor).toBe("#334155");
  });

  it("a width applied to a mixed selection leaves the covers alone", () => {
    s().select(["box", "cv", "ink"]);
    s().restyleSelection({ width: 1 });
    expect(get("ink").width).toBe(1);
    expect(get("cv").width).toBe(28);
    expect(get("box").width).toBe(0);
  });

  it("a width for stroke covers alone still applies (their own width control)", () => {
    s().select(["cv"]);
    s().restyleSelection({ width: 40 });
    expect(get("cv").width).toBe(40);
    s().select(["box"]);
    s().restyleSelection({ width: 40 });
    expect(get("box").width).toBe(0);
  });

  it("a colour keeps a box cover's fill equal to it, in any selection", () => {
    s().select(["box", "ink", "rect"]);
    s().restyleSelection({ color: "#FDE047" });
    expect(get("box")).toMatchObject({ color: "#FDE047", fillColor: "#FDE047" });
    expect(get("rect").fillColor).toBe("transparent");
    expect(get("ink").color).toBe("#FDE047");
  });
});
