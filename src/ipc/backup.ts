import { invoke } from "@tauri-apps/api/core";

/** A book a backup had to leave out (its archive would be over 512 MiB); `reason` is a sentence. */
export interface SkippedBook {
  unitId: string;
  title: string;
  reason: string;
}

/** A backup written to disk, with the books it left out. */
export interface BackupSaved {
  path: string;
  skipped: SkippedBook[];
}

/** Zip every book to a file chosen in a save dialog. Resolves to what was saved, or `null` if cancelled. */
export const exportBackup = (): Promise<BackupSaved | null> => invoke("export_backup");

/** One line per skipped book: "<title>: <reason>". */
export const skippedLines = (skipped: readonly SkippedBook[]): string =>
  skipped.map((b) => `${b.title}: ${b.reason}`).join("\n");

/**
 * Write a recovery zip next to the database, delete all books, pages, assets and settings, and
 * restart the app. Resolves only on failure (the process restarts on success).
 */
export const resetLocalData = (): Promise<void> => invoke("reset_local_data", { confirm: "RESET" });

/** Set when a reset could not delete everything or left books out of its recovery zip (the app restarted anyway). */
export interface ResetIncomplete {
  recoveryPath: string;
  /** Why deleting local data failed; null when it succeeded. */
  error: string | null;
  /** Books too large for the recovery zip (absent in markers from older versions). */
  skipped?: SkippedBook[];
}

/** Returns and clears the marker a half-finished reset left behind, if any. */
export const takeResetIncomplete = (): Promise<ResetIncomplete | null> =>
  invoke("take_reset_incomplete");
