import { create } from "zustand";
import { DEFAULT_SETTINGS } from "../model/constants";
import type { Settings } from "../model/types";
import { getSettings, setSettings } from "../ipc/settings";

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  update: (partial: Partial<Settings>) => Promise<void>;
}

const applyTheme = (s: Settings) => {
  document.documentElement.dataset.theme = s.theme;
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    const settings = await getSettings();
    applyTheme(settings);
    set({ settings, loaded: true });
  },
  update: async (partial) => {
    const next = { ...get().settings, ...partial };
    applyTheme(next);
    set({ settings: next });
    await setSettings(next);
  },
}));
