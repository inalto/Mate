import { invoke } from "@tauri-apps/api/core";

/**
 * A backup written to disk. `skippedBooks`: titles of books too large to back up, which are NOT
 * in it (the user must be told before anything else). `missingAudio`: titles of books whose
 * recording audio could not be found (the rest of the book is in the backup).
 */
export interface BackupSaved {
  path: string;
  skippedBooks: string[];
  missingAudio: string[];
}

/** Zip every book to a file chosen in a save dialog. Resolves to what was saved, or `null` if cancelled. */
export const exportBackup = (): Promise<BackupSaved | null> => invoke("export_backup");

/**
 * Write a recovery zip next to the database, delete all books, pages, assets and settings, and
 * restart the app. Resolves only on failure (the process restarts on success); refused, with
 * nothing deleted, when a book is too large for the recovery zip (the error names it).
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
