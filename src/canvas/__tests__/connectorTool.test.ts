import { afterEach, describe, expect, it, vi } from "vitest";
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

import { DEFAULT_SETTINGS } from "../../model/constants";
import { contentOf, type ConnectorContent } from "../../model/content";
import { anchorPoint } from "../../connectors/anchors";
import { connectorRoute, labelPill } from "../../connectors/geometry";
import { pointAt } from "../../connectors/route";
import { shapeElement, shapeFromDrag } from "../../shapes/geometry";
import { useEditorStore } from "../../stores/editor";
import { closeLabelPopover, useLabelPopoverStore } from "../../stores/labelPopover";
import { useNotebookStore } from "../../stores/notebook";
import { createToolController } from "../toolInteractions";

const STAMP = "2026-01-01T00:00:00.000Z";
const style = { shapeType: "rectangle" as const, color: "#000000", fillColor: "transparent", width: 2, fillOpacity: 1 };
const rect = (id: string, x: number, y: number): Element =>
  shapeElement(style, shapeFromDrag("rectangle", { x, y }, { x: x + 100, y: y + 100 }, false), "pg", id, STAMP);

const s = () => useEditorStore.getState();
const connectors = () => [...s().elements.values()].filter((e) => e.type === "connector");
const content = (el: Element) => contentOf<ConnectorContent>(el);

let now = 0;
function controller(settings: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const host = document.createElement("div");
  const rendered: Element[] = [];
  const tools = createToolController({
    store: useEditorStore,
    el: host,
    requestLive: () => {},
    invalidate: () => {},
    renderElement: (_ctx, e) => rendered.push(e),
    getSettings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
    now: () => now,
  });
  return { tools, rendered };
}

/** A canvas context that records the calls the live layer makes. */
function recorder() {
  const calls: string[] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (..._args: unknown[]) => {
        calls.push(k);
        return { width: 10 };
      };
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const cam = { x: 0, y: 0, z: 1 };

async function ready(tool: "connector" | "cursor" = "connector") {
  loaded.els = [rect("a", 0, 0), rect("b", 400, 0)];
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  useEditorStore.setState({ viewport: { width: 1000, height: 800 }, camera: cam });
  s().setTool(tool);
}

describe("connector tool", () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
    closeLabelPopover();
    now = 0;
  });

  it("drag_from_a_shape_into_another_binds_both_ends", async () => {
    await ready();
    const { tools, rendered } = controller({ defaultConnectorMode: "elbow", defaultConnectorColor: "#C62828", defaultConnectorWidth: 3, defaultConnectorDash: "dashed" });
    dispose = tools.dispose;
    tools.down({ x: 50, y: 50 }, "connector");
    tools.move([{ x: 450, y: 60 }]);
    const { ctx } = recorder();
    tools.draw(ctx, cam, 1);
    expect(rendered.at(-1)).toMatchObject({ type: "connector" }); // live preview
    expect(connectors()).toHaveLength(0);
    tools.up();
    const els = connectors();
    expect(els).toHaveLength(1);
    const c = content(els[0]);
    expect(c.source).toEqual({ id: "a", side: "auto" });
    expect(c.target).toEqual({ id: "b", side: "auto" });
    expect(c.mode).toBe("elbow");
    expect(c.dash).toBe("dashed");
    expect(els[0]).toMatchObject({ color: "#C62828", width: 3 });
    expect(s().tool).toBe("connector"); // the tool stays active
  });

  it("near_an_anchor_binds_that_side", async () => {
    await ready();
    const { tools } = controller();
    dispose = tools.dispose;
    // a's bottom anchor is (50, 100); b's top anchor is (450, 0).
    tools.down({ x: 52, y: 96 }, "connector");
    tools.move([{ x: 446, y: 4 }]);
    tools.up();
    const c = content(connectors()[0]);
    expect(c.source).toEqual({ id: "a", side: "bottom" });
    expect(c.target).toEqual({ id: "b", side: "top" });
    expect(connectors()[0].points[1]).toMatchObject(anchorPoint(s().elements.get("b")!, "top"));
  });

  it("release_in_empty_space_leaves_a_free_target", async () => {
    await ready();
    const { tools } = controller();
    dispose = tools.dispose;
    tools.down({ x: 50, y: 50 }, "connector");
    tools.move([{ x: 300, y: 400 }]);
    tools.up();
    const el = connectors()[0];
    expect(content(el).source?.id).toBe("a");
    expect(content(el).target).toBeUndefined();
    expect(el.points[1]).toMatchObject({ x: 300, y: 400 });
  });

  it("a_short_drag_adds_nothing_and_escape_cancels", async () => {
    await ready();
    const { tools } = controller();
    dispose = tools.dispose;
    tools.down({ x: 200, y: 300 }, "connector");
    tools.move([{ x: 201, y: 301 }]);
    tools.up();
    expect(connectors()).toHaveLength(0);
    tools.down({ x: 200, y: 300 }, "connector");
    tools.move([{ x: 400, y: 400 }]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    tools.up();
    expect(connectors()).toHaveLength(0);
  });

  it("endpoint_handle_drag_rebinds_once_on_release", async () => {
    await ready("cursor");
    const id = s().addConnector({ start: { x: 100, y: 50 }, end: { x: 300, y: 400 }, source: { id: "a", side: "auto" }, mode: "straight" })!;
    s().select([id]);
    const { tools, rendered } = controller();
    dispose = tools.dispose;
    const before = s().elements.get(id)!;
    const end = before.points[1];
    // The handle is hit a few px off its centre.
    tools.down({ x: end.x + 6, y: end.y - 6 }, "cursor");
    tools.move([{ x: 440, y: 60 }]);
    const { ctx } = recorder();
    tools.draw(ctx, cam, 1);
    expect(rendered.some((e) => e.id === id && e.points[1].x !== end.x)).toBe(true); // preview
    expect(s().elements.get(id)).toBe(before); // nothing committed while dragging
    tools.up();
    expect(content(s().elements.get(id)!).target).toEqual({ id: "b", side: "auto" });
    s().undo();
    expect(content(s().elements.get(id)!).target).toBeUndefined();
  });

  it("endpoint_handle_dragged_to_empty_space_frees_the_end", async () => {
    await ready("cursor");
    const id = s().addConnector({ start: { x: 100, y: 50 }, end: { x: 400, y: 50 }, source: { id: "a", side: "auto" }, target: { id: "b", side: "auto" }, mode: "straight" })!;
    s().select([id]);
    const { tools } = controller();
    dispose = tools.dispose;
    const start = s().elements.get(id)!.points[0];
    tools.down({ x: start.x, y: start.y }, "cursor");
    tools.move([{ x: 200, y: 500 }]);
    tools.up();
    const el = s().elements.get(id)!;
    expect(content(el).source).toBeUndefined();
    expect(el.points[0]).toMatchObject({ x: 200, y: 500 });
    expect(content(el).target?.id).toBe("b");
  });

  it("a_lone_connector_shows_handles_not_the_bounds_box", async () => {
    await ready("cursor");
    const id = s().addConnector({ start: { x: 100, y: 50 }, end: { x: 300, y: 400 }, mode: "straight" })!;
    s().select([id]);
    const { tools } = controller();
    dispose = tools.dispose;
    const { ctx, calls } = recorder();
    tools.draw(ctx, cam, 1);
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(2); // two square handles, no ants box
    expect(calls).not.toContain("arc"); // no rotate handle
  });

  it("dragging_the_label_moves_it_along_the_route", async () => {
    await ready("cursor");
    const id = s().addConnector({ start: { x: 100, y: 300 }, end: { x: 500, y: 300 }, mode: "straight" })!;
    s().setConnectorLabel(id, { text: "yes", t: 0.5 });
    s().select([id]);
    const { tools } = controller();
    dispose = tools.dispose;
    const pill = labelPill(s().elements.get(id)!)!;
    tools.down(pill.centre, "cursor");
    tools.move([{ x: 200, y: 320 }]);
    tools.up();
    const el = s().elements.get(id)!;
    expect(content(el).label?.text).toBe("yes");
    expect(content(el).label?.t).toBeCloseTo(0.25, 5);
    expect(pointAt(connectorRoute(el), content(el).label!.t).x).toBeCloseTo(200, 5);
  });

  it("double_click_on_a_connector_opens_the_label_popover", async () => {
    await ready("cursor");
    const id = s().addConnector({ start: { x: 100, y: 300 }, end: { x: 500, y: 300 }, mode: "straight" })!;
    const { tools } = controller();
    dispose = tools.dispose;
    tools.down({ x: 300, y: 300 }, "cursor");
    tools.up();
    expect(useLabelPopoverStore.getState().target).toBeNull();
    now = 100;
    tools.down({ x: 301, y: 300 }, "cursor");
    tools.up();
    expect(useLabelPopoverStore.getState().target).toMatchObject({ id });
  });
});
