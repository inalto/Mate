// Live tutor wiring for one editor pane: segments the page's ink, settles groups with the group
// manager and runs the recognition pipeline on each settled group. Exposes what the overlay
// (recognitions, in-flight groups, groups that couldn't be checked) needs to draw.
import { useEffect } from "react";
import { create } from "zustand";
import { getRecognitions } from "../ipc/recognition";
import type { Recognition, Settings } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";
import { sessionAttempts } from "./attempts";
import { tutorActive, useAiStatus } from "./aiStatus";
import { createGroupManager, type GroupManager } from "./groupManager";
import { defaultPipelineDeps, revisionOf, runRecognition, type PipelineDeps, type RecognitionOutcome, type UncheckedKind } from "./pipeline";
import { segmentPage } from "./segmentation";
import type { ElementsChange, Region } from "./types";

/** Recognitions in flight or waiting for a slot, per page. */
export const MAX_PENDING_PER_PAGE = 50;
/** Element changes are collected for this long before the page is re-segmented. */
export const RESEGMENT_BATCH_MS = 50;
/** A group refused because too many checks were pending is tried again after this delay. */
export const BUSY_RETRY_MS = 5_000;

export interface UncheckedGroup {
  kind: UncheckedKind | "busy";
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

export const EMPTY_TUTOR_VIEW: TutorView = { pageId: null, recognitions: new Map(), inFlight: new Set(), unchecked: new Map(), regions: new Map() };

export interface TutorSessionDeps {
  pipeline?: PipelineDeps;
  settings?: () => Settings;
  /** A key is stored for the provider (`get_ai_status`); defaults to the cached status. */
  aiConfigured?: () => boolean | null;
  loadRecognitions?: (pageId: string) => Promise<Recognition[]>;
  /** Pen events source; defaults to window pointer events on a canvas. Returns an unsubscribe. */
  watchPen?: (down: () => void, up: () => void) => () => void;
  segment?: typeof segmentPage;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  now?: () => number;
}

export interface TutorSession {
  getView(): TutorView;
  subscribe(cb: () => void): () => void;
  /**
   * The user asked about this group: check it (also in "onask" mode) on the normal settle schedule.
   * `retry` also forgets earlier failed attempts ("Try again"). False when the group is unknown.
   */
  check(groupId: string, opts?: { retry?: boolean }): boolean;
  /** Replace a shown verdict (e.g. after "Mark as correct"); ignored for unknown groups. */
  setRecognition(rec: Recognition): void;
  /** Consent, the tutor switch or the key status may have changed: start or stop the tutor. */
  reactivate(): void;
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

/** Merges change batches; an id removed in a later batch is only reported as removed. */
function mergeChanges(a: ElementsChange, b: ElementsChange): ElementsChange {
  const removed = new Set([...a.removed, ...b.removed]);
  const added = new Set([...a.added, ...b.added].filter((id) => !removed.has(id)));
  const updated = new Set([...a.updated, ...b.updated].filter((id) => !removed.has(id) && !added.has(id)));
  return { added: [...added], updated: [...updated], removed: [...removed] };
}

/** One session per editor store; follows the store's loaded page. */
export function createTutorSession(store: EditorStore, deps: TutorSessionDeps = {}): TutorSession {
  const pipeline = deps.pipeline ?? defaultPipelineDeps;
  const settings = deps.settings ?? (() => useSettingsStore.getState().settings);
  const load = deps.loadRecognitions ?? getRecognitions;
  const aiConfigured = deps.aiConfigured ?? (() => useAiStatus.getState().configured);
  /** Nothing is segmented, shown or sent unless consent, the tutor switch and a key all hold. */
  const isActive = () => tutorActive(settings(), aiConfigured());
  let active = false;
  const segment = deps.segment ?? segmentPage;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const listeners = new Set<() => void>();
  let view: TutorView = EMPTY_TUTOR_VIEW;
  let manager: GroupManager | null = null;
  let pageToken = 0;
  let penIsDown = false;
  let disposed = false;
  let pendingChange: ElementsChange | null = null;
  let batchTimer: unknown;
  const retryTimers = new Map<string, unknown>();
  /** Groups the user asked about: checked even in "onask" mode. */
  const requested = new Set<string>();
  /**
   * Verdicts of groups that vanished because their membership changed (e.g. a dot joined them).
   * If the same membership comes back with its ink untouched, the verdict is shown again and the
   * group is not re-sent. Entries go when any member's ink changes.
   */
  const stash = new Map<string, Recognition>();
  const STASH_LIMIT = 200;

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
    const regions = segment(elementsNow());
    emit({ regions: new Map(regions.map((r) => [r.regionId, r])) });
    return regions;
  }

  function clearTimers(): void {
    if (batchTimer !== undefined) clearTimer(batchTimer);
    batchTimer = undefined;
    pendingChange = null;
    for (const h of retryTimers.values()) clearTimer(h);
    retryTimers.clear();
    requested.clear();
    stash.clear();
  }

  function flushChanges(): void {
    batchTimer = undefined;
    const change = pendingChange;
    pendingChange = null;
    if (!manager || disposed || !change) return;
    const touched = new Set([...change.updated, ...change.removed]);
    for (const [id, r] of stash) if (r.elementIds.some((e) => touched.has(e))) stash.delete(id);
    const regions = resegment();
    const back = new Set<string>();
    const restored = new Map(view.recognitions);
    for (const r of regions) {
      const old = stash.get(r.regionId);
      if (!old || restored.has(r.regionId) || old.elementIds.length !== r.elementIds.length) continue;
      const members = new Set(r.elementIds);
      if (!old.elementIds.every((e) => members.has(e))) continue;
      stash.delete(r.regionId);
      requested.delete(r.regionId);
      restored.set(r.regionId, old);
      back.add(r.regionId);
    }
    if (back.size > 0) emit({ recognitions: restored });
    manager.setRegions(regions, { clean: back });
    manager.noteElementsChanged(change);
  }

  /**
   * Try a group again later (transient failure or too many pending), if it still exists then. The
   * retry re-dirties the group, so it goes through the settle schedule (held while the pen is down).
   */
  function scheduleRetry(token: number, regionId: string, ms: number, asked: boolean): void {
    const old = retryTimers.get(regionId);
    if (old !== undefined) clearTimer(old);
    retryTimers.set(
      regionId,
      setTimer(() => {
        retryTimers.delete(regionId);
        if (disposed || token !== pageToken) return;
        if (!view.regions.has(regionId) || view.inFlight.has(regionId)) return;
        if (asked) requested.add(regionId);
        manager?.redirty(regionId);
      }, ms),
    );
  }

  function fire(token: number, region: Region): void {
    const s = settings();
    if (!s.tutorEnabled || s.aiConsent !== true) return;
    const asked = requested.has(region.regionId);
    // "onask": nothing is sent until the user asks about this group.
    if (s.tutorMode === "onask" && !asked) return;
    if (view.inFlight.has(region.regionId)) return;
    if (view.inFlight.size >= MAX_PENDING_PER_PAGE) {
      emit({ unchecked: withMap(view.unchecked, (m) => m.set(region.regionId, { kind: "busy", reason: "Too many checks are waiting. This note will be checked shortly." })) });
      scheduleRetry(token, region.regionId, BUSY_RETRY_MS, asked);
      return;
    }
    requested.delete(region.regionId);
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
        const id = region.regionId;
        const patch: Partial<TutorView> = { inFlight: withSet(view.inFlight, (x) => x.delete(id)) };
        // The group was re-segmented or erased meanwhile: its result no longer describes the page.
        const alive = view.regions.has(id);
        if (alive && out?.status === "checked") {
          const members = new Set(out.recognition.elementIds);
          patch.recognitions = withMap(view.recognitions, (x) => {
            for (const [gid, r] of x) if (gid !== id && r.elementIds.some((e) => members.has(e))) x.delete(gid);
            x.set(id, out.recognition);
          });
        } else if (alive && out?.status === "unchecked") {
          patch.unchecked = withMap(view.unchecked, (x) => x.set(id, { kind: out.kind, reason: out.reason }));
          if (out.retryInMs !== undefined) scheduleRetry(token, id, out.retryInMs, asked);
        }
        emit(patch);
        m?.markInFlight(id, false);
      });
  }

  function openPage(pageId: string | null): void {
    pageToken++;
    manager?.dispose();
    manager = null;
    clearTimers();
    emit({ ...EMPTY_TUTOR_VIEW, pageId });
    active = isActive();
    if (!pageId || !active) return;
    const token = pageToken;
    const m = createGroupManager({
      now: deps.now ?? (() => Date.now()),
      setTimer,
      clearTimer,
      onFire: (region) => fire(token, region),
      onInvalidate: (regionId) => {
        if (token !== pageToken) return;
        const rec = view.recognitions.get(regionId);
        if (rec) {
          stash.delete(regionId);
          stash.set(regionId, rec);
          if (stash.size > STASH_LIMIT) stash.delete(stash.keys().next().value!);
        }
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
        // Results that arrived while loading are kept when they are newer than the stored ones.
        const merged = new Map(view.recognitions);
        for (const r of recs) {
          const cur = merged.get(r.strokeGroupId);
          if (!cur || cur.capturedAt < r.capturedAt) merged.set(r.strokeGroupId, r);
        }
        emit({ recognitions: merged });
      })
      .catch((e) => console.error("loading tutor results failed", e));
  }

  const unsubElements = store.onElementsChanged((change) => {
    if (!manager || disposed || !active) return;
    pendingChange = pendingChange ? mergeChanges(pendingChange, change) : change;
    if (batchTimer === undefined) batchTimer = setTimer(flushChanges, RESEGMENT_BATCH_MS);
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
    check(groupId, opts) {
      const region = view.regions.get(groupId);
      if (disposed || !manager) return false;
      if (!region) {
        // Not segmented yet (e.g. it reappears once a gesture dot is removed): check it when it does.
        requested.add(groupId);
        return false;
      }
      if (opts?.retry) {
        pipeline.attempts.reset(revisionOf(region, elementsNow()));
        const old = retryTimers.get(groupId);
        if (old !== undefined) clearTimer(old);
        retryTimers.delete(groupId);
      }
      requested.add(groupId);
      return manager.redirty(groupId);
    },
    reactivate() {
      if (disposed || isActive() === active) return;
      openPage(store.getState().loadedPageId);
    },
    setRecognition(rec) {
      if (disposed || rec.pageId !== view.pageId || !view.recognitions.has(rec.strokeGroupId)) return;
      emit({ recognitions: withMap(view.recognitions, (x) => x.set(rec.strokeGroupId, rec)) });
    },
    dispose() {
      disposed = true;
      pageToken++;
      clearTimers();
      manager?.dispose();
      manager = null;
      unsubElements();
      unsubStore();
      unsubPen();
      listeners.clear();
    },
  };
}

export type PaneIndex = 0 | 1;

interface TutorViewsState {
  /** The live tutor view of each editor pane (read by the overlay). */
  views: Record<PaneIndex, TutorView>;
  setView(pane: PaneIndex, view: TutorView): void;
}

/** Tutor views per pane. Components select only what they draw, so the editor does not re-render. */
export const useTutorViews = create<TutorViewsState>((set) => ({
  views: { 0: EMPTY_TUTOR_VIEW, 1: EMPTY_TUTOR_VIEW },
  setView: (pane, view) => set((s) => ({ views: { ...s.views, [pane]: view } })),
}));

/** The running session of each pane (for user requests from the overlay and the tutor card). */
const sessions = new Map<PaneIndex, TutorSession>();

/** Ask the pane's tutor to check a group now (also in "onask" mode). False when it can't. */
export const requestCheck = (pane: PaneIndex, groupId: string, opts?: { retry?: boolean }): boolean =>
  sessions.get(pane)?.check(groupId, opts) ?? false;

/** Show `rec` in every pane that has its page open. */
export function showRecognition(rec: Recognition): void {
  for (const s of sessions.values()) s.setRecognition(rec);
}

/**
 * Runs the live tutor for one pane and publishes its view to `useTutorViews`. Returns nothing, so
 * the calling component never re-renders because of tutor activity.
 */
export function useTutor(store: EditorStore, pane: PaneIndex): void {
  useEffect(() => {
    useAiStatus.getState().ensure();
    const session = createTutorSession(store);
    sessions.set(pane, session);
    const publish = () => useTutorViews.getState().setView(pane, session.getView());
    const unsub = session.subscribe(publish);
    publish();
    // A changed provider, model or consent may fix a rejected key: allow checks again.
    const unsubSettings = useSettingsStore.subscribe((s, prev) => {
      const a = s.settings;
      const b = prev.settings;
      if (a.aiProvider !== b.aiProvider || a.aiModel !== b.aiModel || a.aiConsent !== b.aiConsent) sessionAttempts.clearAuthBlock();
      if (a.aiProvider !== b.aiProvider || a.aiConsent !== b.aiConsent) void useAiStatus.getState().refresh();
      session.reactivate();
    });
    const unsubStatus = useAiStatus.subscribe(() => session.reactivate());
    return () => {
      unsub();
      unsubSettings();
      unsubStatus();
      if (sessions.get(pane) === session) sessions.delete(pane);
      session.dispose();
      useTutorViews.getState().setView(pane, EMPTY_TUTOR_VIEW);
    };
  }, [store, pane]);
}
