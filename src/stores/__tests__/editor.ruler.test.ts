// The ruler's view state: per pane, session-long, never an element (no history, no queue writes).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => loaded.els) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { visibleSpan } from "../../ruler/pose";
import { createEditorStore, type EditorStore } from "../editor";
import { useNotebookStore } from "../notebook";

let store: EditorStore;
const s = () => store.getState();

beforeEach(() => {
  vi.clearAllMocks();
  store = createEditorStore();
  s().setViewport({ width: 800, height: 600 });
});

describe("ruler state", () => {
  it("starts off with no pose and not guiding", () => {
    expect(s().ruler).toEqual({ on: false, pose: null });
    expect(s().rulerGuiding).toBe(false);
  });

  it("turning it on places a pose that is visible", () => {
    s().toggleRuler();
    expect(s().ruler.on).toBe(true);
    const pose = s().ruler.pose!;
    expect(visibleSpan(pose, s().camera, s().viewport)).not.toBeNull();
  });

  it("hiding keeps the pose and showing again reuses it", () => {
    s().toggleRuler();
    s().setRulerPose({ x: 10, y: 20, angle: 30 });
    s().toggleRuler();
    expect(s().ruler).toEqual({ on: false, pose: { x: 10, y: 20, angle: 30 } });
    s().toggleRuler();
    expect(s().ruler).toEqual({ on: true, pose: { x: 10, y: 20, angle: 30 } });
  });

  it("showing it after the camera moved far away brings it into view", () => {
    s().toggleRuler();
    const old = s().ruler.pose!;
    s().setCamera({ x: 5000, y: 5000, z: 1 });
    s().toggleRuler();
    s().toggleRuler();
    const pose = s().ruler.pose!;
    expect(pose).not.toEqual(old);
    expect(visibleSpan(pose, s().camera, s().viewport)).not.toBeNull();
  });

  it("with no viewport area it still turns on, with the default pose", () => {
    const fresh = createEditorStore();
    fresh.getState().toggleRuler();
    expect(fresh.getState().ruler.on).toBe(true);
    expect(fresh.getState().ruler.pose).not.toBeNull();
  });

  it("loadPage leaves the ruler as it was", async () => {
    useNotebookStore.setState({ loaded: true });
    s().toggleRuler();
    s().setRulerPose({ x: 1, y: 2, angle: 3 });
    s().setRulerGuiding(true);
    await s().loadPage("pg");
    expect(s().ruler).toEqual({ on: true, pose: { x: 1, y: 2, angle: 3 } });
    expect(s().rulerGuiding).toBe(true);
  });

  it("is not an edit: no history, nothing on the elements queue", () => {
    s().toggleRuler();
    s().setRulerPose({ x: 5, y: 5, angle: 45 });
    s().setRulerGuiding(true);
    s().toggleRuler();
    expect(s().canUndo).toBe(false);
    expect(queue.enqueueUpsert).not.toHaveBeenCalled();
    expect(queue.enqueueDelete).not.toHaveBeenCalled();
    expect(queue.flushAll).not.toHaveBeenCalled();
  });

  it("setters do not notify when nothing changes", () => {
    s().setRulerPose({ x: 1, y: 2, angle: 3 });
    s().setRulerGuiding(true);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    s().setRulerPose({ x: 1, y: 2, angle: 3 });
    s().setRulerGuiding(true);
    off();
    expect(listener).not.toHaveBeenCalled();
  });

  it("two stores do not share ruler state", () => {
    const other = createEditorStore();
    s().toggleRuler();
    expect(other.getState().ruler).toEqual({ on: false, pose: null });
  });
});
