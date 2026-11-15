// The cover tool's box shape: a drag adds one opaque cover rectangle through the shape gesture.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => [] as Element[]) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { isCover } from "../../covers/cover";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { createToolController } from "../toolInteractions";

function controller() {
  const rendered: Element[] = [];
  const tools = createToolController({
    store: useEditorStore,
    el: document.createElement("div"),
    requestLive: () => {},
    invalidate: () => {},
    renderElement: (_ctx, e) => rendered.push(e),
    getSettings: () => DEFAULT_SETTINGS,
  });
  return { tools, rendered };
}

const ctx = { setTransform: () => {}, save: () => {}, restore: () => {} } as unknown as CanvasRenderingContext2D;
const cam = { x: 0, y: 0, z: 1 };
const s = () => useEditorStore.getState();

async function ready() {
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  s().setTool("cover");
  s().setPreset({ id: "c", type: "cover", color: "#FDE047", width: 28, coverShape: "box" });
}

describe("cover box gesture", () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it("a drag previews, then adds one cover box in one history entry", async () => {
    await ready();
    const { tools, rendered } = controller();
    dispose = tools.dispose;
    tools.down({ x: 10, y: 10 }, "cover-box");
    tools.move([{ x: 130, y: 70 }]);
    tools.draw(ctx, cam, 1);
    expect(rendered.at(-1)).toMatchObject({ type: "shape", boxWidth: 120, boxHeight: 60 });
    expect(isCover(rendered.at(-1)!)).toBe(true);
    expect(s().elements.size).toBe(0);
    tools.up();
    const els = [...s().elements.values()];
    expect(els).toHaveLength(1);
    expect(isCover(els[0])).toBe(true);
    expect(els[0]).toMatchObject({ shapeType: "rectangle", color: "#FDE047", fillColor: "#FDE047", boxWidth: 120, boxHeight: 60 });
    expect(s().selection.size).toBe(0);
    s().undo();
    expect(s().elements.size).toBe(0);
  });

  it("a drag under the minimum adds nothing and selects nothing", async () => {
    await ready();
    const { tools } = controller();
    dispose = tools.dispose;
    tools.down({ x: 10, y: 10 }, "cover-box");
    tools.move([{ x: 12, y: 11 }]);
    tools.up();
    expect(s().elements.size).toBe(0);
    expect(s().selection.size).toBe(0);
  });

  it("in page mode the box is clamped to the sheet it starts on", async () => {
    await ready();
    const page = s().page!;
    useEditorStore.setState({ page: { ...page, mode: "page", pageWidth: 400, pageHeight: 500 } });
    const { tools } = controller();
    dispose = tools.dispose;
    tools.down({ x: 300, y: 100 }, "cover-box");
    tools.move([{ x: 900, y: 200 }]);
    tools.up();
    const [box] = [...s().elements.values()];
    expect(box.boxWidth).toBeLessThan(600);
    const [a, b] = box.points;
    expect(Math.max(a.x, b.x)).toBeLessThanOrEqual(400 + 1e-6);
  });
});
