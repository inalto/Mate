// Pressing a recording marker on the mounted canvas: a pen or text tap opens the pane's replay and
// draws nothing; with the cursor the first press selects and a press on the selected marker (or a
// double-click) opens it; the eraser and lasso keep their behaviour.
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const ipc = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => ipc.els), unitElementTimes: vi.fn(async () => []) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { recordingElement } from "../../recording/marker";
import { attachReplay } from "../../recording/panes";
import { createReplay, type ReplayState } from "../../recording/replay";
import type { RecordingContent } from "../../recording/types";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { worldToScreen } from "../camera";
import CanvasView from "../CanvasView";
import type { StoreApi } from "zustand";

/** A 2D context stand-in whose every method is a no-op. */
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
const marker = recordingElement("pg", "rec", iso(700_000), { x: 300, y: 300 }, rec, "Lecture");
const ON_MARKER = { x: 322, y: 322 };

let store: EditorStore;
let host: HTMLElement;
let replay: StoreApi<ReplayState>;
let detach: () => void;

async function mount() {
  useNotebookStore.setState({ loaded: true });
  store = createEditorStore();
  const audio = Object.assign(new EventTarget(), { play: vi.fn(async () => {}), pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(), src: "", currentTime: 0, playbackRate: 1 });
  replay = createReplay({ audio: audio as unknown as HTMLAudioElement, urlOf: async (id) => `url:${id}`, goToPage: vi.fn() });
  detach = attachReplay(store, replay);
  const view = render(createElement(CanvasView, { pageId: "pg", store }));
  host = view.container.querySelector(".canvas-live")!;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(store.getState().loadedPageId).toBe("pg");
}

/** A press at world `p` released `dx` screen px to the right (pen draws with the pen tool, mouse with the others). */
function press(p: { x: number; y: number }, pointerType = "pen", dx = 0) {
  const s = worldToScreen(store.getState().camera, p);
  const base = { pointerId: 7, pointerType, bubbles: true, cancelable: true, pressure: 0.5, clientX: s.x, clientY: s.y, button: 0 };
  host.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1 }));
  if (dx) host.dispatchEvent(new PointerEvent("pointermove", { ...base, clientX: s.x + dx, buttons: 1 }));
  host.dispatchEvent(new PointerEvent("pointerup", { ...base, clientX: s.x + dx, buttons: 0 }));
}

beforeEach(() => {
  ipc.els = [marker];
  HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as unknown as HTMLCanvasElement["getContext"];
});
afterEach(() => {
  act(() => replay.getState().close());
  detach();
  cleanup();
  document.body.innerHTML = "";
});

describe("markerPress", () => {
  it("pen tap opens", async () => {
    await mount();
    press(ON_MARKER);
    expect(replay.getState().markerId).toBe("rec");
    expect([...store.getState().elements.keys()]).toEqual(["rec"]);
  });

  it("a pen drag that starts on the marker draws", async () => {
    await mount();
    press(ON_MARKER, "pen", 40);
    expect(replay.getState().markerId).toBeNull();
    expect(store.getState().elements.size).toBe(2);
  });

  it("a text tool tap opens without adding a text box", async () => {
    await mount();
    store.getState().setTool("text");
    press(ON_MARKER, "mouse");
    expect(replay.getState().markerId).toBe("rec");
    expect(store.getState().elements.size).toBe(1);
  });

  it("cursor press selects then opens", async () => {
    await mount();
    store.getState().setTool("cursor");
    press(ON_MARKER, "mouse");
    expect(store.getState().selection).toEqual(new Set(["rec"]));
    expect(replay.getState().markerId).toBeNull();
    press(ON_MARKER, "mouse");
    expect(replay.getState().markerId).toBe("rec");
    expect(store.getState().editingId).toBeNull();
  });

  it("a cursor click on the already selected marker opens it", async () => {
    await mount();
    store.getState().setTool("cursor");
    store.getState().select(["rec"]);
    press(ON_MARKER, "mouse");
    expect(replay.getState().markerId).toBe("rec");
  });

  it("cursor drag on the selected marker moves it without opening", async () => {
    await mount();
    store.getState().setTool("cursor");
    store.getState().select(["rec"]);
    press(ON_MARKER, "mouse", 40);
    expect(replay.getState().markerId).toBeNull();
  });

  it("eraser does neither", async () => {
    await mount();
    store.getState().setTool("eraser");
    press(ON_MARKER, "mouse");
    expect(replay.getState().markerId).toBeNull();
    expect(store.getState().selection.size).toBe(0);
  });

  it("lasso keeps selecting", async () => {
    await mount();
    store.getState().setTool("lasso");
    press(ON_MARKER, "mouse");
    press(ON_MARKER, "mouse");
    expect(replay.getState().markerId).toBeNull();
  });
});
