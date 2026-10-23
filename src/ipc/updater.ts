import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface UpdateCheck {
  /** False when this build cannot update: placeholder signing key, or no manifest published. */
  configured: boolean;
  available: boolean;
  version?: string;
  notes?: string;
}

export interface UpdateProgress {
  downloaded: number;
  /** `null` when the server sent no length. */
  total: number | null;
}

export const checkForUpdate = (): Promise<UpdateCheck> => invoke("check_for_update");

/**
 * Saves every window, then downloads (signature-verified) and installs `expectedVersion`; progress
 * arrives on `onUpdateProgress`. On Windows the installer restarts the app and this never resolves.
 */
export const installUpdate = (expectedVersion: string): Promise<void> =>
  invoke("install_update", { expectedVersion });

/** Restarts the app into the installed update. */
export const relaunch = (): Promise<void> => invoke("relaunch");

export const onUpdateProgress = (cb: (p: UpdateProgress) => void): Promise<UnlistenFn> =>
  listen<UpdateProgress>("update://progress", (e) => cb(e.payload));
