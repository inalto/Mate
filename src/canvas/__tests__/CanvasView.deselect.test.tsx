// The live layer after the selection empties: its backing store is reset (not only cleared), so a
// frame that erases the selection handles and draws nothing else cannot be skipped by the browser
// (iPadOS left fragments of the handles on screen).
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const ipc = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => ipc.els), unitElementTimes: vi.fn(async () => []) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { el } from "../../tools/__tests__/fixtures";
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

const ink = el("ink", [[100, 100], [300, 200]], { width: 4 });

let store: EditorStore;
/** Times the live canvas's backing store was reset (its width assigned). */
let resets = 0;
const s = () => store.getState();
const frame = () => act(async () => void (await new Promise((r) => setTimeout(r, 40))));

async function mount() {
  useNotebookStore.setState({ loaded: true });
  store = createEditorStore();
  const view = render(createElement(CanvasView, { pageId: "pg", store }));
  const live = view.container.querySelector(".canvas-live") as HTMLCanvasElement;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(s().loadedPageId).toBe("pg");
  let width = live.width;
  Object.defineProperty(live, "width", {
    configurable: true,
    get: () => width,
    set: (v: number) => {
      width = v;
      resets++;
    },
  });
  await frame();
  resets = 0;
}

beforeEach(() => {
  ipc.els = [ink];
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as unknown as HTMLCanvasElement["getContext"];
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe("the live layer when the selection empties", () => {
  it("deselecting_resets_the_live_canvas_once", async () => {
    await mount();
    act(() => s().select(["ink"]));
    await frame();
    expect(resets).toBe(0); // selecting, and the marching ants, only clear and redraw

    act(() => s().select([]));
    await frame();
    expect(resets).toBe(1);

    // Later frames are ordinary ones again.
    act(() => s().setCamera({ ...s().camera, x: s().camera.x + 10 }));
    await frame();
    expect(resets).toBe(1);
  });

  it("changing_a_selection_that_stays_non_empty_resets_nothing", async () => {
    ipc.els = [ink, el("ink2", [[400, 100], [500, 200]], { width: 4 })];
    await mount();
    act(() => s().select(["ink"]));
    await frame();
    act(() => s().select(["ink2"]));
    await frame();
    expect(resets).toBe(0);
  });
});
