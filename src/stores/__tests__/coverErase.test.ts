// Erasing never reaches under a covered recall cover: the eraser (both modes) and scribble-to-erase
// remove the cover, never the notes it hides. Under a revealed cover everything erases as before.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element, Point } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => loaded.els) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { coverBoxElement } from "../../covers/cover";
import { scribbleHits } from "../../ink/scribble";
import { shapeFromDrag } from "../../shapes/geometry";
import { createEditorStore, type EditorStore } from "../editor";
import { useNotebookStore } from "../notebook";
import { useSettingsStore } from "../settings";

/** Hidden ink, and a box cover from (-50,-50) to (200,100) over it. */
const ink = el("ink", [[10, 10], [70, 10]]);
const box = coverBoxElement("#334155", shapeFromDrag("rectangle", { x: -50, y: -50 }, { x: 200, y: 100 }, false), "pg", "box", "T");
/** A stroke cover lying over `ink`. */
const stroke = el("cv", [[0, 10], [80, 10]], { width: 28, penStyle: "cover", color: "#334155" });
const visible = el("far", [[500, 500], [600, 500]]);

/** A criss-crossing zigzag within x 0..94, y -2..24 (inside the box, clear of its outline). */
function zigzag(): Point[] {
  const corners: [number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const x = (i % 2 === 0 ? 0 : 80) + i * 2;
    const y = i % 2 === 0 ? (i % 4 === 0 ? 0 : 24) : i % 4 === 1 ? 20 : -2;
    corners.push([x, y]);
  }
  // Points every few units along the passes, as a pen reports them.
  const out: Point[] = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [[ax, ay], [bx, by]] = [corners[i], corners[i + 1]];
    for (let k = 0; k < 30; k++) out.push({ x: ax + ((bx - ax) * k) / 30, y: ay + ((by - ay) * k) / 30, pressure: 0.5, timestamp: out.length });
  }
  return out;
}

let store: EditorStore;
const s = () => store.getState();

async function load(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  store.setState({ camera: { x: 0, y: 0, z: 1 } });
}

function eraserSettings(type: "stroke" | "partial", eraseShapes = true) {
  useSettingsStore.setState((st) => ({ settings: { ...st.settings, defaultEraserType: type, defaultEraserWidth: 10, eraserEraseShapes: eraseShapes } }));
}

const scribble = () => s().scribbleErase(scribbleHits(s().elements, store.spatialIndex(), zigzag(), 1));
const ids = () => [...s().elements.keys()].sort();

beforeEach(() => {
  store = createEditorStore();
  eraserSettings("stroke");
});

describe("scribble-to-erase over a cover", () => {
  it("a zigzag inside a covered box cover removes the cover and keeps the hidden ink", async () => {
    await load([ink, box, visible]);
    scribble();
    expect(ids()).toEqual(["far", "ink"]);
  });

  it("a zigzag over a covered stroke cover removes the cover and keeps the ink beneath", async () => {
    await load([ink, stroke, visible]);
    scribble();
    expect(ids()).toEqual(["far", "ink"]);
  });

  it("under a revealed cover the zigzag erases the cover and the ink as before", async () => {
    await load([ink, box, visible]);
    s().toggleReveal("box");
    scribble();
    expect(ids()).toEqual(["far"]);
  });

  it("a locked covered cover keeps both itself and what it hides", async () => {
    await load([ink, { ...box, content: { ...(box.content as object), locked: true } }]);
    scribble();
    expect(ids()).toEqual(["box", "ink"]);
  });
});

describe("the eraser over a cover", () => {
  it("one stroke-eraser dab on a covered stroke cover removes only the cover", async () => {
    await load([ink, stroke]);
    s().eraser({ x: 40, y: 10 });
    s().endEraser();
    expect(ids()).toEqual(["ink"]);
  });

  it("one dab inside a covered box cover removes only the cover", async () => {
    await load([ink, box]);
    s().eraser({ x: 40, y: 10 });
    s().endEraser();
    expect(ids()).toEqual(["ink"]);
  });

  it("on a revealed cover the dab erases the cover and the ink beneath as before", async () => {
    await load([ink, stroke]);
    s().toggleReveal("cv");
    s().eraser({ x: 40, y: 10 });
    s().endEraser();
    expect(ids()).toEqual([]);
  });

  it("the rest of the drag that removed a cover never erases what it hid; the next drag does", async () => {
    await load([ink, box]);
    s().eraser({ x: 40, y: 10 });
    s().eraser({ x: 45, y: 10 });
    s().eraser({ x: 60, y: 10 });
    s().endEraser();
    expect(ids()).toEqual(["ink"]);
    s().eraser({ x: 40, y: 10 });
    s().endEraser();
    expect(ids()).toEqual([]);
  });

  it("with shapes not erasable, a dab inside a covered box cover erases nothing", async () => {
    eraserSettings("stroke", false);
    await load([ink, box]);
    s().eraser({ x: 40, y: 10 });
    s().endEraser();
    expect(ids()).toEqual(["box", "ink"]);
  });

  it("the partial eraser removes a covered cover whole and leaves what it hid", async () => {
    eraserSettings("partial");
    await load([ink, stroke]);
    s().eraser({ x: 40, y: 10 });
    s().endEraser();
    expect(ids()).toEqual(["ink"]);
    expect(s().elements.get("ink")).toEqual(ink);
  });

  it("the partial eraser across a box cover's edge removes it whole, never as outline strokes", async () => {
    eraserSettings("partial");
    await load([box, visible]);
    s().eraser({ x: -50, y: 20 });
    s().endEraser();
    expect(ids()).toEqual(["far"]);
  });
});
