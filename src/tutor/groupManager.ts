// Stroke-group settle state machine: decides when a segmented region is ready to be recognised.
// Regions are dirtied by membership changes and edits; a dirty region fires `settle` 1200 ms after
// the last pen-up, `watchdog` after 15 s of continuous pen-down, or `early` as soon as the writer
// moves on to a region out of its merge reach. Timers are injected (no real clock in tests).
import type { Element } from "../model/types";
import { beyondMergeReach, DEFAULT_SEGMENTATION, type SegmentationConfig } from "./segmentation";
import type { ElementsChange, FireReason, Region } from "./types";

export const SETTLE_DELAY_MS = 1200;
export const IN_FLIGHT_RETRY_MS = 200;
export const WATCHDOG_MS = 15_000;

export interface GroupManagerDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onFire(group: Region, reason: FireReason): void;
  /** A region was dropped (member removed, or replaced by re-segmentation): its result is stale. */
  onInvalidate?(regionId: string): void;
  cfg?: SegmentationConfig;
}

export interface GroupManager {
  /** Latest segmentation; new or re-membered regions become dirty (`clean: true` seeds them clean). */
  setRegions(regions: Region[], opts?: { clean?: boolean }): void;
  notePenDown(): void;
  notePenUp(): void;
  /** A committed stroke: dirties its region once segmentation has placed it. */
  noteStrokeCommitted(el: Pick<Element, "id">): void;
  /** Plain ids are treated as updates; a change object's `removed` ids drop their regions. */
  noteElementsChanged(change: string[] | ElementsChange): void;
  markInFlight(regionId: string, inFlight: boolean): void;
  dispose(): void;
}

interface Entry {
  region: Region;
  dirty: boolean;
  dirtiedAt: number;
}

export function createGroupManager(deps: GroupManagerDeps): GroupManager {
  const cfg = deps.cfg ?? DEFAULT_SEGMENTATION;
  let entries = new Map<string, Entry>();
  let byElement = new Map<string, string>();
  const inFlight = new Set<string>();
  let penDown = false;
  let penUpAt: number | null = null;
  let settleTimer: unknown;
  let watchdogTimer: unknown;
  let disposed = false;

  const clearSettle = () => {
    if (settleTimer !== undefined) deps.clearTimer(settleTimer);
    settleTimer = undefined;
  };
  const clearWatchdog = () => {
    if (watchdogTimer !== undefined) deps.clearTimer(watchdogTimer);
    watchdogTimer = undefined;
  };

  const dirtyEntries = () => [...entries.values()].filter((e) => e.dirty);

  /** Fire every dirty region not in flight; true when some dirty region was held. */
  function fireDirty(reason: FireReason): boolean {
    let held = false;
    for (const e of dirtyEntries()) {
      if (disposed) return false;
      if (inFlight.has(e.region.regionId)) {
        held = true;
        continue;
      }
      e.dirty = false;
      deps.onFire(e.region, reason);
    }
    return held;
  }

  function onSettle(): void {
    settleTimer = undefined;
    if (disposed || penDown) return;
    if (fireDirty("settle") && !disposed && !penDown) settleTimer = deps.setTimer(onSettle, IN_FLIGHT_RETRY_MS);
  }

  function schedule(): void {
    clearSettle();
    if (disposed || penDown) return;
    const dirty = dirtyEntries();
    if (dirty.length === 0) return;
    const base = penUpAt ?? Math.max(...dirty.map((e) => e.dirtiedAt));
    settleTimer = deps.setTimer(onSettle, Math.max(0, base + SETTLE_DELAY_MS - deps.now()));
  }

  function armWatchdog(): void {
    clearWatchdog();
    watchdogTimer = deps.setTimer(() => {
      watchdogTimer = undefined;
      if (disposed || !penDown) return;
      fireDirty("watchdog");
      if (!disposed && penDown) armWatchdog();
    }, WATCHDOG_MS);
  }

  /** Regions dirty before this change that the writer has now left behind fire immediately. */
  function earlyFire(prevDirty: Set<string>, changed: Set<string>): void {
    if (changed.size === 0) return;
    const fresh = [...changed].map((id) => entries.get(id)).filter((e): e is Entry => !!e);
    for (const id of prevDirty) {
      const a = entries.get(id);
      if (!a || !a.dirty || changed.has(id) || inFlight.has(id)) continue;
      if (fresh.some((b) => beyondMergeReach(a.region, b.region, cfg))) {
        a.dirty = false;
        deps.onFire(a.region, "early");
        if (disposed) return;
      }
    }
  }

  const dirtySet = () => new Set(dirtyEntries().map((e) => e.region.regionId));

  function markDirty(e: Entry): void {
    e.dirty = true;
    e.dirtiedAt = deps.now();
  }

  function drop(regionId: string): void {
    const e = entries.get(regionId);
    if (!e) return;
    entries.delete(regionId);
    for (const id of e.region.elementIds) if (byElement.get(id) === regionId) byElement.delete(id);
    deps.onInvalidate?.(regionId);
  }

  function noteElementsChanged(change: string[] | ElementsChange): void {
    if (disposed) return;
    const c: ElementsChange = Array.isArray(change) ? { added: [], updated: change, removed: [] } : change;
    const prevDirty = dirtySet();
    for (const id of c.removed) {
      const rid = byElement.get(id);
      if (rid) drop(rid);
    }
    const changed = new Set<string>();
    for (const id of [...c.added, ...c.updated]) {
      const rid = byElement.get(id);
      const e = rid ? entries.get(rid) : undefined;
      if (!rid || !e || changed.has(rid)) continue;
      markDirty(e);
      changed.add(rid);
    }
    earlyFire(prevDirty, changed);
    schedule();
  }

  return {
    setRegions(regions, opts) {
      if (disposed) return;
      const prevDirty = dirtySet();
      const next = new Map<string, Entry>();
      const changed = new Set<string>();
      for (const region of regions) {
        const old = entries.get(region.regionId);
        if (old) {
          next.set(region.regionId, { ...old, region });
        } else {
          next.set(region.regionId, { region, dirty: !opts?.clean, dirtiedAt: deps.now() });
          if (!opts?.clean) changed.add(region.regionId);
        }
      }
      const dropped = [...entries.keys()].filter((id) => !next.has(id));
      entries = next;
      byElement = new Map();
      for (const r of regions) for (const id of r.elementIds) byElement.set(id, r.regionId);
      for (const id of dropped) deps.onInvalidate?.(id);
      earlyFire(prevDirty, changed);
      schedule();
    },

    notePenDown() {
      if (disposed) return;
      penDown = true;
      clearSettle();
      if (watchdogTimer === undefined) armWatchdog();
    },

    notePenUp() {
      if (disposed) return;
      penDown = false;
      penUpAt = deps.now();
      clearWatchdog();
      schedule();
    },

    noteStrokeCommitted(el) {
      noteElementsChanged([el.id]);
    },

    noteElementsChanged,

    markInFlight(regionId, flying) {
      if (disposed) return;
      if (flying) inFlight.add(regionId);
      else {
        inFlight.delete(regionId);
        if (settleTimer === undefined) schedule();
      }
    },

    dispose() {
      disposed = true;
      clearSettle();
      clearWatchdog();
      entries.clear();
      byElement.clear();
      inFlight.clear();
    },
  };
}
