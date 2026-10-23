import { invoke } from "@tauri-apps/api/core";

/** Zip every book to a file chosen in a save dialog. Resolves to the path, or `null` if cancelled. */
export const exportBackup = (): Promise<string | null> => invoke("export_backup");

/**
 * Write a recovery zip next to the database, delete all books, pages, assets and settings, and
 * restart the app. Resolves only on failure (the process restarts on success).
 */
export const resetLocalData = (): Promise<void> => invoke("reset_local_data", { confirm: "RESET" });

/** Set when a reset could not delete everything (the app restarted anyway). */
export interface ResetIncomplete {
  recoveryPath: string;
  error: string;
}

/** Returns and clears the marker a half-finished reset left behind, if any. */
export const takeResetIncomplete = (): Promise<ResetIncomplete | null> =>
  invoke("take_reset_incomplete");
