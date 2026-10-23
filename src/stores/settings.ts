import { create } from "zustand";
import { DEFAULT_SETTINGS } from "../model/constants";
import type { Settings } from "../model/types";
import { getSettings, onSettingsChanged, patchSettings } from "../ipc/settings";

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  /**
   * Merge `partial` into memory (and the theme attribute) at once; persistence is debounced and
   * serialised, and only the changed keys are written (`patch_settings`), so another window's
   * keys are never reverted. Resolves when a write containing this state has completed (rejects
   * if it failed).
   */
  update: (partial: Partial<Settings>) => Promise<void>;
}

/** Trailing quiet period before settings are written (a slider drag is one write). */
export const SETTINGS_WRITE_DEBOUNCE_MS = 300;

const applyTheme = (s: Settings) => {
  document.documentElement.dataset.theme = s.theme;
};

interface Waiter {
  resolve(): void;
  reject(err: unknown): void;
}

/** Keys changed locally and not yet handed to `patchSettings`, and the updates waiting for them. */
let pending: Partial<Settings> | null = null;
let waiters: Waiter[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
/** The patch currently being written (it may not be on disk yet when another window reloads). */
let inflight: Partial<Settings> | null = null;
/** The write loop in progress (at most one `patchSettings` in flight). */
let writing: Promise<void> | null = null;
/** Bumped after each completed local write (a reload that overlapped one fetches again). */
let writeGeneration = 0;
/** Bumped per reload so an older, slower reload never overwrites a newer one. */
let reloadSeq = 0;

/**
 * Write until nothing is pending: one call at a time, always every key changed so far (keys that
 * change during a write are written once afterwards). Rejects with the last write's error.
 */
function drain(): Promise<void> {
  if (writing) return writing;
  if (!pending) return Promise.resolve();
  writing = (async () => {
    let lastError: unknown = null;
    while (pending) {
      const patch = pending;
      const batch = waiters;
      pending = null;
      waiters = [];
      inflight = patch;
      try {
        await patchSettings(patch);
        lastError = null;
        for (const w of batch) w.resolve();
      } catch (err) {
        lastError = err;
        for (const w of batch) w.reject(err);
      } finally {
        inflight = null;
        writeGeneration++;
      }
    }
    if (lastError !== null) throw lastError;
  })().finally(() => {
    writing = null;
  });
  return writing;
}

/** Write any pending settings now (close flow, page unload); resolves once persisted. */
export async function flushSettings(): Promise<void> {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  while (writing || pending) await drain();
}

/**
 * Re-reads the stored document after another window wrote it, keeping this window's own
 * unwritten (pending) and in-flight keys on top so a local change is never clobbered.
 */
export async function reloadSettings(): Promise<void> {
  const seq = ++reloadSeq;
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = writeGeneration;
    const stored = await getSettings();
    if (seq !== reloadSeq) return; // a newer reload is under way
    // A local write landed meanwhile: the document may predate it; read it again.
    if (generation !== writeGeneration && attempt < 2) continue;
    const next = { ...stored, ...(inflight ?? {}), ...(pending ?? {}) };
    applyTheme(next);
    useSettingsStore.setState({ settings: next, loaded: true });
    return;
  }
}

/**
 * Follows settings written by other windows (`settings://changed`); events from `ownLabel` are
 * ignored. Returns an unlisten function. Best effort outside the Tauri shell.
 */
export function startSettingsSync(ownLabel: string): () => void {
  let unlisten: (() => void) | null = null;
  let stopped = false;
  try {
    onSettingsChanged((change) => {
      if (change.source === ownLabel) return;
      reloadSettings().catch((err) => console.error("reloading settings failed", err));
    })
      .then((un) => {
        if (stopped) un();
        else unlisten = un;
      })
      .catch(() => {});
  } catch {
    /* not running inside the Tauri shell */
  }
  return () => {
    stopped = true;
    unlisten?.();
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    const stored = await getSettings();
    const settings = { ...stored, ...(inflight ?? {}), ...(pending ?? {}) };
    applyTheme(settings);
    set({ settings, loaded: true });
  },
  update: (partial) => {
    const next = { ...get().settings, ...partial };
    applyTheme(next);
    set({ settings: next });
    pending = { ...(pending ?? {}), ...partial };
    const done = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      drain().catch(() => {}); // failures reach the waiting `update` callers
    }, SETTINGS_WRITE_DEBOUNCE_MS);
    return done;
  },
}));
