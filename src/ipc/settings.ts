import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "../model/types";

export const getSettings = (): Promise<Settings> => invoke("get_settings");

/**
 * Merges the given top-level keys into the stored settings (other keys keep their stored value,
 * so windows writing different keys never revert each other); resolves with the merged document.
 */
export const patchSettings = (patch: Partial<Settings>): Promise<Settings> => invoke("patch_settings", { patch });

/** Broadcast by Rust to every window after a settings write. */
export const SETTINGS_CHANGED = "settings://changed";

export interface SettingsChange {
  /** Label of the window that wrote. */
  source: string;
}

/** Resolves with an unlisten function. */
export const onSettingsChanged = (handler: (change: SettingsChange) => void): Promise<() => void> =>
  listen<SettingsChange>(SETTINGS_CHANGED, (event) => handler(event.payload));
