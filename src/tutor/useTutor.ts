// Live tutor wiring for one editor pane: segments the page's ink, settles groups with the group
// manager and runs the recognition pipeline on each settled group. Exposes what the overlay
// (recognitions, in-flight groups, groups that couldn't be checked) needs to draw.
import { useEffect, useState, useSyncExternalStore } from "react";
import { getRecognitions } from "../ipc/recognition";
import type { Recognition, Settings } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";
import { createGroupManager, type GroupManager } from "./groupManager";
import { defaultPipelineDeps, runRecognition, sessionAttempts, type PipelineDeps, type RecognitionOutcome } from "./pipeline";
import { segmentPage } from "./segmentation";
import type { Region } from "./types";

/** Recognitions in flight or waiting for a slot, per page. */
export const MAX_PENDING_PER_PAGE = 50;

export interface UncheckedGroup {
  kind: Extract<RecognitionOutcome, { status: "unchecked" }>["kind"] | "busy";
  reason: string;
}

export interface TutorView {
  pageId: string | null;
  /** Stored verdicts by stroke group id. */
  recognitions: ReadonlyMap<string, Recognition>;
  /** Groups being checked now (or queued). */
  inFlight: ReadonlySet<string>;
  /** Groups whose last check failed, with a sentence for the muted marker. */
  unchecked: ReadonlyMap<string, UncheckedGroup>;
  /** Current segmentation (bounds for markers). */
  regions: ReadonlyMap<string, Region>;
}

const EMPTY: TutorView = { pageId: null, recognitions: new Map(), inFlight: new Set(), unchecked: new Map(), regions: new Map() };

export interface TutorSessionDeps {
  pipeline?: PipelineDeps;
  settings?: () => Settings;
  loadRecognitions?: (pageId: string) => Promise<Recognition[]>;
  /** Pen events source; defaults to window pointer events on a canvas. Returns an unsubscribe. */
  watchPen?: (down: () => void, up: () => void) => () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  now?: () => number;
}

export interface TutorSession {
  getView(): TutorView;
  subscribe(cb: () => void): () => void;
  dispose(): void;
}

function windowPen(down: () => void, up: () => void): () => void {
  const onDown = (e: PointerEvent) => {
    if (e.target instanceof Element && e.target.closest("canvas")) down();
  };
  const onUp = () => up();
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
  return () => {
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);
  };
}

/** One session per editor store; follows the store's loaded page. */
export function createTutorSession(store: EditorStore, deps: TutorSessionDeps = {}): TutorSession {
  const pipeline = deps.pipeline ?? defaultPipelineDeps;
  const settings = deps.settings ?? (() => useSettingsStore.getState().settings);
  const load = deps.loadRecognitions ?? getRecognitions;
  const listeners = new Set<() => void>();
  let view: TutorView = EMPTY;
  let manager: GroupManager | null = null;
  let pageToken = 0;
  let penIsDown = false;
  let disposed = false;

  const emit = (next: Partial<TutorView>) => {
    view = { ...view, ...next };
    for (const l of listeners) l();
  };
  const withMap = <K, V>(m: ReadonlyMap<K, V>, f: (c: Map<K, V>) => void) => {
    const c = new Map(m);
    f(c);
    return c;
  };
  const withSet = <T>(s: ReadonlySet<T>, f: (c: Set<T>) => void) => {
    const c = new Set(s);
    f(c);
    return c;
  };

  const elementsNow = () => store.getState().elements.values();

  function resegment(): Region[] {
    const regions = segmentPage(elementsNow());
    emit({ regions: new Map(regions.map((r) => [r.regionId, r])) });
    return regions;
  }

  function fire(token: number, region: Region): void {
    const s = settings();
    if (!s.tutorEnabled || s.aiConsent !== true) return;
    if (view.inFlight.has(region.regionId)) return;
    if (view.inFlight.size >= MAX_PENDING_PER_PAGE) {
      emit({ unchecked: withMap(view.unchecked, (m) => m.set(region.regionId, { kind: "busy", reason: "Too many checks are waiting. This note will be checked later." })) });
      return;
    }
    const m = manager;
    m?.markInFlight(region.regionId, true);
    emit({
      inFlight: withSet(view.inFlight, (x) => x.add(region.regionId)),
      unchecked: withMap(view.unchecked, (x) => x.delete(region.regionId)),
    });
    void runRecognition(region, elementsNow(), [...view.recognitions.values()], s, pipeline)
      .catch((): RecognitionOutcome | null => null)
      .then((out) => {
        if (disposed || token !== pageToken) return;
        const patch: Partial<TutorView> = { inFlight: withSet(view.inFlight, (x) => x.delete(region.regionId)) };
        if (out?.status === "checked") {
          patch.recognitions = withMap(view.recognitions, (x) => x.set(region.regionId, out.recognition));
        } else if (out?.status === "unchecked") {
          patch.unchecked = withMap(view.unchecked, (x) => x.set(region.regionId, { kind: out.kind, reason: out.reason }));
        }
        emit(patch);
        m?.markInFlight(region.regionId, false);
      });
  }

  function openPage(pageId: string | null): void {
    pageToken++;
    manager?.dispose();
    manager = null;
    emit({ ...EMPTY, pageId });
    if (!pageId) return;
    const token = pageToken;
    const m = createGroupManager({
      now: deps.now ?? (() => Date.now()),
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
      onFire: (region) => fire(token, region),
      onInvalidate: (regionId) => {
        if (token !== pageToken) return;
        emit({
          recognitions: withMap(view.recognitions, (x) => x.delete(regionId)),
          unchecked: withMap(view.unchecked, (x) => x.delete(regionId)),
        });
      },
    });
    manager = m;
    if (penIsDown) m.notePenDown();
    // Existing ink starts clean: opening a page never sends anything by itself.
    m.setRegions(resegment(), { clean: true });
    load(pageId)
      .then((recs) => {
        if (disposed || token !== pageToken) return;
        emit({ recognitions: new Map(recs.map((r) => [r.strokeGroupId, r])) });
      })
      .catch((e) => console.error("loading tutor results failed", e));
  }

  const unsubElements = store.onElementsChanged((change) => {
    if (!manager || disposed) return;
    manager.setRegions(resegment());
    manager.noteElementsChanged(change);
  });
  const unsubStore = store.subscribe((s, prev) => {
    if (s.loadedPageId !== prev.loadedPageId) openPage(s.loadedPageId);
  });
  const unsubPen = (deps.watchPen ?? windowPen)(
    () => {
      penIsDown = true;
      manager?.notePenDown();
    },
    () => {
      if (!penIsDown) return;
      penIsDown = false;
      manager?.notePenUp();
    },
  );
  openPage(store.getState().loadedPageId);

  return {
    getView: () => view,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      disposed = true;
      pageToken++;
      manager?.dispose();
      manager = null;
      unsubElements();
      unsubStore();
      unsubPen();
      listeners.clear();
    },
  };
}

/** A tiny external store the hook reads; the session behind it lives in an effect. */
function createViewHolder() {
  let view = EMPTY;
  const listeners = new Set<() => void>();
  return {
    getView: () => view,
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    set(next: TutorView) {
      view = next;
      for (const l of listeners) l();
    },
  };
}

/** The live tutor for one editor pane. */
export function useTutor(store: EditorStore): TutorView {
  const [holder] = useState(createViewHolder);
  useEffect(() => {
    const session = createTutorSession(store);
    const unsub = session.subscribe(() => holder.set(session.getView()));
    holder.set(session.getView());
    // A changed provider, model or consent may fix a rejected key: allow checks again.
    const unsubSettings = useSettingsStore.subscribe((s, prev) => {
      const a = s.settings;
      const b = prev.settings;
      if (a.aiProvider !== b.aiProvider || a.aiModel !== b.aiModel || a.aiConsent !== b.aiConsent) sessionAttempts.clearAuthBlock();
    });
    return () => {
      unsub();
      unsubSettings();
      session.dispose();
      holder.set(EMPTY);
    };
  }, [store, holder]);
  return useSyncExternalStore(holder.subscribe, holder.getView);
}
