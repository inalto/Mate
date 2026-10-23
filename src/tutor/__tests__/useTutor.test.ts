import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Element, Settings, Verdict } from "../../model/types";
import type { EditorStore } from "../../stores/editor";
import { el } from "../../tools/__tests__/fixtures";
import type { ElementsChange } from "../types";
import { createAttemptLedger, type PipelineDeps } from "../pipeline";
import { createTutorSession, MAX_PENDING_PER_PAGE } from "../useTutor";

const verdict: Verdict = {
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
};

/** Glyph of 8 points so it passes the minimum-ink filter. */
const glyph = (id: string, x: number, y: number): Element =>
  el(id, Array.from({ length: 8 }, (_, i) => [x + i * 4, i % 2 ? y + 30 : y] as [number, number]));

function fakeStore(elements: Element[]) {
  let state = { loadedPageId: "pg" as string | null, elements: new Map(elements.map((e) => [e.id, e])) };
  const subs = new Set<(s: typeof state, p: typeof state) => void>();
  const changes = new Set<(c: ElementsChange) => void>();
  const store = {
    getState: () => state,
    subscribe: (cb: (s: typeof state, p: typeof state) => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    onElementsChanged: (cb: (c: ElementsChange) => void) => {
      changes.add(cb);
      return () => changes.delete(cb);
    },
  };
  return {
    store: store as unknown as EditorStore,
    add(e: Element) {
      state = { ...state, elements: new Map(state.elements).set(e.id, e) };
      for (const c of changes) c({ added: [e.id], updated: [], removed: [] });
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
    sleep: async () => {},
    now: () => now,
    warn: () => {},
    attempts: createAttemptLedger(),
  };
  const advance = async (ms: number) => {
    now += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > now) break;
      timers.shift();
      t.fn();
    }
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const deps = {
    pipeline,
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
  return { deps, advance, pen: () => pen!, pipeline };
}

describe("tutor session", () => {
  it("checks a new group after pen-up and exposes the result", async () => {
    const on = { ...DEFAULT_SETTINGS, aiConsent: true };
    let release!: (v: Verdict) => void;
    const recognize = vi.fn(() => new Promise<Verdict>((r) => (release = r)));
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
    await h.advance(1);
    expect(recognize).toHaveBeenCalledTimes(1);
    const gid = session.getView().inFlight.values().next().value!;
    expect(gid).toBeTruthy();

    release(verdict);
    await h.advance(0);
    expect(session.getView().inFlight.size).toBe(0);
    expect(session.getView().recognitions.get(gid)?.latex).toBe("x=2");
    session.dispose();
  });

  it("sends nothing without consent and caps pending checks per page", async () => {
    const recognize = vi.fn(() => new Promise<Verdict>(() => {}));
    const off = harness({ ...DEFAULT_SETTINGS, aiConsent: null }, recognize);
    const fs = fakeStore([]);
    const s1 = createTutorSession(fs.store, off.deps);
    fs.add(glyph("a", 0, 0));
    off.pen().up();
    await off.advance(2000);
    expect(recognize).not.toHaveBeenCalled();
    s1.dispose();

    const on = harness({ ...DEFAULT_SETTINGS, aiConsent: true }, recognize);
    const fs2 = fakeStore([]);
    const s2 = createTutorSession(fs2.store, on.deps);
    for (let i = 0; i < MAX_PENDING_PER_PAGE + 5; i++) fs2.add(glyph(`g${i}`, 0, i * 400));
    on.pen().up();
    await on.advance(2000);
    expect(recognize).toHaveBeenCalledTimes(MAX_PENDING_PER_PAGE);
    expect(s2.getView().inFlight.size).toBe(MAX_PENDING_PER_PAGE);
    expect([...s2.getView().unchecked.values()].filter((u) => u.kind === "busy")).toHaveLength(5);
    s2.dispose();
  });
});
