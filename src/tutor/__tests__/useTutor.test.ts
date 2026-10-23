import { describe, expect, it, vi } from "vitest";
import type { RecognizeResult } from "../../ipc/recognize";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Element, Settings } from "../../model/types";
import type { EditorStore } from "../../stores/editor";
import { el } from "../../tools/__tests__/fixtures";
import { createAttemptLedger, RETRY_DELAY_MS, type PipelineDeps } from "../pipeline";
import { SETTLE_DELAY_MS } from "../groupManager";
import { segmentPage } from "../segmentation";
import type { ElementsChange } from "../types";
import { createTutorSession, MAX_PENDING_PER_PAGE, RESEGMENT_BATCH_MS } from "../useTutor";

const result: RecognizeResult = {
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

/** Glyph of 8 points so it passes the minimum-ink filter. */
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
  const emit = (c: ElementsChange) => {
    for (const cb of changes) cb(c);
  };
  return {
    store: store as unknown as EditorStore,
    add(e: Element) {
      state = { ...state, elements: new Map(state.elements).set(e.id, e) };
      emit({ added: [e.id], updated: [], removed: [] });
    },
    remove(id: string) {
      const m = new Map(state.elements);
      m.delete(id);
      state = { ...state, elements: m };
      emit({ added: [], updated: [], removed: [id] });
    },
  };
}

function harness(settings: Settings, recognize: PipelineDeps["recognize"]) {
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let now = 0;
  let id = 0;
  let pen: { down: () => void; up: () => void } | null = null;
  const segment = vi.fn(segmentPage);
  const pipeline: PipelineDeps = {
    recognize,
    upsert: vi.fn(async () => "stored" as const),
    capture: async () => ({ png: new Uint8Array([1]), bounds: { x: 0, y: 0, width: 1, height: 1 }, width: 1, height: 1 }),
    now: () => now,
    warn: () => {},
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
    segment,
    settings: () => settings,
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
  return { deps, advance, pen: () => pen!, pipeline, segment };
}

const on = { ...DEFAULT_SETTINGS, aiConsent: true };

describe("tutor session", () => {
  it("checks a new group after pen-up and exposes the result", async () => {
    let release!: (v: RecognizeResult) => void;
    const recognize = vi.fn(() => new Promise<RecognizeResult>((r) => (release = r)));
    const h = harness(on, recognize);
    const fs = fakeStore([glyph("old", 0, 0)]);
    const session = createTutorSession(fs.store, h.deps);
    await h.advance(5000);
    // Existing ink is never sent on open.
    expect(recognize).not.toHaveBeenCalled();

    h.pen().down();
    fs.add(glyph("new", 0, 400));
    h.pen().up();
    await h.advance(1199);
    expect(recognize).not.toHaveBeenCalled();
    await h.advance(RESEGMENT_BATCH_MS + 1);
    expect(recognize).toHaveBeenCalledTimes(1);
    const gid = session.getView().inFlight.values().next().value!;
    expect(gid).toBeTruthy();

    release(result);
    await h.advance(0);
    expect(session.getView().inFlight.size).toBe(0);
    expect(session.getView().recognitions.get(gid)?.latex).toBe("x=2");
    session.dispose();
  });

  it("re-segments once per batch of rapid changes", async () => {
    const h = harness(on, vi.fn(() => new Promise<RecognizeResult>(() => {})));
    const fs = fakeStore([]);
    const session = createTutorSession(fs.store, h.deps);
    h.segment.mockClear();
    for (let i = 0; i < 20; i++) fs.add(glyph(`g${i}`, i * 40, 0));
    expect(h.segment).not.toHaveBeenCalled();
    await h.advance(RESEGMENT_BATCH_MS);
    expect(h.segment).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("stale_group_result_is_not_shown", async () => {
    let release!: (v: RecognizeResult) => void;
    const recognize = vi.fn(() => new Promise<RecognizeResult>((r) => (release = r)));
    const h = harness(on, recognize);
    const fs = fakeStore([]);
    const session = createTutorSession(fs.store, h.deps);
    fs.add(glyph("a", 0, 0));
    h.pen().up();
    await h.advance(2000);
    expect(recognize).toHaveBeenCalledTimes(1);
    const gid = session.getView().inFlight.values().next().value!;
    // The group is erased while its check is in flight.
    fs.remove("a");
    await h.advance(RESEGMENT_BATCH_MS);
    expect(session.getView().regions.has(gid)).toBe(false);
    release(result);
    await h.advance(0);
    expect(session.getView().recognitions.size).toBe(0);
    expect(session.getView().inFlight.size).toBe(0);
    session.dispose();
  });

  it("a transient failure shows unchecked and retries on a later settle", async () => {
    const recognize = vi.fn(async (): Promise<RecognizeResult> => Promise.reject({ kind: "network", message: "Could not reach the AI service (no connection)." }));
    const h = harness(on, recognize);
    const fs = fakeStore([]);
    const session = createTutorSession(fs.store, h.deps);
    fs.add(glyph("a", 0, 0));
    h.pen().up();
    await h.advance(2000);
    expect(recognize).toHaveBeenCalledTimes(1);
    expect([...session.getView().unchecked.values()][0]).toMatchObject({ kind: "network" });
    expect(session.getView().inFlight.size).toBe(0);
    // Retries re-dirty the group, so they go through the settle delay (held while the pen is down).
    await h.advance(RETRY_DELAY_MS);
    expect(recognize).toHaveBeenCalledTimes(1);
    await h.advance(SETTLE_DELAY_MS);
    expect(recognize).toHaveBeenCalledTimes(2);
    await h.advance(RETRY_DELAY_MS * 2 + SETTLE_DELAY_MS);
    expect(recognize).toHaveBeenCalledTimes(3);
    // Three attempts per revision, then it stops.
    await h.advance(RETRY_DELAY_MS * 10);
    expect(recognize).toHaveBeenCalledTimes(3);
    session.dispose();
  });

  it("sends nothing without consent and caps pending checks per page", async () => {
    const recognize = vi.fn(() => new Promise<RecognizeResult>(() => {}));
    const off = harness({ ...DEFAULT_SETTINGS, aiConsent: null }, recognize);
    const fs = fakeStore([]);
    const s1 = createTutorSession(fs.store, off.deps);
    fs.add(glyph("a", 0, 0));
    off.pen().up();
    await off.advance(2000);
    expect(recognize).not.toHaveBeenCalled();
    s1.dispose();

    const h = harness(on, recognize);
    const fs2 = fakeStore([]);
    const s2 = createTutorSession(fs2.store, h.deps);
    for (let i = 0; i < MAX_PENDING_PER_PAGE + 5; i++) fs2.add(glyph(`g${i}`, 0, i * 400));
    h.pen().up();
    await h.advance(2000);
    expect(recognize).toHaveBeenCalledTimes(MAX_PENDING_PER_PAGE);
    expect(s2.getView().inFlight.size).toBe(MAX_PENDING_PER_PAGE);
    expect([...s2.getView().unchecked.values()].filter((u) => u.kind === "busy")).toHaveLength(5);
    s2.dispose();
  });
  it("onask_mode_checks_only_groups_the_user_asks_about", async () => {
    const recognize = vi.fn(async () => result);
    const h = harness({ ...on, tutorMode: "onask" }, recognize);
    const fs = fakeStore([]);
    const session = createTutorSession(fs.store, h.deps);
    fs.add(glyph("a", 0, 0));
    h.pen().down();
    h.pen().up();
    await h.advance(5000);
    expect(recognize).not.toHaveBeenCalled();
    const gid = [...session.getView().regions.keys()][0];
    expect(session.check(gid)).toBe(true);
    await h.advance(SETTLE_DELAY_MS);
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(session.getView().recognitions.get(gid)?.latex).toBe("x=2");
    expect(session.check("nope")).toBe(false);
    session.dispose();
  });

  it("loads_stored_verdicts_on_page_open", async () => {
    const h = harness(on, vi.fn(async () => result));
    const stored = { ...result, pageId: "pg", strokeGroupId: "g9", elementIds: ["x"], bounds: { x: 0, y: 0, width: 10, height: 10 }, capturedAt: 1, source: "auto" as const, userOverride: false, createdAt: "", updatedAt: "" };
    const load = vi.fn(async () => [stored]);
    const session = createTutorSession(fakeStore([]).store, { ...h.deps, loadRecognitions: load });
    await h.advance(0);
    expect(load).toHaveBeenCalledWith("pg");
    expect(session.getView().recognitions.get("g9")?.latex).toBe("x=2");
    // A user override replaces the shown verdict.
    session.setRecognition({ ...stored, correct: true, userOverride: true });
    expect(session.getView().recognitions.get("g9")?.userOverride).toBe(true);
    session.dispose();
  });

  it("retry_waits_for_pen_up", async () => {
    const recognize = vi.fn(async (): Promise<RecognizeResult> => Promise.reject({ kind: "network", message: "offline" }));
    const h = harness(on, recognize);
    const fs = fakeStore([]);
    const session = createTutorSession(fs.store, h.deps);
    fs.add(glyph("a", 0, 0));
    h.pen().down();
    h.pen().up();
    await h.advance(2000);
    expect(recognize).toHaveBeenCalledTimes(1);
    await h.advance(RETRY_DELAY_MS - 3000);
    h.pen().down();
    await h.advance(3000 + SETTLE_DELAY_MS);
    // The retry came due while the pen is down: it waits for pen-up.
    expect(recognize).toHaveBeenCalledTimes(1);
    h.pen().up();
    await h.advance(SETTLE_DELAY_MS);
    expect(recognize).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it("try_again_forgets_failed_attempts", async () => {
    const recognize = vi.fn(async (): Promise<RecognizeResult> => Promise.reject({ kind: "refused", message: "declined" }));
    const h = harness(on, recognize);
    const fs = fakeStore([]);
    const session = createTutorSession(fs.store, h.deps);
    fs.add(glyph("a", 0, 0));
    h.pen().up();
    await h.advance(2000);
    const gid = [...session.getView().regions.keys()][0];
    expect(session.getView().unchecked.get(gid)?.kind).toBe("refused");
    session.check(gid);
    await h.advance(2000);
    // Exhausted: a plain check does not call again.
    expect(recognize).toHaveBeenCalledTimes(1);
    session.check(gid, { retry: true });
    await h.advance(2000);
    expect(recognize).toHaveBeenCalledTimes(2);
    session.dispose();
  });
});
