// The cover tool on the mounted canvas: it never takes part in tutor gestures or scribble-to-erase,
// and ink written across a cover never lands above it on the cached page bitmap.
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const ipc = vi.hoisted(() => ({ els: [] as Element[] }));
/** Element ids in the order the static raster drew them (one inner list per full raster). */
const rasters = vi.hoisted(() => [] as string[][]);
const tutorDown = vi.hoisted(() => vi.fn());
/** Whether the mocked scribble detector calls every stroke a scribble. */
const scribbling = vi.hoisted(() => ({ on: false }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => ipc.els), unitElementTimes: vi.fn(async () => []) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../renderers/registry", async (orig) => {
  const m = await orig<typeof import("../../renderers/registry")>();
  return {
    ...m,
    drawElement: (ctx: CanvasRenderingContext2D, el: Element, o: Parameters<typeof m.drawElement>[2]) => {
      (rasters[rasters.length - 1] ??= []).push(el.id);
      m.drawElement(ctx, el, o);
    },
  };
});
vi.mock("../tutorInk", async (orig) => {
  const m = await orig<typeof import("../tutorInk")>();
  return {
    ...m,
    createTutorInk: (o: Parameters<typeof m.createTutorInk>[0]) => {
      const t = m.createTutorInk(o);
      return { ...t, gestures: { ...t.gestures, inkDown: (...a: Parameters<typeof t.gestures.inkDown>) => (tutorDown(), t.gestures.inkDown(...a)) } };
    },
  };
});
vi.mock("../../ink/scribble", async (orig) => {
  const m = await orig<typeof import("../../ink/scribble")>();
  // With `scribbling.on`, every stroke "is" a scribble over the ink "under".
  return {
    ...m,
    isScribbleGesture: () => ({ scribble: scribbling.on, bbox: { x: 0, y: 0, width: 1, height: 1 } }),
    scribbleHits: () => ["under"],
  };
});

import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { el } from "../../tools/__tests__/fixtures";
import { worldToScreen } from "../camera";
import CanvasView from "../CanvasView";
function fakeCtx() {
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 };
  const noop = () => ({ addColorStop() {} });
  return new Proxy(state, {
    get: (t, k) => (k in t ? t[k] : k === "measureText" ? (s: string) => ({ width: String(s).length * 7 }) : noop),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
}

const under = el("under", [[10, 10], [200, 10]], { width: 4 });
const cover = el("cv", [[100, 100], [220, 100]], { width: 28, penStyle: "cover", color: "#334155" });

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

const frame = () => act(async () => void (await new Promise((r) => setTimeout(r, 40))));

/** A short pen drag from `a` to `b` (world points). */
function drag(a: { x: number; y: number }, b: { x: number; y: number }) {
  const s = worldToScreen(store.getState().camera, a);
  const e = worldToScreen(store.getState().camera, b);
  const base = { pointerId: 7, pointerType: "pen", bubbles: true, cancelable: true, pressure: 0.5, button: 0 };
  host.dispatchEvent(new PointerEvent("pointerdown", { ...base, clientX: s.x, clientY: s.y, buttons: 1 }));
  for (let i = 1; i <= 12; i++) {
    const f = i / 12;
    host.dispatchEvent(new PointerEvent("pointermove", { ...base, clientX: s.x + (e.x - s.x) * f, clientY: s.y + (e.y - s.y) * f, buttons: 1 }));
  }
  host.dispatchEvent(new PointerEvent("pointerup", { ...base, clientX: e.x, clientY: e.y, buttons: 0 }));
}

beforeEach(() => {
  rasters.length = 0;
  tutorDown.mockClear();
  scribbling.on = false;
  ipc.els = [under, cover];
  HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as unknown as HTMLCanvasElement["getContext"];
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("the cover tool on the canvas", () => {
  it("drawing with the cover preset never starts a tutor stroke and never scribble-erases", async () => {
    await mount();
    scribbling.on = true;
    store.getState().selectInk("cover");
    drag({ x: 300, y: 300 }, { x: 360, y: 340 });
    expect(tutorDown).not.toHaveBeenCalled();
    expect(store.getState().elements.has("under")).toBe(true);
    expect(store.getState().elements.size).toBe(3);
    const drawn = [...store.getState().elements.values()].find((e) => e.id !== "under" && e.id !== "cv");
    expect(drawn?.penStyle).toBe("cover");
  });

  it("the pen still takes part in both (control)", async () => {
    await mount();
    scribbling.on = true;
    store.getState().selectInk("pen");
    drag({ x: 300, y: 300 }, { x: 360, y: 340 });
    expect(tutorDown).toHaveBeenCalled();
    expect(store.getState().elements.has("under")).toBe(false);
  });

  it("with perfect shapes on, a cover stroke stays a stroke while pen ink snaps", async () => {
    await mount();
    if (!store.getState().autoShapes) store.getState().toggleAutoShapes();
    store.getState().selectInk("pen");
    drag({ x: 300, y: 300 }, { x: 500, y: 300 });
    const kinds = () => [...store.getState().elements.values()].filter((e) => e.id !== "under" && e.id !== "cv").map((e) => e.type);
    expect(kinds()).toEqual(["shape"]); // control: the pen's straight drag became a line
    store.getState().selectInk("cover");
    drag({ x: 300, y: 400 }, { x: 500, y: 400 });
    expect(kinds()).toEqual(["shape", "stroke"]);
  });

  it("pen ink committed across a cover is drawn below it, not appended on top", async () => {
    await mount();
    store.getState().selectInk("pen");
    await frame();
    rasters.length = 0;
    rasters.push([]);
    drag({ x: 90, y: 100 }, { x: 230, y: 100 });
    await frame();
    // The new stroke is on the page, and the next raster put the cover after it.
    const ids = [...store.getState().elements.keys()];
    const inkId = ids.find((i) => i !== "under" && i !== "cv")!;
    const last = rasters[rasters.length - 1];
    expect(last.indexOf("cv")).toBeGreaterThan(last.indexOf(inkId));
    expect(last).toContain("cv");
  });

  it("pen ink away from every cover is still appended without a full raster", async () => {
    await mount();
    store.getState().selectInk("pen");
    await frame();
    rasters.length = 0;
    rasters.push([]);
    drag({ x: 300, y: 300 }, { x: 360, y: 340 });
    await frame();
    expect(rasters.flat()).not.toContain("cv");
  });

  it("with the box shape a drag adds a cover box that the next raster draws above the ink under it", async () => {
    await mount();
    store.getState().selectInk("cover");
    store.getState().updatePreset({ ...store.getState().preset, coverShape: "box" });
    await frame();
    rasters.length = 0;
    rasters.push([]);
    drag({ x: 0, y: 0 }, { x: 150, y: 60 });
    await frame();
    const box = [...store.getState().elements.values()].find((e) => e.id !== "under" && e.id !== "cv");
    expect(box).toMatchObject({ type: "shape", content: { cover: true } });
    expect(store.getState().elements.size).toBe(3);
    // A shape goes through the store, not commit(): the whole page is re-rastered, covers last.
    const last = rasters[rasters.length - 1];
    expect(last.indexOf(box!.id)).toBeGreaterThan(last.indexOf("under"));
  });
});
