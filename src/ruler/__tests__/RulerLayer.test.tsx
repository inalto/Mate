// The ruler layer of one pane: nothing while the ruler is off or the pane presents; otherwise a
// pane-sized canvas that lets pointers through and the angle readout at the middle of the ruler.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
/** Counts the position snap's target collections (the real query still runs). */
const candidates = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../canvas/toolInteractions", async (orig) => {
  const m = await orig<typeof import("../../canvas/toolInteractions")>();
  return {
    ...m,
    guideCandidates: (...a: Parameters<typeof m.guideCandidates>) => {
      candidates.calls++;
      return m.guideCandidates(...a);
    },
  };
});

import { DEFAULT_SETTINGS } from "../../model/constants";
import { el } from "../../tools/__tests__/fixtures";
import { noteStylusSeen } from "../../canvas/input";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useSettingsStore } from "../../stores/settings";
import RulerLayer from "../RulerLayer";
let store: EditorStore;

beforeEach(() => {
  // jsdom has no canvas: the layer must cope with a missing 2D context.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  store = createEditorStore();
  store.setState({ camera: { x: 0, y: 0, z: 1 }, viewport: { width: 800, height: 600 } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const angleButton = () => screen.getByRole("button", { name: /Ruler angle/ });

describe("RulerLayer", () => {
  it("renders nothing while the ruler is off", () => {
    const { container } = render(<RulerLayer store={store} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing while the pane presents", () => {
    act(() => store.getState().toggleRuler());
    store.setState({ presenting: { index: 0, fill: false } });
    const { container } = render(<RulerLayer store={store} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the angle of the default pose, then of a new pose", () => {
    act(() => store.getState().toggleRuler());
    render(<RulerLayer store={store} />);
    expect(angleButton().textContent).toBe("0.0°");
    expect(angleButton().getAttribute("aria-label")).toBe("Ruler angle: 0.0 degrees");
    const { x, y } = store.getState().ruler.pose!;
    act(() => store.getState().setRulerPose({ x, y, angle: 225 }));
    expect(angleButton().textContent).toBe("45.0°");
    expect(angleButton().getAttribute("aria-label")).toBe("Ruler angle: 45.0 degrees");
  });

  it("places the angle button at the middle of the visible span", () => {
    act(() => store.getState().toggleRuler());
    render(<RulerLayer store={store} />);
    const style = angleButton().style;
    expect(style.left).toBe("400px");
    expect(style.top).toBe("300px");
  });

  it("covers the pane with a canvas that lets pointers through", () => {
    act(() => store.getState().toggleRuler());
    const { container } = render(<RulerLayer store={store} />);
    const canvas = container.querySelector("canvas.ruler-canvas") as HTMLCanvasElement;
    expect(canvas).toBeTruthy();
    expect(canvas.style.pointerEvents).toBe("none");
    expect(canvas.style.width).toBe("800px");
    expect(canvas.style.height).toBe("600px");
  });
});

const hitStrip = () => document.querySelector(".ruler-hit") as HTMLElement;
const handles = () => screen.getAllByRole("button", { name: "Rotate the ruler" });
const pose = () => store.getState().ruler.pose!;
const down = (el: Element, x: number, y: number, id = 1, init: object = {}) =>
  act(() => void fireEvent.pointerDown(el, { clientX: x, clientY: y, pointerId: id, button: 0, ...init }));
const move = (el: Element, x: number, y: number, id = 1, init: object = {}) =>
  act(() => void fireEvent.pointerMove(el, { clientX: x, clientY: y, pointerId: id, ...init }));
const up = (el: Element, x: number, y: number, id = 1) =>
  act(() => void fireEvent.pointerUp(el, { clientX: x, clientY: y, pointerId: id }));
const at = (c: { x: number; y: number }, r: number, deg: number) => ({
  x: c.x + r * Math.cos((deg * Math.PI) / 180),
  y: c.y - r * Math.sin((deg * Math.PI) / 180),
});

function showRuler() {
  act(() => store.getState().toggleRuler());
  return render(<RulerLayer store={store} />);
}

describe("RulerLayer: moving the ruler", () => {
  it("lays a rotated hit strip over the body, longer than the visible span", () => {
    showRuler();
    act(() => store.getState().setRulerPose({ x: 400, y: 300, angle: 0 }));
    const hit = hitStrip();
    // The body's span (800 plus 55 on each side) plus twice the pane's diagonal (2 × 1000), centred.
    expect(hit.style.width).toBe("2910px");
    expect(hit.style.height).toBe("94px");
    expect(hit.style.left).toBe("-1055px");
    expect(hit.style.top).toBe("253px");
    expect(hit.style.transform).toBe("rotate(0deg)");
    act(() => store.getState().setRulerPose({ x: 400, y: 300, angle: 30 }));
    expect(hitStrip().style.transform).toBe("rotate(-30deg)");
  });

  it("keeps the strip while half the body shows above the pane, without handles or angle button", () => {
    showRuler();
    act(() => store.getState().setRulerPose({ x: 400, y: -20, angle: 0 }));
    const hit = hitStrip();
    expect(hit).toBeTruthy();
    expect(hit.style.top).toBe(`${-20 - 47}px`);
    expect(screen.queryAllByRole("button", { name: "Rotate the ruler" })).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Ruler angle/ })).toBeNull();
    // The visible lower part drags it back into the pane.
    down(hit, 400, 20);
    move(hit, 400, 300);
    up(hit, 400, 300);
    expect(pose()).toEqual({ x: 400, y: 260, angle: 0 });
    expect(handles()).toHaveLength(2);
    // 80 px above the pane nothing of it shows: no strip.
    act(() => store.getState().setRulerPose({ x: 400, y: -80, angle: 0 }));
    expect(document.querySelector(".ruler-hit")).toBeNull();
  });

  it("releases its pointers when a drag carries the ruler off the pane", () => {
    showRuler();
    down(hitStrip(), 400, 300, 1);
    move(hitStrip(), 400, 1000, 1);
    // The centreline is below the pane: no strip, and no pointerup will reach it.
    expect(document.querySelector(".ruler-hit")).toBeNull();
    act(() => store.getState().setRulerPose({ x: 400, y: 300, angle: 0 }));
    // A fresh touch id moves the ruler on its own, without turning about a phantom first finger.
    down(hitStrip(), 400, 300, 7);
    move(hitStrip(), 420, 310, 7);
    expect(pose()).toEqual({ x: 420, y: 310, angle: 0 });
    // And a second fresh contact is still accepted as the pair's second finger.
    down(hitStrip(), 500, 310, 8);
    move(hitStrip(), 520, 310, 8);
    expect(pose().angle).toBe(0);
    expect(pose().x).toBeCloseTo(430, 9);
  });

  it("ignores Alt+wheel while a guided stroke is being drawn", () => {
    showRuler();
    act(() => store.getState().setRulerGuiding(true));
    const start = pose();
    act(() => void fireEvent.wheel(hitStrip(), { deltaY: -100, altKey: true, clientX: 400, clientY: 300 }));
    expect(pose()).toEqual(start);
  });

  it("moves the ruler with a pointer on the strip, without pan, drawing or an undo step", () => {
    showRuler();
    const camera = store.getState().camera;
    const elements = store.getState().elements;
    const start = pose();
    down(hitStrip(), 400, 300);
    move(hitStrip(), 450, 320);
    up(hitStrip(), 450, 320);
    expect(pose()).toEqual({ x: start.x + 50, y: start.y + 20, angle: 0 });
    expect(store.getState().camera).toBe(camera);
    expect(store.getState().elements).toBe(elements);
    expect(store.getState().elements.size).toBe(0);
    expect(store.getState().canUndo).toBe(false);
    // After the pointer is up, moves do nothing.
    move(hitStrip(), 500, 400);
    expect(pose()).toEqual({ x: start.x + 50, y: start.y + 20, angle: 0 });
  });

  it("does nothing while a guided stroke is being drawn", () => {
    showRuler();
    act(() => store.getState().setRulerGuiding(true));
    const start = pose();
    down(hitStrip(), 400, 300);
    move(hitStrip(), 450, 320);
    up(hitStrip(), 450, 320);
    expect(pose()).toEqual(start);
  });

  it("ends a drag when a guided stroke starts", () => {
    showRuler();
    const start = pose();
    down(hitStrip(), 400, 300);
    move(hitStrip(), 410, 300);
    act(() => store.getState().setRulerGuiding(true));
    move(hitStrip(), 450, 300);
    act(() => store.getState().setRulerGuiding(false));
    move(hitStrip(), 480, 300);
    expect(pose()).toEqual({ x: start.x + 10, y: start.y, angle: 0 });
  });

  it("turns with two pointers on the strip", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, rulerAngleSnap: 0 } });
    showRuler();
    const mid = { x: 400, y: 300 };
    const a0 = at(mid, 100, 180);
    const b0 = at(mid, 100, 0);
    down(hitStrip(), a0.x, a0.y, 1);
    down(hitStrip(), b0.x, b0.y, 2);
    for (let d = 1; d <= 10; d++) {
      const a = at(mid, 100, 180 + d);
      const b = at(mid, 100, d);
      move(hitStrip(), a.x, a.y, 1);
      move(hitStrip(), b.x, b.y, 2);
    }
    expect(pose().angle).toBeCloseTo(10, 6);
    expect(pose().x).toBeCloseTo(400, 6);
    expect(pose().y).toBeCloseTo(300, 6);
  });

  it("turns with Alt+wheel and leaves the camera; a plain wheel moves the camera and leaves the pose", () => {
    showRuler();
    const camera = store.getState().camera;
    act(() => void fireEvent.wheel(hitStrip(), { deltaY: -100, altKey: true, clientX: 400, clientY: 300 }));
    expect(pose().angle).toBe(15);
    expect(store.getState().camera).toBe(camera);
    act(() => void fireEvent.wheel(hitStrip(), { deltaY: 100, altKey: true, shiftKey: true, clientX: 400, clientY: 300 }));
    expect(pose().angle).toBeCloseTo(14.9, 9);
    expect(store.getState().camera).toBe(camera);
    const turned = pose();
    act(() => void fireEvent.wheel(hitStrip(), { deltaY: 100, clientX: 400, clientY: 300 }));
    expect(store.getState().camera).not.toEqual(camera);
    expect(pose()).toEqual(turned);
  });

  it("turns by 1° per Alt+wheel notch when the snap is off", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, rulerAngleSnap: 0 } });
    showRuler();
    act(() => void fireEvent.wheel(hitStrip(), { deltaY: 100, altKey: true, clientX: 400, clientY: 300 }));
    expect(pose().angle).toBe(359);
  });
});

describe("RulerLayer: rotate handles", () => {
  it("places two handles 48 px in from the ends of the visible span", () => {
    showRuler();
    const [a, b] = handles();
    expect([a.style.left, a.style.top]).toEqual(["48px", "300px"]);
    expect([b.style.left, b.style.top]).toEqual(["752px", "300px"]);
  });

  it("places the handles at a quarter and three quarters of a short span", () => {
    showRuler();
    // The centreline crosses the corner: span from (0, 100) to (100, 0), about 141 px long.
    act(() => store.getState().setRulerPose({ x: 50, y: 50, angle: 45 }));
    const [a, b] = handles();
    expect(parseFloat(a.style.left)).toBeCloseTo(25, 6);
    expect(parseFloat(a.style.top)).toBeCloseTo(75, 6);
    expect(parseFloat(b.style.left)).toBeCloseTo(75, 6);
    expect(parseFloat(b.style.top)).toBeCloseTo(25, 6);
  });

  it("turns about the anchor with the snap, and without it while Shift is held", () => {
    showRuler();
    const anchor = { x: 400, y: 300 };
    const h = handles()[1];
    down(h, 752, 300);
    let p = at(anchor, 352, 14);
    move(h, p.x, p.y);
    expect(pose().angle).toBe(15);
    expect(pose().x).toBeCloseTo(400, 9);
    expect(pose().y).toBeCloseTo(300, 9);
    move(h, p.x, p.y, 1, { shiftKey: true });
    expect(pose().angle).toBeCloseTo(14, 9);
    // The unsnapped angle is tracked: a slow turn does not stick at 15.
    for (let d = 14.5; d <= 20; d += 0.5) {
      p = at(anchor, 352, d);
      move(h, p.x, p.y);
    }
    expect(pose().angle).toBeCloseTo(20, 9);
    up(h, p.x, p.y);
    expect(store.getState().canUndo).toBe(false);
  });

  it("turns about the middle of the visible span when the anchor is off the pane", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, rulerAngleSnap: 0 } });
    showRuler();
    act(() => store.getState().setRulerPose({ x: -200, y: 300, angle: 0 }));
    const h = handles()[1];
    down(h, 752, 300);
    const p = at({ x: 400, y: 300 }, 352, 10);
    move(h, p.x, p.y);
    expect(pose().angle).toBeCloseTo(10, 9);
    // The world point under the middle of the old span (400, 300) is still on the centreline.
    const r = (10 * Math.PI) / 180;
    const dx = 400 - pose().x;
    const dy = 300 - pose().y;
    expect(Math.abs(-Math.sin(r) * dx - Math.cos(r) * dy)).toBeLessThan(1e-9);
  });

  it("does not start a handle drag while a guided stroke is drawn, and ends one when it starts", () => {
    showRuler();
    const h = handles()[1];
    act(() => store.getState().setRulerGuiding(true));
    down(h, 752, 300);
    let p = at({ x: 400, y: 300 }, 352, 30);
    move(h, p.x, p.y);
    expect(pose().angle).toBe(0);
    up(h, p.x, p.y);
    act(() => store.getState().setRulerGuiding(false));
    down(h, 752, 300);
    move(h, p.x, p.y);
    expect(pose().angle).toBe(30);
    act(() => store.getState().setRulerGuiding(true));
    p = at({ x: 400, y: 300 }, 352, 60);
    move(h, p.x, p.y);
    expect(pose().angle).toBe(30);
  });

  it("turns with the arrow keys on a focused handle", () => {
    showRuler();
    const h = handles()[0];
    act(() => void fireEvent.keyDown(h, { key: "ArrowRight" }));
    expect(pose().angle).toBe(15);
    act(() => void fireEvent.keyDown(h, { key: "ArrowUp" }));
    expect(pose().angle).toBe(30);
    act(() => void fireEvent.keyDown(h, { key: "ArrowLeft" }));
    expect(pose().angle).toBe(15);
    act(() => void fireEvent.keyDown(h, { key: "ArrowDown", shiftKey: true }));
    expect(pose().angle).toBeCloseTo(14.9, 9);
    expect(pose().x).toBeCloseTo(400, 9);
    expect(pose().y).toBeCloseTo(300, 9);
  });

  it("ignores the arrow keys while a guided stroke is being drawn", () => {
    showRuler();
    act(() => store.getState().setRulerGuiding(true));
    act(() => void fireEvent.keyDown(handles()[0], { key: "ArrowRight" }));
    expect(pose().angle).toBe(0);
  });

  it("turns by 1° per arrow key when the snap is off", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, rulerAngleSnap: 0 } });
    showRuler();
    act(() => void fireEvent.keyDown(handles()[0], { key: "ArrowDown" }));
    expect(pose().angle).toBe(359);
  });
});

describe("RulerLayer: angle field", () => {
  const field = () => screen.getByRole("textbox", { name: "Angle in degrees, 0 to 180" }) as HTMLInputElement;
  const open = () => act(() => void fireEvent.click(angleButton()));
  const typeIn = (text: string) => act(() => void fireEvent.change(field(), { target: { value: text } }));
  const key = (k: string) => act(() => void fireEvent.keyDown(field(), { key: k }));

  it("opens prefilled with the readout, focused", () => {
    showRuler();
    act(() => store.getState().setRulerPose({ x: 400, y: 300, angle: 12.34 }));
    open();
    expect(field().value).toBe("12.3");
    expect(field().getAttribute("inputmode")).toBe("decimal");
    expect(document.activeElement).toBe(field());
    expect(screen.queryByRole("button", { name: /Ruler angle/ })).toBeNull();
  });

  it("applies 30 on Enter about the middle of the visible span", () => {
    showRuler();
    open();
    typeIn("30");
    key("Enter");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(angleButton().textContent).toBe("30.0°");
    expect(pose().x).toBeCloseTo(400, 9);
    expect(pose().y).toBeCloseTo(300, 9);
    expect(store.getState().canUndo).toBe(false);
  });

  it("accepts a comma as decimal separator, and 180 as 0.0°", () => {
    showRuler();
    open();
    typeIn("12,5");
    key("Enter");
    expect(angleButton().textContent).toBe("12.5°");
    open();
    typeIn("180");
    key("Enter");
    expect(angleButton().textContent).toBe("0.0°");
  });

  it("refuses 200 and keeps the field open", () => {
    showRuler();
    const start = pose();
    open();
    typeIn("200");
    key("Enter");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(pose()).toEqual(start);
    typeIn("abc");
    key("Enter");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(pose()).toEqual(start);
  });

  it("closes without change on Escape and on blur", () => {
    showRuler();
    const start = pose();
    open();
    typeIn("45");
    key("Escape");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(pose()).toEqual(start);
    open();
    typeIn("45");
    act(() => void fireEvent.blur(field()));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(pose()).toEqual(start);
  });

  it("does not apply a typed angle while a guided stroke is being drawn", () => {
    showRuler();
    const start = pose();
    open();
    typeIn("30");
    act(() => store.getState().setRulerGuiding(true));
    key("Enter");
    expect(pose()).toEqual(start);
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });

  it("keeps the field inside the pane", () => {
    showRuler();
    act(() => store.getState().setRulerPose({ x: 2, y: 2, angle: 45 }));
    open();
    expect(parseFloat(field().style.left)).toBeGreaterThanOrEqual(8 + 36);
    expect(parseFloat(field().style.top)).toBeGreaterThanOrEqual(8 + 14);
  });

  it("does not start a ruler drag from a press on the angle button", () => {
    showRuler();
    const start = pose();
    down(angleButton(), 400, 300);
    move(hitStrip(), 450, 300);
    up(hitStrip(), 450, 300);
    expect(pose()).toEqual(start);
  });
});

describe("RulerLayer: position snap", () => {
  /** A canvas page ruled every 40: lines at y = …, 240, 280, 320, 360, … */
  const ruledPage = () => store.setState({ page: { id: "pg", mode: "canvas", backgroundConfig: { type: "ruled", spacing: 40, dotRadius: 1.5 } } as never });
  const withSettings = (patch: object) => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...patch } });

  it("snaps an edge to a background line while snapToGrid is on, and clears the guide on pointer up", () => {
    withSettings({ snapToGrid: true, smartGuides: false });
    ruledPage();
    showRuler();
    // Default pose (400, 300): edges at 245 and 355. Down 2: the lower edge is 3 from 360.
    down(hitStrip(), 400, 300);
    move(hitStrip(), 400, 302);
    expect(pose()).toEqual({ x: 400, y: 305, angle: 0 });
    expect(store.getState().guides).toEqual([{ axis: "y", at: 360, from: 0, to: 800 }]);
    // Further on, the snap lets go: the drag keeps its own unsnapped pose.
    move(hitStrip(), 400, 320);
    expect(pose()).toEqual({ x: 400, y: 320, angle: 0 });
    expect(store.getState().guides).toEqual([]);
    move(hitStrip(), 400, 302);
    expect(store.getState().guides).toHaveLength(1);
    up(hitStrip(), 400, 302);
    expect(store.getState().guides).toEqual([]);
    expect(pose()).toEqual({ x: 400, y: 305, angle: 0 });
  });

  it("never snaps with smartGuides and snapToGrid off", () => {
    withSettings({ snapToGrid: false, smartGuides: false });
    ruledPage();
    showRuler();
    down(hitStrip(), 400, 300);
    move(hitStrip(), 400, 302);
    expect(pose()).toEqual({ x: 400, y: 302, angle: 0 });
    expect(store.getState().guides).toEqual([]);
    up(hitStrip(), 400, 302);
  });

  it("does not snap while Shift is held", () => {
    withSettings({ snapToGrid: true });
    ruledPage();
    showRuler();
    down(hitStrip(), 400, 300);
    move(hitStrip(), 400, 302, 1, { shiftKey: true });
    expect(pose()).toEqual({ x: 400, y: 302, angle: 0 });
    expect(store.getState().guides).toEqual([]);
  });

  it("clears the guide when the drag ends because a guided stroke starts", () => {
    withSettings({ snapToGrid: true });
    ruledPage();
    showRuler();
    down(hitStrip(), 400, 300);
    move(hitStrip(), 400, 302);
    expect(store.getState().guides).toHaveLength(1);
    act(() => store.getState().setRulerGuiding(true));
    expect(store.getState().guides).toEqual([]);
  });

  it("clears the guide when the ruler is turned off mid-drag", () => {
    withSettings({ snapToGrid: true });
    ruledPage();
    showRuler();
    down(hitStrip(), 400, 300);
    move(hitStrip(), 400, 302);
    expect(store.getState().guides).toHaveLength(1);
    act(() => store.getState().toggleRuler());
    expect(store.getState().guides).toEqual([]);
  });

  // Default pose (400, 300): the lower edge (−1) lies at y = 355. A drag sideways keeps it there.
  const besideTheEdge = (element: ReturnType<typeof el>) => {
    withSettings({ snapToGrid: false, smartGuides: true });
    act(() => store.getState().addElement(element));
    showRuler();
    down(hitStrip(), 400, 300);
    move(hitStrip(), 410, 300);
  };

  it("does not snap to handwriting 3 px from the edge", () => {
    besideTheEdge(el("ink", [[100, 358], [300, 358]], { width: 2 }));
    expect(pose()).toEqual({ x: 410, y: 300, angle: 0 });
    expect(store.getState().guides).toEqual([]);
  });

  it("snaps to a rectangle shape 3 px from the edge", () => {
    besideTheEdge(el("box", [[100, 358]], { type: "shape", shapeType: "rectangle", fillColor: "transparent", boxWidth: 200, boxHeight: 100 }));
    // The edge moves onto the rectangle's top (its outline included).
    expect(pose().x).toBe(410);
    expect(pose().y).toBeGreaterThan(300);
    expect(pose().y).toBeLessThanOrEqual(303);
    expect(store.getState().guides).toHaveLength(1);
  });

  it("snaps to a cover stroke 3 px from the edge", () => {
    besideTheEdge(el("cv", [[100, 358], [300, 358]], { width: 2, penStyle: "cover", color: "#334155" }));
    expect(pose().y).not.toBe(300);
    expect(Math.abs(pose().y - 303)).toBeLessThanOrEqual(2);
    expect(store.getState().guides).toHaveLength(1);
  });

  it("gathers the element targets once per drag, and not at all off 0° and 90°", () => {
    withSettings({ snapToGrid: false, smartGuides: true });
    showRuler();
    candidates.calls = 0;
    down(hitStrip(), 400, 300);
    for (let i = 1; i <= 6; i++) move(hitStrip(), 400 + 10 * i, 300 + 3 * i);
    up(hitStrip(), 460, 318);
    expect(candidates.calls).toBe(1);
    down(hitStrip(), 460, 318, 2);
    move(hitStrip(), 470, 318, 2);
    expect(candidates.calls).toBe(2);
    up(hitStrip(), 470, 318, 2);
    act(() => store.getState().setRulerPose({ x: 400, y: 300, angle: 30 }));
    candidates.calls = 0;
    down(hitStrip(), 400, 300, 3);
    for (let i = 1; i <= 4; i++) move(hitStrip(), 400 + 10 * i, 300, 3);
    expect(candidates.calls).toBe(0);
    expect(pose().x).toBeCloseTo(440, 9);
  });
});

describe("RulerLayer: touch on the body", () => {
  const touch = (width = 20) => ({ pointerType: "touch", width, height: width });

  it("ignores a palm-sized touch on the strip", () => {
    showRuler();
    const start = pose();
    down(hitStrip(), 400, 300, 1, touch(100));
    move(hitStrip(), 450, 330, 1, touch(100));
    up(hitStrip(), 450, 330, 1);
    expect(pose()).toEqual(start);
  });

  it("moves with a fingertip only past 6 px, from there on and without a jump", () => {
    showRuler();
    const start = pose();
    down(hitStrip(), 400, 300, 1, touch());
    move(hitStrip(), 404, 300, 1, touch());
    expect(pose()).toEqual(start);
    // The threshold is crossed here: the ruler stays and follows from this point.
    move(hitStrip(), 407, 300, 1, touch());
    expect(pose()).toEqual(start);
    move(hitStrip(), 430, 300, 1, touch());
    expect(pose()).toEqual({ x: start.x + 23, y: start.y, angle: 0 });
    up(hitStrip(), 430, 300, 1);
  });

  describe("only a definite palm is refused, even right after the pen", () => {
    const touchAt = (type: string, x: number, id: number, size: number, timeStamp: number) =>
      act(() => {
        const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: "touch", clientX: x, clientY: 300, width: size, height: size });
        Object.defineProperty(ev, "timeStamp", { value: timeStamp });
        hitStrip().dispatchEvent(ev);
      });
    /** A drag of 40 px (past the 6 px slop at 410) 500 ms after a stylus was seen. */
    const dragWith = (size: number) => {
      noteStylusSeen(10_000);
      touchAt("pointerdown", 400, 1, size, 10_500);
      touchAt("pointermove", 410, 1, size, 10_520);
      touchAt("pointermove", 440, 1, size, 10_540);
      touchAt("pointerup", 440, 1, size, 10_560);
    };

    it("refuses a contact of radius 50", () => {
      showRuler();
      const start = pose();
      dragWith(100);
      expect(pose()).toEqual(start);
    });

    it("moves with a contact of radius 30 after the slop", () => {
      showRuler();
      const start = pose();
      dragWith(60);
      expect(pose()).toEqual({ x: start.x + 30, y: start.y, angle: 0 });
    });

    it("moves with a contact of radius 50 when palm rejection is off", () => {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, palmRejection: "off" } });
      showRuler();
      const start = pose();
      dragWith(100);
      expect(pose()).toEqual({ x: start.x + 30, y: start.y, angle: 0 });
    });
  });

  it("moves with a pen from the first pixel", () => {
    showRuler();
    const start = pose();
    down(hitStrip(), 400, 300, 1, { pointerType: "pen" });
    move(hitStrip(), 401, 300, 1, { pointerType: "pen" });
    expect(pose()).toEqual({ x: start.x + 1, y: start.y, angle: 0 });
  });

  it("has no slop for two fingers: the first one's small move counts once the second lands", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, rulerAngleSnap: 0 } });
    showRuler();
    const start = pose();
    down(hitStrip(), 300, 300, 1, touch());
    move(hitStrip(), 303, 300, 1, touch());
    expect(pose()).toEqual(start);
    down(hitStrip(), 500, 300, 2, touch());
    move(hitStrip(), 503, 300, 2, touch());
    expect(pose().x).toBeCloseTo(start.x + 1.5, 9);
    // The first finger takes part from where it was when the second landed (303), not from 300.
    move(hitStrip(), 306, 300, 1, touch());
    expect(pose().x).toBeCloseTo(start.x + 3, 9);
    expect(pose().angle).toBe(0);
  });
});

describe("RulerLayer: Alt+wheel", () => {
  const altWheel = (target: Element, deltaY: number, timeStamp?: number) =>
    act(() => {
      const ev = new WheelEvent("wheel", { deltaY, altKey: true, clientX: 400, clientY: 300, bubbles: true, cancelable: true });
      if (timeStamp !== undefined) Object.defineProperty(ev, "timeStamp", { value: timeStamp });
      target.dispatchEvent(ev);
    });

  it("turns one step for ten trackpad events of −10", () => {
    showRuler();
    for (let i = 0; i < 10; i++) altWheel(hitStrip(), -10, 1000 + i * 16);
    expect(pose().angle).toBe(15);
  });

  it("turns one step for a mouse notch of −120", () => {
    showRuler();
    altWheel(hitStrip(), -120, 1000);
    expect(pose().angle).toBe(15);
    altWheel(hitStrip(), -120, 1050);
    expect(pose().angle).toBe(30);
  });

  it("turns nothing for +30 then −30, nor across a pause", () => {
    showRuler();
    altWheel(hitStrip(), 30, 1000);
    altWheel(hitStrip(), -30, 1016);
    expect(pose().angle).toBe(0);
    altWheel(hitStrip(), -60, 2000);
    altWheel(hitStrip(), -60, 2300);
    expect(pose().angle).toBe(0);
    altWheel(hitStrip(), -60, 2350);
    expect(pose().angle).toBe(15);
  });

  it("works over a handle and the angle button, and leaves the open angle field's wheel alone", () => {
    showRuler();
    altWheel(handles()[0], -120, 1000);
    expect(pose().angle).toBe(15);
    altWheel(angleButton(), -120, 2000);
    expect(pose().angle).toBe(30);
    act(() => void fireEvent.click(angleButton()));
    const field = screen.getByRole("textbox");
    const ev = new WheelEvent("wheel", { deltaY: -120, altKey: true, bubbles: true, cancelable: true });
    act(() => void field.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(false);
    expect(pose().angle).toBe(30);
  });
});
