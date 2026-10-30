import { describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
import { contentOf, type ConnectorContent } from "../../model/content";
import { shapeElement, shapeFromDrag } from "../../shapes/geometry";
import { anchorPoint } from "../../connectors/anchors";

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

import { useEditorStore } from "../editor";
import { useNotebookStore } from "../notebook";
import { useSettingsStore } from "../settings";

const STAMP = "2026-01-01T00:00:00.000Z";
const style = { shapeType: "rectangle" as const, color: "#000000", fillColor: "transparent", width: 2, fillOpacity: 1 };
const rect = (id: string, x: number, y: number): Element =>
  shapeElement(style, shapeFromDrag("rectangle", { x, y }, { x: x + 100, y: y + 100 }, false), "pg", id, STAMP);

const s = () => useEditorStore.getState();
const route = (id: string) => contentOf<ConnectorContent>(s().elements.get(id)!).route!;
const content = (id: string) => contentOf<ConnectorContent>(s().elements.get(id)!);

async function setup(): Promise<string> {
  loaded.els = [rect("a", 0, 0), rect("b", 400, 0)];
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  const id = s().addConnector({
    start: { x: 100, y: 50 },
    end: { x: 400, y: 50 },
    source: { id: "a", side: "auto" },
    target: { id: "b", side: "auto" },
    mode: "straight",
  });
  expect(id).not.toBeNull();
  return id!;
}

describe("connector store", () => {
  it("adds_a_routed_connector_on_the_facing_anchors", async () => {
    const id = await setup();
    const el = s().elements.get(id)!;
    expect(el.type).toBe("connector");
    expect(route(id)[0]).toEqual(anchorPoint(s().elements.get("a")!, "right"));
    expect(route(id)[route(id).length - 1]).toEqual(anchorPoint(s().elements.get("b")!, "left"));
    expect(el.points.map((p) => ({ x: p.x, y: p.y }))).toEqual([route(id)[0], route(id)[route(id).length - 1]]);
  });

  it("undo_restores_route", async () => {
    const id = await setup();
    const before = s().elements.get(id)!;
    s().select(["b"]);
    s().moveSelection(0, 200);
    // The connector followed in the same entry.
    const end = route(id)[route(id).length - 1];
    expect(end.y).toBeGreaterThan(200);
    expect(s().elements.get(id)!.points[1].y).toBe(end.y);
    s().undo();
    expect(s().elements.get(id)).toEqual(before);
    expect(s().elements.get("b")!.points[0].y).toBe(0);
    expect(s().canUndo).toBe(true); // the add entry is still there, the move was one entry
    s().redo();
    expect(route(id)[route(id).length - 1].y).toBeGreaterThan(200);
  });

  it("delete_frees_end", async () => {
    const id = await setup();
    const last = s().elements.get(id)!.points[1];
    s().removeElements(["b"]);
    expect(s().elements.has("b")).toBe(false);
    expect(content(id).target).toBeUndefined();
    expect(content(id).source).toEqual({ id: "a", side: "auto" });
    expect(s().elements.get(id)!.points[1]).toMatchObject({ x: last.x, y: last.y });
    s().undo();
    expect(s().elements.has("b")).toBe(true);
    expect(content(id).target).toEqual({ id: "b", side: "auto" });
  });

  it("both_ends_selected_move_translates_the_route", async () => {
    const id = await setup();
    const was = route(id);
    s().select(["a", "b", id]);
    s().moveSelection(30, 70);
    expect(route(id)).toEqual(was.map((p) => ({ x: p.x + 30, y: p.y + 70 })));
  });

  it("selected_connector_with_a_free_end_moves_that_end_only", async () => {
    loaded.els = [rect("a", 0, 0)];
    await s().loadPage("pg");
    const id = s().addConnector({ start: { x: 100, y: 50 }, end: { x: 300, y: 300 }, source: { id: "a", side: "right" }, mode: "straight" })!;
    s().select([id]);
    s().moveSelection(10, 10);
    expect(route(id)).toEqual([
      { x: 100, y: 50 },
      { x: 310, y: 310 },
    ]);
  });

  it("sets_ends_props_and_labels_as_undoable_entries", async () => {
    const id = await setup();
    expect(s().setConnectorEnd(id, "target", null, { x: 600, y: 300 })).toBe(true);
    expect(content(id).target).toBeUndefined();
    expect(route(id)[1]).toEqual({ x: 600, y: 300 });
    expect(s().setConnectorProps(id, { mode: "elbow", dash: "dashed", width: 4 })).toBe(true);
    expect(content(id).mode).toBe("elbow");
    expect(content(id).dash).toBe("dashed");
    expect(s().elements.get(id)!.width).toBe(4);
    expect(route(id).length).toBeGreaterThan(2);
    expect(s().setConnectorLabel(id, { text: " yes ", t: 0.3 })).toBe(true);
    expect(content(id).label).toEqual({ text: "yes", t: 0.3 });
    expect(s().setConnectorLabel(id, null)).toBe(true);
    expect(content(id).label).toBeUndefined();
    s().undo();
    s().undo();
    s().undo();
    s().undo();
    expect(content(id).target).toEqual({ id: "b", side: "auto" });
    expect(content(id).mode).toBe("straight");
  });

  it("paste_rebinds_copies_to_copied_elements", async () => {
    const id = await setup();
    s().select(["a", id]);
    s().duplicateSelection();
    const copies = [...s().selection].map((x) => s().elements.get(x)!);
    const conn = copies.find((e) => e.type === "connector")!;
    const shape = copies.find((e) => e.type === "shape")!;
    const c = contentOf<ConnectorContent>(conn);
    expect(c.source?.id).toBe(shape.id);
    expect(c.target).toBeUndefined();
  });
});

describe("eraser and connectors", () => {
  const eraseAt = (x: number, y: number, eraseShapes = true) => {
    useSettingsStore.setState((st) => ({ settings: { ...st.settings, defaultEraserType: "stroke", defaultEraserWidth: 20, eraserEraseShapes: eraseShapes } }));
    useEditorStore.setState({ camera: { x: 0, y: 0, z: 1 } });
    s().eraser({ x, y });
    s().endEraser();
  };

  it("erasing_a_bound_shape_frees_the_connector_end_in_the_same_entry", async () => {
    const id = await setup();
    const start = route(id)[0];
    eraseAt(0, 50); // left edge of a
    expect(s().elements.has("a")).toBe(false);
    expect(content(id).source).toBeUndefined();
    expect(content(id).target).toEqual({ id: "b", side: "auto" });
    expect(route(id)[0]).toEqual(start);
    s().undo(); // one "Erase" entry restores both
    expect(s().elements.has("a")).toBe(true);
    expect(content(id).source).toEqual({ id: "a", side: "auto" });
  });

  it("connectors_are_erased_along_their_route_like_shapes", async () => {
    const id = await setup();
    eraseAt(250, 50, false);
    expect(s().elements.has(id)).toBe(true); // eraserEraseShapes off
    eraseAt(250, 50);
    expect(s().elements.has(id)).toBe(false);
    expect(s().elements.has("a")).toBe(true);
    expect(s().elements.has("b")).toBe(true);
    s().undo();
    expect(s().elements.has(id)).toBe(true);
  });
});
