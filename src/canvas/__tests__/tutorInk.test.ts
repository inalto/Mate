// Tutor gestures against real ink: real hit-testing, real segmentation and the session's 50 ms
// re-segmentation batch (fake timers).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element, Recognition } from "../../model/types";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => loaded.els) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useTutorUi } from "../../stores/tutor";
import { el } from "../../tools/__tests__/fixtures";
import { createAttemptLedger, type PipelineDeps } from "../../tutor/pipeline";
import { segmentPage } from "../../tutor/segmentation";
import { createTutorSession, EMPTY_TUTOR_VIEW, useTutorViews, type TutorSession } from "../../tutor/useTutor";
import { createTutorInk } from "../tutorInk";

const on = { ...DEFAULT_SETTINGS, aiConsent: true, tutorEnabled: true };
/** A real glyph just written: 8 points zig-zagging over 28 × 30 units. */
const makeGlyph = () =>
  el("ink", Array.from({ length: 8 }, (_, i) => [100 + i * 4, i % 2 ? 130 : 100] as [number, number]), { width: 3, createdAt: new Date().toISOString() });
let glyph: Element;
const P = { x: 100, y: 100 }; // on the glyph's first point

let store: EditorStore;
let session: TutorSession;
let recognize: ReturnType<typeof vi.fn>;
let n = 0;

const dotAt = (p: { x: number; y: number }) => el(`dot-${++n}`, [[p.x, p.y]], { width: 3, createdAt: new Date().toISOString() });

async function setup() {
  glyph = makeGlyph();
  loaded.els = [glyph];
  useNotebookStore.setState({ loaded: true });
  store = createEditorStore();
  await store.getState().loadPage("pg");
  const gid = segmentPage([glyph])[0].regionId;
  const stored: Recognition = {
    pageId: "pg", strokeGroupId: gid, elementIds: ["ink"], bounds: { x: 100, y: 100, width: 28, height: 30 }, capturedAt: Date.now(),
    source: "auto", userOverride: false, provider: "anthropic", model: "m", createdAt: "", updatedAt: "",
    description: "", latex: "x=1", correct: false, domain: "algebra", errorNature: "slip", hint: "Look again.",
    explanation: null, nextSteps: null, focusSpan: null, illegible: false, transcription: null, code: "ALGEBRA", kind: "math",
  };
  recognize = vi.fn(async () => Promise.reject({ kind: "network", message: "offline" }));
  const pipeline: PipelineDeps = {
    recognize: recognize as unknown as PipelineDeps["recognize"],
    upsert: vi.fn(async () => "stored" as const),
    capture: async () => ({ png: new Uint8Array([1]), bounds: { x: 0, y: 0, width: 1, height: 1 }, width: 1, height: 1 }),
    now: () => Date.now(),
    warn: () => {},
    flushWrites: async () => {},
    toast: () => {},
    attempts: createAttemptLedger(),
  };
  session = createTutorSession(store, { pipeline, settings: () => on, aiConfigured: () => true, loadRecognitions: async () => [stored], watchPen: () => () => {} });
  const publish = () => useTutorViews.getState().setView(0, session.getView());
  session.subscribe(publish);
  publish();
  await vi.advanceTimersByTimeAsync(10);
  const ink = createTutorInk({ store, pageId: "pg", pane: 0, getSettings: () => on, isActive: () => true, now: () => Date.now() });
  return { gid, g: ink.gestures };
}

/** A quick pen tap at `p`, committed like CanvasView does when the gesture says so. */
async function tap(g: ReturnType<typeof createTutorInk>["gestures"], p: { x: number; y: number }) {
  const dot = dotAt(p);
  g.inkDown(p, p, vi.fn());
  await vi.advanceTimersByTimeAsync(60);
  const out = g.inkUp(dot.id);
  if (out === "commit") store.getState().addElement(dot);
  return out;
}

describe("tutor gestures on real ink", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTutorUi.setState({ card: null });
  });
  afterEach(() => {
    session.dispose();
    useTutorViews.setState({ views: { 0: EMPTY_TUTOR_VIEW, 1: EMPTY_TUTOR_VIEW } });
    vi.useRealTimers();
  });

  it("double_tap_on_real_ink_opens_ask_and_leaves_no_dots", async () => {
    const { gid, g } = await setup();
    expect(session.getView().recognitions.get(gid)?.latex).toBe("x=1");
    expect(await tap(g, P)).toBe("commit");
    // After the 50 ms batch the dot has joined the glyph: the group id changed.
    await vi.advanceTimersByTimeAsync(60);
    expect(session.getView().regions.has(gid)).toBe(false);
    expect(await tap(g, { x: 101, y: 101 })).toBe("discard");
    expect(useTutorUi.getState().card).toMatchObject({ groupId: gid, asking: true });
    // Zero new elements: the second dot was never drawn, the first one was removed.
    expect([...store.getState().elements.keys()]).toEqual(["ink"]);
    // The group is back with its stored verdict, nothing is re-sent, and the card stays open.
    await vi.advanceTimersByTimeAsync(5000);
    expect(session.getView().regions.has(gid)).toBe(true);
    expect(session.getView().recognitions.get(gid)?.latex).toBe("x=1");
    expect(recognize).not.toHaveBeenCalled();
    expect(useTutorUi.getState().card?.groupId).toBe(gid);
    // Removing the dot was one undo entry ("Ask gesture"): one undo brings it back.
    store.getState().undo();
    expect(store.getState().elements.size).toBe(2);
    store.getState().undo();
    expect(store.getState().elements.size).toBe(1);
  });

  it("tap_then_stroke_on_same_group_keeps_both", async () => {
    const { g } = await setup();
    expect(await tap(g, P)).toBe("commit");
    await vi.advanceTimersByTimeAsync(100);
    g.inkDown(P, P, vi.fn());
    g.inkMove({ x: 130, y: 104 });
    await vi.advanceTimersByTimeAsync(50);
    expect(g.inkUp("stroke")).toBe("commit");
    store.getState().addElement(el("stroke", [[100, 100], [130, 104]]));
    expect(store.getState().elements.size).toBe(3);
    expect(useTutorUi.getState().card).toBeNull();
  });

  it("edited_group_is_not_restored_and_is_rechecked", async () => {
    const { gid, g } = await setup();
    // Move the glyph (same membership, new ink): its verdict is stale and a recheck is pending.
    store.getState().select(["ink"]);
    store.getState().moveSelection(5, 0);
    store.getState().select([]);
    await vi.advanceTimersByTimeAsync(60);
    expect(session.getView().recognitions.has(gid)).toBe(false);
    // Double-tap inside the settle window: the group vanishes and re-forms with the same members.
    const Q = { x: P.x + 5, y: P.y };
    expect(await tap(g, Q)).toBe("commit");
    await vi.advanceTimersByTimeAsync(60);
    expect(await tap(g, { x: Q.x + 1, y: Q.y + 1 })).toBe("discard");
    await vi.advanceTimersByTimeAsync(60);
    expect(session.getView().regions.has(gid)).toBe(true);
    // No stale verdict comes back, and the pending recheck still happens.
    expect(session.getView().recognitions.has(gid)).toBe(false);
    expect(recognize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(recognize).toHaveBeenCalledTimes(1);
  });
});
