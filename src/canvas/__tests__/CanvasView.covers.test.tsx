// Tap to peek on the mounted canvas: a tap on a cover toggles its reveal and draws nothing, a
// panning finger's tap toggles it too (and is never half of a double-tap zoom), and a revealed cover
// is drawn at 25 % on the static layer.
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element, Settings } from "../../model/types";

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

import { DEFAULT_SETTINGS } from "../../model/constants";
import { recordingElement } from "../../recording/marker";
import { createReplay } from "../../recording/replay";
import type { RecordingContent } from "../../recording/types";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
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

const T0 = Date.parse("2026-11-14T09:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const rec: RecordingContent = {
  unitId: "u1",
  spans: [{ wallStart: iso(0), audioStartMs: 0, durationMs: 600_000 }],
  segments: [{ assetId: "a1", durationMs: 600_000, mime: "audio/webm" }],
};
const marker = recordingElement("pg", "rec", iso(0), { x: 600, y: 600 }, rec, "Lecture");
// The cover was written during the recording, so a replay could also seek to it.
const cover = el("cv", [[100, 100], [220, 100]], { width: 28, penStyle: "cover", color: "#334155", createdAt: iso(60_000) });
const ink = el("ink", [[100, 300], [220, 300]], { width: 4 });
const ON_COVER = { x: 160, y: 100 };

let store: EditorStore;
let host: HTMLElement;
const s = () => store.getState();
const setSettings = (patch: Partial<Settings>) => useSettingsStore.setState((st) => ({ settings: { ...st.settings, ...patch } }));
/** Fingers pan and a double tap zooms; without requestAnimationFrame the zoom lands at once. */
function fingersPan() {
  setSettings({ fingerAction: "pan", palmRejection: "off", doubleTapZoom: true });
  vi.stubGlobal("requestAnimationFrame", undefined);
}

async function mount() {
  useNotebookStore.setState({ loaded: true });
  store = createEditorStore();
  const view = render(createElement(CanvasView, { pageId: "pg", store }));
  host = view.container.querySelector(".canvas-live")!;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(s().loadedPageId).toBe("pg");
  s().setViewport({ width: 800, height: 600 }); // jsdom lays nothing out; the camera clamps to a real view
}

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const frame = () => wait(40);

/** A quick press and release at world `p`. */
function tap(p: { x: number; y: number }, pointerType = "pen", pointerId = 7) {
  const sc = worldToScreen(s().camera, p);
  const base = { pointerId, pointerType, bubbles: true, cancelable: true, pressure: 0.5, clientX: sc.x, clientY: sc.y, button: 0, width: 10, height: 10 };
  host.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1 }));
  host.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
}

beforeEach(() => {
  drawn.length = 0;
  ipc.els = [cover, ink];
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as unknown as HTMLCanvasElement["getContext"];
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  document.body.innerHTML = "";
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe("tap to peek on the canvas", () => {
  it("a pen tap on a cover toggles it and leaves no dot", async () => {
    await mount();
    s().selectInk("pen");
    tap(ON_COVER);
    expect(s().revealed.has("cv")).toBe(true);
    expect(s().elements.size).toBe(2);
    tap(ON_COVER);
    expect(s().revealed.has("cv")).toBe(false);
    expect(s().elements.size).toBe(2);
  });

  it("the stroke cover tool tapping a cover toggles it instead of stacking a dot", async () => {
    await mount();
    s().selectInk("cover");
    tap(ON_COVER);
    expect(s().revealed.has("cv")).toBe(true);
    expect(s().elements.size).toBe(2);
  });

  it("the box cover tool tapping a cover toggles it", async () => {
    await mount();
    s().selectInk("cover");
    s().updatePreset({ ...s().preset, coverShape: "box" });
    tap(ON_COVER, "mouse");
    expect(s().revealed.has("cv")).toBe(true);
    expect(s().elements.size).toBe(2);
  });

  it("a cursor tap on a cover selects it instead of toggling", async () => {
    await mount();
    s().setTool("cursor");
    tap(ON_COVER, "mouse");
    expect(s().revealed.size).toBe(0);
    expect(s().selection).toEqual(new Set(["cv"]));
  });

  it("with a replay open, a tap on a cover written during the recording toggles it and does not seek", async () => {
    ipc.els = [marker, cover, ink];
    await mount();
    const audio = Object.assign(new EventTarget(), { play: vi.fn(async () => {}), pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(), src: "", currentTime: 0, playbackRate: 1 });
    const replay = createReplay({ audio: audio as unknown as HTMLAudioElement, urlOf: async (id) => `url:${id}`, goToPage: vi.fn() });
    await replay.getState().open(store, "rec");
    const seek = vi.spyOn(replay.getState(), "seekToElement");
    tap(ON_COVER);
    expect(s().revealed.has("cv")).toBe(true);
    expect(seek).not.toHaveBeenCalled();
    act(() => replay.getState().close());
  });

  it("a panning finger's tap on a cover toggles it and is not the first tap of a double-tap zoom", async () => {
    fingersPan();
    await mount();
    const cam = s().camera;
    tap(ON_COVER, "touch", 1);
    expect(s().revealed.has("cv")).toBe(true);
    // A second quick tap just beside it, on paper: it would complete a double tap after a paper tap.
    tap({ x: ON_COVER.x + 20, y: ON_COVER.y + 30 }, "touch", 2);
    await frame();
    expect(s().camera).toEqual(cam);
    expect(s().elements.size).toBe(2);
  });

  it("two taps of a panning finger on paper still zoom (control)", async () => {
    fingersPan();
    await mount();
    const cam = s().camera;
    tap({ x: 400, y: 400 }, "touch", 1);
    tap({ x: 400, y: 400 }, "touch", 2);
    await frame();
    expect(s().camera).not.toEqual(cam);
  });

  it("a revealed cover is drawn at 25 % and a change of revealed repaints the static layer", async () => {
    await mount();
    await frame();
    drawn.length = 0;
    s().toggleReveal("cv");
    await frame();
    expect(drawn).toContainEqual(["cv", 0.25]);
    expect(drawn).toContainEqual(["ink", 1]);
    drawn.length = 0;
    s().toggleReveal("cv");
    await frame();
    expect(drawn).toContainEqual(["cv", 1]);
    expect(drawn).not.toContainEqual(["cv", 0.25]);
  });

  it("a revealed cover in a replay-dimmed state is drawn once at 25 %, not 6.25 %", async () => {
    await mount();
    s().toggleReveal("cv");
    s().setReplayDim(new Set(["cv"]));
    await frame();
    drawn.length = 0;
    s().setReplayDim(new Set(["cv", "ink"]));
    await frame();
    expect(drawn).toContainEqual(["cv", 0.25]);
    expect(drawn).not.toContainEqual(["cv", 0.0625]);
  });
});
