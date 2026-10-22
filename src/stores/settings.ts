import { create } from "zustand";
import { DEFAULT_SETTINGS } from "../model/constants";
import type { Settings } from "../model/types";
import { getSettings, setSettings } from "../ipc/settings";

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  /**
   * Merge `partial` into memory (and the theme attribute) at once; persistence is debounced and
   * serialised. Resolves when a write containing this state has completed (rejects if it failed).
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

/** Latest state not yet handed to `setSettings`, and the updates waiting for it. */
let pending: Settings | null = null;
let waiters: Waiter[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
/** The write loop in progress (at most one `setSettings` in flight). */
let writing: Promise<void> | null = null;

/**
 * Write until nothing is pending: one call at a time, always the newest state (state that arrives
 * during a write is written once afterwards). Rejects with the last write's error when it failed.
 */
function drain(): Promise<void> {
  if (writing) return writing;
  if (!pending) return Promise.resolve();
  writing = (async () => {
    let lastError: unknown = null;
    while (pending) {
      const state = pending;
      const batch = waiters;
      pending = null;
      waiters = [];
      try {
        await setSettings(state);
        lastError = null;
        for (const w of batch) w.resolve();
      } catch (err) {
        lastError = err;
        for (const w of batch) w.reject(err);
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

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    const settings = await getSettings();
    applyTheme(settings);
    set({ settings, loaded: true });
  },
  update: (partial) => {
    const next = { ...get().settings, ...partial };
    applyTheme(next);
    set({ settings: next });
    pending = next;
    const done = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      drain().catch(() => {}); // failures reach the waiting `update` callers
    }, SETTINGS_WRITE_DEBOUNCE_MS);
    return done;
  },
}));
