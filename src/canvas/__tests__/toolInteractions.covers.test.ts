// The cover tool's box shape: a drag adds one opaque cover rectangle through the shape gesture; a
// tap on a cover (any tool but the eraser, cursor and lasso) toggles its reveal.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
const ipc = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => ipc.els) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { isCover } from "../../covers/cover";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { coverTargetOf } from "../../covers/tap";
import { el } from "../../tools/__tests__/fixtures";
import { createReplayTap, createToolController, type MarkerTarget, type ReplayTapTarget } from "../toolInteractions";

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
  ipc.els = [];
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

describe("tap on a cover", () => {
  const cover = el("cv", [[0, 0], [100, 0]], { width: 28, penStyle: "cover" });
  const ON = { x: 50, y: 0 };
  let clock = 1_000;
  const now = () => clock;

  async function page() {
    ipc.els = [cover];
    useNotebookStore.setState({ loaded: true });
    await s().loadPage("pg");
    clock = 1_000;
  }
  /** The cover target with `open` spied on (it still toggles). */
  function covers(): MarkerTarget & { open: ReturnType<typeof vi.fn> } {
    const t = coverTargetOf(useEditorStore);
    return { isMarker: t.isMarker, open: vi.fn((id: string) => t.open(id)) };
  }

  it("a pen tap opens the cover once and is consumed", async () => {
    await page();
    const c = covers();
    const tap = createReplayTap(useEditorStore, undefined, now, undefined, c);
    expect(tap.down(ON, "pen")).toBe(true);
    clock += 100;
    expect(tap.up(ON)).toMatchObject({ id: "cv" });
    expect(c.open).toHaveBeenCalledTimes(1);
    expect(c.open).toHaveBeenCalledWith("cv");
    expect(s().revealed.has("cv")).toBe(true);
  });

  it("a press that moves 11 px or lasts 301 ms is not a tap", async () => {
    await page();
    const c = covers();
    const tap = createReplayTap(useEditorStore, undefined, now, undefined, c);
    tap.down(ON, "pen");
    expect(tap.move({ x: ON.x + 11, y: 0 })).toBe(false);
    expect(tap.up({ x: ON.x + 11, y: 0 })).toBeNull();
    tap.down(ON, "pen");
    clock += 301;
    expect(tap.up(ON)).toBeNull();
    expect(c.open).not.toHaveBeenCalled();
    expect(s().revealed.size).toBe(0);
  });

  it("the eraser, cursor and lasso never tap a cover", async () => {
    await page();
    const c = covers();
    const tap = createReplayTap(useEditorStore, undefined, now, undefined, c);
    for (const tool of ["eraser", "cursor", "lasso"] as const) expect(tap.down(ON, tool)).toBe(false);
    expect(c.open).not.toHaveBeenCalled();
  });

  it("other creating tools and the box cover tap it too", async () => {
    await page();
    const c = covers();
    const tap = createReplayTap(useEditorStore, undefined, now, undefined, c);
    for (const tool of ["text", "shape", "cover", "cover-box"] as const) {
      expect(tap.down(ON, tool)).toBe(true);
      expect(tap.up(ON)).not.toBeNull();
    }
    expect(c.open).toHaveBeenCalledTimes(4);
  });

  it("with a replay open and the cover written during the recording, the tap toggles and does not seek", async () => {
    await page();
    const c = covers();
    const replay: ReplayTapTarget = { isOpen: () => true, canSeek: () => true, seekToElement: vi.fn(() => true) };
    const tap = createReplayTap(useEditorStore, replay, now, undefined, c);
    expect(tap.down(ON, "pen")).toBe(true);
    expect(tap.up(ON)).not.toBeNull();
    expect(s().revealed.has("cv")).toBe(true);
    expect(replay.seekToElement).not.toHaveBeenCalled();
  });

  it("the tool controller passes its covers to the tap: a shape-tool tap toggles and adds nothing", async () => {
    await page();
    s().setTool("shape");
    const tools = createToolController({
      store: useEditorStore,
      el: document.createElement("div"),
      requestLive: () => {},
      invalidate: () => {},
      renderElement: () => {},
      getSettings: () => DEFAULT_SETTINGS,
      covers: coverTargetOf(useEditorStore),
    });
    tools.down(ON, "shape");
    tools.up(ON);
    tools.dispose();
    expect(s().revealed.has("cv")).toBe(true);
    expect(s().elements.size).toBe(1);
  });
});
