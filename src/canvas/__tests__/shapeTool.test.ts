import { afterEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {}),
  pending: () => 0,
  failed: () => 0,
}));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => [] as Element[]) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { DEFAULT_SHORTCUTS, matchShortcut } from "../../keys/shortcuts";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { createToolController } from "../toolInteractions";

function controller() {
  const host = document.createElement("div");
  const rendered: Element[] = [];
  const tools = createToolController({
    store: useEditorStore,
    el: host,
    requestLive: () => {},
    invalidate: () => {},
    renderElement: (_ctx, e) => rendered.push(e),
    getSettings: () => ({ ...DEFAULT_SETTINGS, defaultShapeType: "ellipse", defaultShapeFillColor: "#1565C0", defaultShapeFillOpacity: 0.4 }),
  });
  return { tools, rendered };
}

const ctx = { setTransform: () => {}, save: () => {}, restore: () => {} } as unknown as CanvasRenderingContext2D;
const cam = { x: 0, y: 0, z: 1 };

async function ready() {
  useNotebookStore.setState({ loaded: true });
  await useEditorStore.getState().loadPage("pg");
  useEditorStore.getState().setTool("shape");
}

describe("shape tool", () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", shiftKey: false }));
  });

  it("drag_previews_then_adds_one_shape", async () => {
    await ready();
    const { tools, rendered } = controller();
    dispose = tools.dispose;
    tools.down({ x: 10, y: 10 }, "shape");
    tools.move([{ x: 50, y: 30 }]);
    tools.draw(ctx, cam, 1);
    expect(rendered.at(-1)).toMatchObject({ type: "shape", shapeType: "ellipse", fillColor: "#1565C0", boxWidth: 40, boxHeight: 20 });
    expect(useEditorStore.getState().elements.size).toBe(0);
    tools.up();
    const els = [...useEditorStore.getState().elements.values()];
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ type: "shape", shapeType: "ellipse", content: { fillOpacity: 0.4 } });
    rendered.length = 0;
    tools.draw(ctx, cam, 1);
    expect(rendered).toEqual([]); // preview cleared
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().elements.size).toBe(0);
  });

  it("shift_constrains_and_a_click_adds_nothing", async () => {
    await ready();
    const { tools } = controller();
    dispose = tools.dispose;
    tools.down({ x: 0, y: 0 }, "shape");
    tools.up();
    expect(useEditorStore.getState().elements.size).toBe(0);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }));
    tools.down({ x: 0, y: 0 }, "shape");
    tools.move([{ x: 80, y: 20 }]);
    tools.up();
    const [shape] = [...useEditorStore.getState().elements.values()];
    expect([shape.boxWidth, shape.boxHeight]).toEqual([80, 80]);
  });

  it("s_selects_the_shape_tool", () => {
    const e = new KeyboardEvent("keydown", { key: "s" });
    expect(matchShortcut(DEFAULT_SHORTCUTS, e, false)?.action).toBe("tool.shape");
  });
});
