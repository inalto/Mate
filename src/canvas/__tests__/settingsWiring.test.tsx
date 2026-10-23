// Live-update tests for the input and canvas settings (Phase 5 task 2): each flips a setting in the
// settings store between two otherwise identical inputs and checks the behaviour changes. The
// engine reads these values at event time (CanvasView's adapter getters / onWheel / pointerTool).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { Settings } from "../../model/types";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import type { Camera } from "../camera";
import { applyWheel } from "../gestures";
import { createPointerAdapter, type PalmRejection, type PointerInfo } from "../input";
import { createToolController, pointerTool } from "../toolInteractions";
import ZoomIndicator from "../ZoomIndicator";

const cfg = () => useSettingsStore.getState().settings;
const set = (patch: Partial<Settings>) => useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...patch } }));

beforeEach(() => useSettingsStore.setState({ settings: DEFAULT_SETTINGS }));
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** A pointer adapter wired like CanvasView: options are getters over the settings store. */
function adapter() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const handlers = { onDown: vi.fn(), onMove: vi.fn(), onUp: vi.fn(), onCancel: vi.fn(), onPan: vi.fn(), onPanEnd: vi.fn() };
  const dispose = createPointerAdapter(el, handlers, {
    get palmRejection() {
      return cfg().palmRejection as PalmRejection;
    },
    get drawWithFinger() {
      return cfg().drawWithFinger;
    },
    get pinchToZoom() {
      return cfg().pinchToZoom;
    },
    getCamera: () => ({ x: 0, y: 0, z: 1 }),
  });
  const fire = (type: string, init: PointerEventInit) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }));
  return { el, handlers, dispose, fire };
}

const touch = (id: number, size: number, t: number) => ({ pointerId: id, pointerType: "touch", width: size, height: size, buttons: 1, clientX: 5, clientY: 5, timeStamp: t });

describe("input settings", () => {
  it("wheel_zooms_when_scroll_behavior_is_zoom", () => {
    const clamp = (c: Camera) => c;
    const c = { x: 0, y: 0, z: 1 };
    const mouseWheel = { deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false };
    const wheel = () => applyWheel(c, mouseWheel, { x: 50, y: 50 }, cfg().scrollBehavior, clamp);
    set({ scrollBehavior: "pan" });
    expect(wheel()).toEqual({ x: 0, y: -100, z: 1 });
    set({ scrollBehavior: "zoom" });
    expect(wheel().z).toBeCloseTo(Math.exp(-1), 10);
    // A trackpad-like wheel (small deltas, sideways component) still pans.
    expect(applyWheel(c, { ...mouseWheel, deltaY: 6, deltaX: 2 }, { x: 0, y: 0 }, cfg().scrollBehavior, clamp).z).toBe(1);
  });

  it("barrel_button_switches_to_eraser", () => {
    const pen: PointerInfo = { pointerType: "pen", buttons: 1 | 2, isBarrel: true, isEraserEnd: false };
    set({ penBarrelButtonAction: "none" });
    expect(pointerTool("pen", false, pen, cfg()).tool).toBe("none");
    set({ penBarrelButtonAction: "eraser" });
    expect(pointerTool("pen", false, pen, cfg())).toEqual({ tool: "eraser", temp: "eraser" });
    // Eraser end (pen, buttons bit 32) follows its own key.
    const end: PointerInfo = { pointerType: "pen", buttons: 32, isBarrel: false, isEraserEnd: true };
    set({ penEraserButtonAction: "lasso" });
    expect(pointerTool("pen", false, end, cfg()).tool).toBe("lasso");
  });

  it("finger_draws_only_when_enabled", () => {
    const { handlers, fire, dispose } = adapter();
    set({ drawWithFinger: false, palmRejection: "off" });
    fire("pointerdown", touch(1, 10, 100));
    fire("pointermove", { ...touch(1, 10, 110), clientX: 25 });
    fire("pointerup", { ...touch(1, 10, 120), buttons: 0 });
    expect(handlers.onDown).not.toHaveBeenCalled();
    expect(handlers.onPan).toHaveBeenCalled();
    set({ drawWithFinger: true });
    fire("pointerdown", touch(2, 10, 200));
    expect(handlers.onDown).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("palm_rejection_high_ignores_large_touch", () => {
    const { handlers, fire, dispose } = adapter();
    set({ drawWithFinger: true, palmRejection: "standard" });
    fire("pointerdown", touch(1, 30, 100)); // 30 px contact: under the standard 40 px threshold
    fire("pointerup", { ...touch(1, 30, 110), buttons: 0 });
    expect(handlers.onDown).toHaveBeenCalledTimes(1);
    set({ palmRejection: "high" });
    fire("pointerdown", touch(2, 30, 200)); // over the high 20 px threshold
    fire("pointerup", { ...touch(2, 30, 210), buttons: 0 });
    expect(handlers.onDown).toHaveBeenCalledTimes(1);
    set({ palmRejection: "off" });
    fire("pointerdown", touch(3, 60, 300));
    expect(handlers.onDown).toHaveBeenCalledTimes(2);
    dispose();
  });
});

describe("canvas settings", () => {
  beforeEach(async () => {
    useNotebookStore.setState({ loaded: true });
    await useEditorStore.getState().loadPage("pg");
    useEditorStore.setState({ elements: new Map() });
  });

  function controller() {
    return createToolController({
      store: useEditorStore,
      el: document.createElement("div"),
      requestLive: () => {},
      invalidate: () => {},
      renderElement: () => {},
      getSettings: cfg,
    });
  }

  it("snap_to_grid_aligns_shape", () => {
    set({ defaultShapeType: "rectangle" });
    const tools = controller();
    const drag = () => {
      tools.down({ x: 13, y: 27 }, "shape");
      tools.move([{ x: 98, y: 71 }]);
      tools.up();
      return [...useEditorStore.getState().elements.values()].at(-1)!;
    };
    set({ snapToGrid: false });
    expect(drag().points.map((p) => [p.x, p.y])).toEqual([
      [13, 27],
      [98, 71],
    ]);
    set({ snapToGrid: true }); // page spacing 40
    const snapped = drag();
    expect(snapped.points.map((p) => [p.x, p.y])).toEqual([
      [0, 40],
      [80, 80],
    ]);
    // Moving the selection keeps its top-left on the grid.
    useEditorStore.getState().select([snapped.id]);
    tools.down({ x: 40, y: 60 }, "cursor");
    tools.move([{ x: 57, y: 75 }]);
    tools.up();
    const moved = useEditorStore.getState().elements.get(snapped.id)!;
    expect([moved.points[0].x % 40, moved.points[0].y % 40]).toEqual([0, 0]);
    tools.dispose();
  });

  it("zoom_indicator_shown_when_enabled", () => {
    useEditorStore.getState().setCamera({ x: 0, y: 0, z: 1.5 });
    render(<ZoomIndicator store={useEditorStore} />);
    expect(screen.queryByRole("button", { name: /Zoom/ })).toBeNull();
    act(() => set({ showZoomIndicator: true }));
    const badge = screen.getByRole("button", { name: /Zoom 150%/ });
    expect(badge.textContent).toBe("150%");
    fireEvent.click(badge);
    expect(useEditorStore.getState().camera.z).not.toBe(1.5);
  });
});
