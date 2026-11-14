// Replay on the mounted canvas: the static raster draws the replay's dimmed ids at 25 %, and a tap on
// an in-recording note seeks the audio instead of drawing or selecting.
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const ipc = vi.hoisted(() => ({ els: [] as Element[] }));
/** [element id, ctx.globalAlpha] for each drawElement call. */
const drawn = vi.hoisted(() => [] as [string, number][]);
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => ipc.els), unitElementTimes: vi.fn(async () => []) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../renderers/registry", async (orig) => {
  const m = await orig<typeof import("../../renderers/registry")>();
  return {
    ...m,
    drawElement: (ctx: CanvasRenderingContext2D, el: Element, o: Parameters<typeof m.drawElement>[2]) => {
      drawn.push([el.id, ctx.globalAlpha]);
      m.drawElement(ctx, el, o);
    },
  };
});

import { renderStroke } from "../../ink/render";
import { recordingElement } from "../../recording/marker";
import { createReplay, drawDimmed } from "../../recording/replay";
import type { RecordingContent } from "../../recording/types";
import { drawElement } from "../../renderers/registry";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { el } from "../../tools/__tests__/fixtures";
import { worldToScreen } from "../camera";
import CanvasView from "../CanvasView";

/** A 2D context stand-in: every method is a no-op except save/restore, fill and stroke (which log the alpha). */
function fakeCtx(log: [string, number][] = []) {
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 };
  const stack: number[] = [];
  const fns: Record<string, (...a: unknown[]) => unknown> = {
    save: () => stack.push(state.globalAlpha as number),
    restore: () => void (state.globalAlpha = stack.pop() ?? 1),
    fill: () => log.push(["fill", state.globalAlpha as number]),
    stroke: () => log.push(["stroke", state.globalAlpha as number]),
    measureText: (s) => ({ width: String(s).length * 7 }),
  };
  const noop = () => ({ addColorStop() {} });
  return new Proxy(state, {
    get: (t, k) => (k in t ? t[k] : (fns[k as string] ?? noop)),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
}

const T0 = Date.parse("2026-11-14T09:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const rec: RecordingContent = {
  unitId: "u1",
  spans: [{ wallStart: iso(0), audioStartMs: 0, durationMs: 600_000 }],
  segments: [{ assetId: "a1", durationMs: 600_000, mime: "video/webm" }],
};
const marker = recordingElement("pg", "rec", iso(0), { x: 300, y: 300 }, rec, "Lecture");
const x = el("x", [[10, 10]], { width: 4, createdAt: iso(60_000) }); // written during the recording
const y = el("y", [[60, 10]], { width: 4, createdAt: iso(-60_000) }); // before it
const tb = el("tb", [[100, 100]], {
  type: "text-box", boxWidth: 80, boxHeight: 40, penStyle: undefined, createdAt: iso(120_000),
  content: { contentHtml: "<p>hi</p>", rawContent: "hi" },
});

let store: EditorStore;
let host: HTMLElement;

async function mount() {
  useNotebookStore.setState({ loaded: true });
  store = createEditorStore();
  const view = render(createElement(CanvasView, { pageId: "pg", store }));
  host = view.container.querySelector(".canvas-live")!;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(store.getState().loadedPageId).toBe("pg");
}

/** Wait for the queued static frame (setTimeout fallback of requestAnimationFrame). */
const frame = () => act(async () => void (await new Promise((r) => setTimeout(r, 40))));

/** A quick tap at world point `p` with `pointerType` (pen draws with the pen tool, mouse with the cursor). */
function tap(p: { x: number; y: number }, pointerType = "pen", releaseDx = 0) {
  const s = worldToScreen(store.getState().camera, p);
  const base = { pointerId: 7, pointerType, bubbles: true, cancelable: true, pressure: 0.5, clientX: s.x, clientY: s.y, button: 0 };
  host.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1 }));
  host.dispatchEvent(new PointerEvent("pointerup", { ...base, clientX: s.x + releaseDx, buttons: 0 }));
}

async function openReplay() {
  const audio = Object.assign(new EventTarget(), { play: vi.fn(async () => {}), pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(), src: "", currentTime: 0, playbackRate: 1 });
  const replay = createReplay({ audio: audio as unknown as HTMLAudioElement, urlOf: async (id) => `url:${id}`, goToPage: vi.fn() });
  await replay.getState().open(store, "rec");
  const seek = vi.spyOn(replay.getState(), "seekToElement");
  return { replay, seek };
}

beforeEach(() => {
  drawn.length = 0;
  ipc.els = [marker, x, y];
  HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as unknown as HTMLCanvasElement["getContext"];
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("replay on the canvas", () => {
  it("draws the ids in replayDim at 25 % on the static raster", async () => {
    await mount();
    drawn.length = 0;
    store.getState().setReplayDim(new Set(["x"]));
    await frame();
    expect(drawn).toContainEqual(["x", 0.25]);
    expect(drawn).toContainEqual(["y", 1]);
    expect(drawn).not.toContainEqual(["y", 0.25]);
    drawn.length = 0;
    store.getState().setReplayDim(null);
    await frame();
    expect(drawn).toContainEqual(["x", 1]);
    expect(drawn).not.toContainEqual(["x", 0.25]);
  });

  it("dimming multiplies the renderers' own alpha (highlighter, filled shape)", () => {
    const log: [string, number][] = [];
    const ctx = fakeCtx(log) as unknown as CanvasRenderingContext2D;
    const hl = el("h", [[0, 0]], { penStyle: "highlighter", isHighlighter: true });
    drawDimmed(ctx, new Set(["h"]), "h", () => renderStroke(ctx, hl, "light", 1));
    expect(log).toEqual([["fill", 0.125]]);
    log.length = 0;
    const box = el("s", [[0, 0]], { type: "shape", shapeType: "rectangle", fillColor: "#ff0000", boxWidth: 40, boxHeight: 30 });
    drawDimmed(ctx, new Set(["s"]), "s", () => drawElement(ctx, box, { theme: "light", zoomBucket: 1 }));
    expect(log.find(([k]) => k === "stroke")?.[1]).toBe(0.25);
    const fill = log.find(([k]) => k === "fill")?.[1] ?? 1;
    expect(fill).toBeLessThanOrEqual(0.25);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("a pen tap on an in-recording element seeks and adds no stroke", async () => {
    await mount();
    const { replay, seek } = await openReplay();
    tap({ x: 10, y: 10 });
    expect(seek).toHaveBeenCalledWith("x");
    expect(replay.getState().positionMs).toBe(58_000);
    expect([...store.getState().elements.keys()].sort()).toEqual(["rec", "x", "y"]);
  });

  it("a pen double tap on an in-recording note never leaves a dot", async () => {
    await mount();
    const { seek } = await openReplay();
    tap({ x: 10, y: 10 });
    tap({ x: 10, y: 10 });
    expect(seek).toHaveBeenCalledTimes(2);
    expect([...store.getState().elements.keys()].sort()).toEqual(["rec", "x", "y"]);
  });

  it("a pen tap on empty paper still draws a dot", async () => {
    await mount();
    const { seek } = await openReplay();
    tap({ x: 200, y: 150 });
    expect(seek).not.toHaveBeenCalled();
    expect(store.getState().elements.size).toBe(4);
    // A tap on a note from before the recording also draws as usual.
    tap({ x: 60, y: 10 });
    expect(store.getState().elements.size).toBe(5);
  });

  it("a cursor tap on an in-recording element seeks without selecting", async () => {
    await mount();
    store.getState().setTool("cursor");
    const { seek } = await openReplay();
    tap({ x: 10, y: 10 }, "mouse");
    expect(seek).toHaveBeenCalledWith("x");
    expect(store.getState().selection.size).toBe(0);
    // A note from before the recording selects as usual.
    tap({ x: 60, y: 10 }, "mouse");
    expect(store.getState().selection).toEqual(new Set(["y"]));
  });

  it("a cursor release more than 10 px from the press is not a tap", async () => {
    await mount();
    store.getState().setTool("cursor");
    const { seek } = await openReplay();
    tap({ x: 10, y: 10 }, "mouse", 30);
    expect(seek).not.toHaveBeenCalled();
    expect(store.getState().selection).toEqual(new Set(["x"]));
  });

  it("a double click on an in-recording text box still opens it", async () => {
    ipc.els = [marker, x, y, tb];
    await mount();
    store.getState().setTool("cursor");
    const { seek } = await openReplay();
    tap({ x: 140, y: 120 }, "mouse");
    expect(seek).toHaveBeenCalledWith("tb");
    expect(store.getState().editingId).toBeNull();
    tap({ x: 140, y: 120 }, "mouse");
    expect(store.getState().editingId).toBe("tb");
    expect(seek).toHaveBeenCalledTimes(1);
  });
});
