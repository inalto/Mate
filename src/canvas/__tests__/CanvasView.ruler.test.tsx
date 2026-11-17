// Strokes along the ruler's edge on the mounted canvas: a press in an edge band draws (or erases)
// along the edge line frozen at pen-down; ink-to-shape, perfect shapes, straight lines and scribble
// to erase leave a guided stroke alone; taps keep doing what they do without the ruler.
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element, Settings } from "../../model/types";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const ipc = vi.hoisted(() => ({ els: [] as Element[] }));
const tutorDown = vi.hoisted(() => vi.fn());
/** Whether the mocked scribble detector calls every stroke a scribble over the ink "under". */
const scribbling = vi.hoisted(() => ({ on: false }));
/** Text drawn on any canvas (the length readout). */
const texts = vi.hoisted(() => [] as string[]);
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => ipc.els), unitElementTimes: vi.fn(async () => []) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
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
  return {
    ...m,
    isScribbleGesture: (...a: Parameters<typeof m.isScribbleGesture>) => (scribbling.on ? { scribble: true, bbox: { x: 0, y: 0, width: 1, height: 1 } } : m.isScribbleGesture(...a)),
    scribbleHits: (...a: Parameters<typeof m.scribbleHits>) => (scribbling.on ? ["under"] : m.scribbleHits(...a)),
  };
});

import { DEFAULT_SETTINGS } from "../../model/constants";
import { recordingElement } from "../../recording/marker";
import { createReplay } from "../../recording/replay";
import type { RecordingContent } from "../../recording/types";
import { guidedLength } from "../../ruler/guide";
import { edgeLine, type RulerPose } from "../../ruler/pose";
import RulerLayer from "../../ruler/RulerLayer";
import { UNITS_PER_MM } from "../../ruler/scale";
import { createEditorStore, sheetStack, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { el } from "../../tools/__tests__/fixtures";
import { worldToScreen, type Vec2 } from "../camera";
import CanvasView from "../CanvasView";
import { sheetRectAt } from "../pageBounds";

function fakeCtx() {
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 };
  const noop = () => ({ addColorStop() {} });
  return new Proxy(state, {
    get: (t, k) =>
      k in t
        ? t[k]
        : k === "measureText"
          ? (s: string) => ({ width: String(s).length * 7 })
          : k === "fillText"
            ? (s: string) => void texts.push(String(s))
            : noop,
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
}

const T0 = Date.parse("2026-11-14T09:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

/** Horizontal ruler: its edge +1 (the upper one) lies at y = 345, the band reaches y = 329. */
const POSE: RulerPose = { x: 400, y: 400, angle: 0 };
const EDGE_Y = 345;
const under = el("under", [[150, EDGE_Y], [450, EDGE_Y]], { width: 4 });

let store: EditorStore;
let host: HTMLElement;
const s = () => store.getState();
const setSettings = (patch: Partial<Settings>) => useSettingsStore.setState((st) => ({ settings: { ...st.settings, ...patch } }));
const rulerOn = (pose: RulerPose = POSE) => store.setState({ ruler: { on: true, pose } });
const added = () => [...s().elements.values()].filter((e) => !ipc.els.some((o) => o.id === e.id));

async function mount() {
  useNotebookStore.setState({ loaded: true });
  store = createEditorStore();
  const view = render(createElement(CanvasView, { pageId: "pg", store }));
  host = view.container.querySelector(".canvas-live")!;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(s().loadedPageId).toBe("pg");
  s().setViewport({ width: 800, height: 600 });
  store.setState({ camera: { x: 0, y: 0, z: 1 } });
}

const frame = () => act(async () => void (await new Promise((r) => setTimeout(r, 40))));

let clock = 1000;
function fire(type: string, p: Vec2 & { pressure?: number }, pointerType: string, buttons: number) {
  const sc = worldToScreen(s().camera, p);
  const ev = new PointerEvent(type, { pointerId: 7, pointerType, bubbles: true, cancelable: true, pressure: p.pressure ?? 0.5, clientX: sc.x, clientY: sc.y, button: 0, buttons, width: 10, height: 10 });
  Object.defineProperty(ev, "timeStamp", { value: clock });
  clock += 8;
  host.dispatchEvent(ev);
}
const down = (p: Vec2 & { pressure?: number }, pointerType = "pen") => fire("pointerdown", p, pointerType, 1);
const moveTo = (pts: (Vec2 & { pressure?: number })[], pointerType = "pen") => pts.forEach((p) => fire("pointermove", p, pointerType, 1));
const up = (p: Vec2, pointerType = "pen") => {
  fire("pointerup", p, pointerType, 0);
  clock += 1000;
};
/** A whole pen stroke through `pts`. */
function stroke(pts: (Vec2 & { pressure?: number })[], pointerType = "pen") {
  down(pts[0], pointerType);
  moveTo(pts.slice(1), pointerType);
  up(pts[pts.length - 1], pointerType);
}
function tap(p: Vec2) {
  down(p);
  up(p);
}
/** A wavy stroke from (x0, y0) rightwards, with pressures rising along it. */
const wavy = (x0: number, y0: number, n = 40) =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + i * 5, y: y0 + 6 * Math.sin(i / 3), pressure: 0.3 + (0.5 * i) / n }));
const onEdge = (e: Element, y = EDGE_Y) => e.points.every((p) => Math.abs(p.y - y) < 1e-6);

beforeEach(() => {
  texts.length = 0;
  tutorDown.mockClear();
  scribbling.on = false;
  ipc.els = [];
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as unknown as HTMLCanvasElement["getContext"];
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  document.body.innerHTML = "";
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe("strokes along the ruler's edge", () => {
  it("a wavy pen stroke started 10 px outside the edge lies on the edge line with varying pressure", async () => {
    await mount();
    rulerOn();
    stroke(wavy(200, EDGE_Y - 10));
    const ink = added();
    expect(ink).toHaveLength(1);
    expect(ink[0].type).toBe("stroke");
    expect(onEdge(ink[0])).toBe(true);
    expect(ink[0].points.length).toBeGreaterThan(2);
    expect(new Set(ink[0].points.map((p) => p.pressure)).size).toBeGreaterThan(1);
    expect(tutorDown).not.toHaveBeenCalled();
  });

  it("the same press 30 px outside the edge commits the wavy stroke", async () => {
    await mount();
    rulerOn();
    stroke(wavy(200, EDGE_Y - 30));
    const ink = added();
    expect(ink).toHaveLength(1);
    expect(ink[0].points.some((p) => Math.abs(p.y - (EDGE_Y - 30)) > 1)).toBe(true);
    expect(tutorDown).toHaveBeenCalled();
  });

  it("a press 5 px inside the edge is guided too, and with the ruler off nothing is", async () => {
    await mount();
    rulerOn();
    stroke(wavy(200, EDGE_Y + 5));
    expect(onEdge(added()[0])).toBe(true);
    store.setState({ ruler: { on: false, pose: POSE } });
    stroke(wavy(200, EDGE_Y - 10));
    expect(added()).toHaveLength(2);
    expect(added().filter((e) => onEdge(e))).toHaveLength(1);
  });

  it("the edge line is frozen at pen-down: moving the ruler or the camera meanwhile changes nothing", async () => {
    await mount();
    rulerOn();
    const pts = wavy(200, EDGE_Y - 10);
    down(pts[0]);
    moveTo(pts.slice(1, 10));
    store.setState({ ruler: { on: true, pose: { x: 400, y: 300, angle: 30 } } });
    moveTo(pts.slice(10));
    up(pts[pts.length - 1]);
    expect(onEdge(added()[0])).toBe(true);
  });

  it.each([
    ["straight-lines mode", () => s().setStraightLines(true)],
    ["perfect shapes", () => s().toggleAutoShapes()],
    ["ink to shape on release", () => setSettings({ inkToShape: true, inkToShapeSnapsOnRelease: true })],
  ])("with %s on, a guided stroke is an ordinary many-point stroke and no shape is added", async (_, turnOn) => {
    await mount();
    rulerOn();
    turnOn();
    stroke(wavy(200, EDGE_Y - 10));
    const ink = added();
    expect(ink).toHaveLength(1);
    expect(ink[0].type).toBe("stroke");
    expect(ink[0].points.length).toBeGreaterThan(2);
    expect(onEdge(ink[0])).toBe(true);
  });

  it("perfect shapes still turn a straight stroke off the band into a line (control)", async () => {
    await mount();
    rulerOn();
    s().toggleAutoShapes();
    stroke(Array.from({ length: 30 }, (_, i) => ({ x: 200 + i * 7, y: EDGE_Y - 60 })));
    expect(added().map((e) => e.type)).toEqual(["shape"]);
  });

  it("a scribble back and forth along the edge over ink erases nothing and is committed as ink", async () => {
    ipc.els = [under];
    await mount();
    rulerOn();
    scribbling.on = true;
    const zigzag = Array.from({ length: 30 }, (_, i) => ({ x: 200 + (i % 2 === 0 ? 0 : 80), y: EDGE_Y - 8 + (i % 3) }));
    stroke(zigzag);
    expect(s().elements.has("under")).toBe(true);
    expect(added()).toHaveLength(1);
    expect(onEdge(added()[0])).toBe(true);
    // Control: without the ruler the same scribble erases the ink under it.
    store.setState({ ruler: { on: false, pose: POSE } });
    stroke(zigzag);
    expect(s().elements.has("under")).toBe(false);
  });

  it("an eraser drag started at the edge erases the stroke on the line and spares one 30 units off it", async () => {
    const off = el("off", [[150, EDGE_Y - 30], [450, EDGE_Y - 30]], { width: 4 });
    ipc.els = [under, off];
    await mount();
    s().setTool("eraser");
    // 14 px outside the edge: the eraser (radius 10) would miss the stroke on the line without the ruler.
    const drag = Array.from({ length: 20 }, (_, i) => ({ x: 200 + i * 10, y: EDGE_Y - 14 }));
    stroke(drag);
    expect(s().elements.has("under")).toBe(true); // control: no ruler
    rulerOn();
    stroke(drag);
    expect(s().elements.has("under")).toBe(false);
    expect(s().elements.has("off")).toBe(true);
    expect(s().rulerGuiding).toBe(false);
  });

  it("rulerGuiding is true between down and up and false after up and after cancel", async () => {
    await mount();
    rulerOn();
    const pts = wavy(200, EDGE_Y - 10);
    down(pts[0]);
    expect(s().rulerGuiding).toBe(true);
    moveTo(pts.slice(1));
    expect(s().rulerGuiding).toBe(true);
    up(pts[pts.length - 1]);
    expect(s().rulerGuiding).toBe(false);

    down(pts[0]);
    moveTo(pts.slice(1, 5));
    expect(s().rulerGuiding).toBe(true);
    fire("pointercancel", pts[5], "pen", 0);
    expect(s().rulerGuiding).toBe(false);

    s().setTool("eraser");
    down(pts[0]);
    expect(s().rulerGuiding).toBe(true);
    up(pts[3]);
    expect(s().rulerGuiding).toBe(false);

    // An unguided press never sets it.
    s().selectInk("pen");
    down({ x: 200, y: EDGE_Y - 40 });
    expect(s().rulerGuiding).toBe(false);
    up({ x: 200, y: EDGE_Y - 40 });
  });

  it("in page mode a guided stroke leaving the sheet ends on the sheet's edge, on the line", async () => {
    await mount();
    setSettings({ strokeStabilization: 0 });
    store.setState({ page: { ...s().page!, mode: "page" } });
    const sheet = sheetRectAt(sheetStack(s()), { x: 100, y: 100 })!;
    expect(sheet).not.toBeNull();
    const y = sheet.y + 500;
    rulerOn({ x: sheet.x + 300, y: y + 55, angle: 0 });
    const right = sheet.x + sheet.width;
    stroke(Array.from({ length: 41 }, (_, i) => ({ x: right - 100 + i * 5, y: y - 10 + 6 * Math.sin(i / 2) })));
    const ink = added();
    expect(ink).toHaveLength(1);
    expect(onEdge(ink[0], y)).toBe(true);
    const last = ink[0].points[ink[0].points.length - 1];
    expect(last.x).toBeCloseTo(right, 6);
  });

  it("a tap in the edge band on a cover toggles it and commits nothing", async () => {
    const cover = el("cv", [[100, 100], [220, 100]], { width: 28, penStyle: "cover", color: "#334155" });
    ipc.els = [cover];
    await mount();
    // Edge +1 at y = 105: the tap at y = 100 is 5 px outside it.
    rulerOn({ x: 400, y: 160, angle: 0 });
    s().selectInk("pen");
    tap({ x: 160, y: 100 });
    expect(s().revealed.has("cv")).toBe(true);
    expect(s().elements.size).toBe(1);
    expect(s().rulerGuiding).toBe(false);
  });

  it("a tap in the edge band on a replayed note still seeks", async () => {
    const rec: RecordingContent = {
      unitId: "u1",
      spans: [{ wallStart: iso(0), audioStartMs: 0, durationMs: 600_000 }],
      segments: [{ assetId: "a1", durationMs: 600_000, mime: "audio/webm" }],
    };
    const marker = recordingElement("pg", "rec", iso(0), { x: 600, y: 600 }, rec, "Lecture");
    const note = el("nt", [[100, 300], [220, 300]], { width: 4, createdAt: iso(60_000) });
    ipc.els = [marker, note];
    await mount();
    rulerOn({ x: 400, y: 355, angle: 0 }); // edge +1 at y = 300
    const audio = Object.assign(new EventTarget(), { play: vi.fn(async () => {}), pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(), src: "", currentTime: 0, playbackRate: 1 });
    const replay = createReplay({ audio: audio as unknown as HTMLAudioElement, urlOf: async (id) => `url:${id}`, goToPage: vi.fn() });
    await replay.getState().open(store, "rec");
    const seek = vi.spyOn(replay.getState(), "seekToElement");
    tap({ x: 160, y: 295 });
    expect(seek).toHaveBeenCalledWith("nt");
    expect(s().elements.size).toBe(2);
    act(() => replay.getState().close());
  });

  it("with a 1 cm length snap the committed stroke is a whole number of centimetres; a tap stays a dot", async () => {
    await mount();
    setSettings({ rulerLengthSnap: "1cm" });
    rulerOn();
    stroke(Array.from({ length: 28 }, (_, i) => ({ x: 200 + i * 5, y: EDGE_Y - 10 + (i % 2) })));
    const line = edgeLine(POSE, s().camera, 1);
    const cm = guidedLength(added()[0].points, line) / (10 * UNITS_PER_MM);
    expect(cm).toBeGreaterThan(0.5);
    expect(Math.abs(cm - Math.round(cm))).toBeLessThan(1e-6);

    tap({ x: 500, y: EDGE_Y - 10 });
    const dot = added()[1];
    expect(dot).toBeDefined();
    expect(Math.abs(guidedLength(dot.points, line))).toBeLessThan(1);
  });

  it("with a 1 cm length snap a press held still in the band commits a dot, not a centimetre", async () => {
    await mount();
    setSettings({ rulerLengthSnap: "1cm" });
    rulerOn();
    const at = { x: 300, y: EDGE_Y - 10 };
    down(at);
    for (let i = 0; i < 5; i++) {
      clock += 100;
      moveTo([at]);
    }
    up(at);
    const dot = added()[0];
    expect(dot).toBeDefined();
    expect(Math.abs(guidedLength(dot.points, edgeLine(POSE, s().camera, 1)))).toBeLessThan(1);
  });

  it("with a 1 cm length snap a slow stroke straight across the ruler is not stretched to a centimetre", async () => {
    await mount();
    setSettings({ rulerLengthSnap: "1cm" });
    rulerOn();
    const across = Array.from({ length: 11 }, (_, i) => ({ x: 300 + i * 0.1, y: EDGE_Y - 10 + i * 5 }));
    down(across[0]);
    for (const q of across.slice(1)) {
      clock += 40;
      moveTo([q]);
    }
    up(across[across.length - 1]);
    expect(Math.abs(guidedLength(added()[0].points, edgeLine(POSE, s().camera, 1)))).toBeLessThan(2);
  });

  it("with a 1 cm length snap the readout shows the length the stroke will get", async () => {
    await mount();
    setSettings({ rulerLengthSnap: "1cm", strokeStabilization: 0 });
    rulerOn();
    const length = 23 * UNITS_PER_MM;
    const pts = Array.from({ length: 21 }, (_, i) => ({ x: 200 + (length * i) / 20, y: EDGE_Y - 10 + (i % 2) }));
    down(pts[0]);
    moveTo(pts.slice(1));
    await frame();
    expect(texts).toContain("2 cm");
    expect(texts).not.toContain("2.3 cm");
    up(pts[pts.length - 1]);
    expect(guidedLength(added()[0].points, edgeLine(POSE, s().camera, 1)) / (10 * UNITS_PER_MM)).toBeCloseTo(2, 6);
  });

  it("with perfect shapes on, a tap in the band on a shape's outline 12 px from the edge line selects it", async () => {
    // A rectangle whose top side lies at y = 200; the edge line is at y = 212.
    const box = el("box", [[100, 200]], { type: "shape", shapeType: "rectangle", fillColor: "transparent", boxWidth: 200, boxHeight: 100 });
    ipc.els = [box];
    await mount();
    rulerOn({ x: 400, y: 267, angle: 0 });
    s().toggleAutoShapes();
    s().selectInk("pen");
    tap({ x: 150, y: 200 });
    expect(s().selection).toEqual(new Set(["box"]));
    expect(s().elements.size).toBe(1);
  });

  it("a finger moving the ruler is cut off by a guided pen stroke, which follows the edge frozen at pen-down", async () => {
    await mount();
    rulerOn();
    render(createElement(RulerLayer, { store }));
    const strip = () => document.querySelector(".ruler-hit") as HTMLElement;
    const finger = (type: string, id: number, x: number, y: number) =>
      act(() => {
        const ev = new PointerEvent(type, { pointerId: id, pointerType: "touch", bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1, width: 20, height: 20 });
        Object.defineProperty(ev, "timeStamp", { value: clock });
        clock += 8;
        strip().dispatchEvent(ev);
      });
    // A finger on the body moves the ruler down 30 (past its slop first).
    finger("pointerdown", 21, 400, 400);
    finger("pointermove", 21, 400, 410);
    finger("pointermove", 21, 400, 440);
    const moved = s().ruler.pose!;
    expect(moved).toEqual({ x: 400, y: 430, angle: 0 });
    const edgeY = moved.y - 55;
    // The pen goes down in the band above the upper edge: the stroke is guided.
    const pts = wavy(200, edgeY - 10);
    down(pts[0]);
    expect(s().rulerGuiding).toBe(true);
    finger("pointermove", 21, 400, 470);
    expect(s().ruler.pose).toEqual(moved);
    moveTo(pts.slice(1));
    up(pts[pts.length - 1]);
    const ink = added();
    expect(ink).toHaveLength(1);
    expect(onEdge(ink[0], edgeY)).toBe(true);
    // The finger never lifted: it moves nothing more until it does.
    finger("pointermove", 21, 400, 500);
    expect(s().ruler.pose).toEqual(moved);
    finger("pointerup", 21, 400, 500);
    // A new touch moves the ruler again (a fingertip right after the pen is accepted on the ruler).
    finger("pointerdown", 22, 400, 430);
    finger("pointermove", 22, 400, 440);
    finger("pointermove", 22, 400, 470);
    expect(s().ruler.pose).toEqual({ x: 400, y: 460, angle: 0 });
    finger("pointerup", 22, 400, 470);
  });

  it("shows the length beside a guided stroke while it is drawn, and not beside an unguided one", async () => {
    await mount();
    rulerOn();
    const pts = wavy(200, EDGE_Y - 10);
    down(pts[0]);
    moveTo(pts.slice(1));
    await frame();
    expect(texts.some((t) => / cm$/.test(t))).toBe(true);
    up(pts[pts.length - 1]);
    await frame();
    texts.length = 0;
    const free = wavy(200, EDGE_Y - 40);
    down(free[0]);
    moveTo(free.slice(1));
    await frame();
    expect(texts.some((t) => / cm$/.test(t))).toBe(false);
    up(free[free.length - 1]);
  });
});
