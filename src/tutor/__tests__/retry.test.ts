import { beforeEach, describe, expect, it, vi } from "vitest";

// The store's `retry(groupId)` asks the pane's session for a check; the session itself is real below.
const session = vi.hoisted(() => ({ requestCheck: vi.fn(() => true) }));
vi.mock("../useTutor", async (orig) => ({ ...(await orig<typeof import("../useTutor")>()), ...session }));

import type { RecognizeResult } from "../../ipc/recognize";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Element, GroupBounds, Settings } from "../../model/types";
import type { EditorStore } from "../../stores/editor";
import { useTutorUi } from "../../stores/tutor";
import { el } from "../../tools/__tests__/fixtures";
import { createAttemptLedger, RETRY_DELAY_MS, revisionOf, type PipelineDeps } from "../pipeline";
import { SETTLE_DELAY_MS } from "../groupManager";
import { drawTutorTip, UNCHECKED_TIP, type TutorMarker } from "../overlay";
import { segmentPage } from "../segmentation";
import { createTutorSession, EMPTY_TUTOR_VIEW, RESEGMENT_BATCH_MS, useTutorViews, type TutorView } from "../useTutor";
import type { ElementsChange } from "../types";

const ok: RecognizeResult = {
  description: "",
  latex: "x=2",
  correct: true,
  domain: "algebra",
  errorNature: null,
  hint: null,
  explanation: null,
  nextSteps: null,
  focusSpan: null,
  illegible: false,
  transcription: null,
  code: "OK",
  kind: "math",
  provider: "anthropic",
  model: "m",
};

const glyph = (id: string, x: number, y: number): Element =>
  el(id, Array.from({ length: 8 }, (_, i) => [x + i * 4, i % 2 ? y + 30 : y] as [number, number]));

function fakeStore(elements: Element[]) {
  let state = { loadedPageId: "pg" as string | null, elements: new Map(elements.map((e) => [e.id, e])) };
  const changes = new Set<(c: ElementsChange) => void>();
  const store = {
    getState: () => state,
    subscribe: () => () => {},
    onElementsChanged: (cb: (c: ElementsChange) => void) => {
      changes.add(cb);
      return () => changes.delete(cb);
    },
  };
  return {
    store: store as unknown as EditorStore,
    add(e: Element) {
      state = { ...state, elements: new Map(state.elements).set(e.id, e) };
      for (const cb of changes) cb({ added: [e.id], updated: [], removed: [] });
    },
  };
}

function harness(settings: Settings, recognize: PipelineDeps["recognize"]) {
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let now = 0;
  let id = 0;
  let pen: { down: () => void; up: () => void } | null = null;
  const pipeline: PipelineDeps = {
    recognize,
    upsert: vi.fn(async () => "stored" as const),
    capture: async () => ({ png: new Uint8Array([1]), bounds: { x: 0, y: 0, width: 1, height: 1 }, width: 1, height: 1 }),
    now: () => now,
    warn: () => {},
    flushWrites: async () => {},
    toast: () => {},
    attempts: createAttemptLedger(),
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = Math.max(now, t.at);
      t.fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    now = end;
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const deps = {
    pipeline,
    segment: segmentPage,
    settings: () => settings,
    aiConfigured: () => true,
    loadRecognitions: async () => [],
    watchPen: (down: () => void, up: () => void) => {
      pen = { down, up };
      return () => {};
    },
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ at: now + ms, fn, id: ++id });
      return id;
    },
    clearTimer: (h: unknown) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return { deps, advance, pen: () => pen!, pipeline };
}

const on = { ...DEFAULT_SETTINGS, aiConsent: true };
const network = { kind: "network", message: "Could not reach the AI service (no connection)." };

describe("retry an unchecked group", () => {
  it("retry_clears_failure_and_requeues", async () => {
    // Three failed attempts, then the service answers.
    const recognize = vi.fn(async (): Promise<RecognizeResult> => {
      if (recognize.mock.calls.length <= 3) return Promise.reject(network);
      return ok;
    });
    const h = harness(on, recognize);
    const fs = fakeStore([]);
    const session = createTutorSession(fs.store, h.deps);
    fs.add(glyph("a", 0, 0));
    h.pen().up();
    await h.advance(RESEGMENT_BATCH_MS + SETTLE_DELAY_MS + RETRY_DELAY_MS * 10);
    expect(recognize).toHaveBeenCalledTimes(3);

    const gid = [...session.getView().regions.keys()][0];
    const region = session.getView().regions.get(gid)!;
    const rev = revisionOf(region, fs.store.getState().elements.values());
    expect(h.pipeline.attempts.count(rev)).toBe(3);
    expect(session.getView().unchecked.has(gid)).toBe(true);

    // Try again: the failure goes at once, the attempts reset, and one request follows the settle.
    expect(session.check(gid, { retry: true })).toBe(true);
    expect(session.getView().unchecked.has(gid)).toBe(false);
    expect(h.pipeline.attempts.count(rev)).toBe(0);
    await h.advance(SETTLE_DELAY_MS + 10);
    expect(recognize).toHaveBeenCalledTimes(4);
    await h.advance(RETRY_DELAY_MS * 10);
    expect(recognize).toHaveBeenCalledTimes(4);
    expect(session.getView().recognitions.has(gid)).toBe(true);
    session.dispose();
  });

  it("the store retries a group by id, with or without an open card", () => {
    useTutorViews.setState({
      views: {
        0: EMPTY_TUTOR_VIEW,
        1: { ...EMPTY_TUTOR_VIEW, pageId: "pg", unchecked: new Map([["g", { kind: "network", reason: "offline" }]]) } as TutorView,
      },
    });
    useTutorUi.setState({ card: null });
    session.requestCheck.mockClear();
    expect(useTutorUi.getState().retry("g")).toBe(true);
    expect(session.requestCheck).toHaveBeenCalledWith(1, "g", { retry: true });
    expect(useTutorUi.getState().retry("unknown")).toBe(false);
    expect(useTutorUi.getState().retry()).toBe(false); // no card open
    useTutorViews.setState({ views: { 0: EMPTY_TUTOR_VIEW, 1: EMPTY_TUTOR_VIEW } });
  });
});

describe("couldn't-check hover label", () => {
  beforeEach(() => vi.clearAllMocks());

  it("draws the tip beside an unchecked marker only", () => {
    const texts: string[] = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      fillRect: vi.fn(),
      fillText: (t: string) => texts.push(t),
      measureText: (t: string) => ({ width: t.length * 6 }) as TextMetrics,
      fillStyle: "",
      font: "",
      textBaseline: "alphabetic" as CanvasTextBaseline,
      textAlign: "start" as CanvasTextAlign,
    };
    const bounds: GroupBounds = { x: 10, y: 10, width: 40, height: 20 };
    const cam = { x: 0, y: 0, z: 1 };
    const unchecked: TutorMarker = { groupId: "g", kind: "unchecked", bounds };
    expect(drawTutorTip(ctx, unchecked, cam, 1)).not.toBeNull();
    expect(texts).toEqual([UNCHECKED_TIP]);
    // The card it opens offers "Try again", so the tip promises details, not a retry.
    expect(UNCHECKED_TIP).toBe("Couldn't check — tap for details");
    expect(drawTutorTip(ctx, { groupId: "g", kind: "tick", bounds }, cam, 1)).toBeNull();
    expect(texts).toHaveLength(1);
  });
});
