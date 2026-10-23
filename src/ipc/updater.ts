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

/** Downloads (signature-verified) and installs; progress arrives on `onUpdateProgress`. */
export const installUpdate = (): Promise<void> => invoke("install_update");

/** Restarts the app into the installed update. */
export const relaunch = (): Promise<void> => invoke("relaunch");

export const onUpdateProgress = (cb: (p: UpdateProgress) => void): Promise<UnlistenFn> =>
  listen<UpdateProgress>("update://progress", (e) => cb(e.payload));
