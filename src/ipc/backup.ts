import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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

/** What one restored book created (the same report as importing its `.mate`). */
export interface RestoredBook {
  unitId: string;
  pages: number;
  elements: number;
  skipped: number;
}

/** A book in the backup that could not be restored: its title (or file name) and why. */
export interface FailedBook {
  name: string;
  error: string;
}

/** What a restore added. `lostRecordings`: titles of books whose recordings came back without (some of) their audio. */
export interface RestoreReport {
  books: RestoredBook[];
  failed: FailedBook[];
  rejectedAudio: number;
  lostRecordings: string[];
}

/**
 * How `restoreBackupFile`'s error starts when the restore itself died: unlike every other
 * error, some notebooks may already have been restored (matches `RESTORE_STOPPED` in Rust).
 */
export const RESTORE_STOPPED = "restore stopped unexpectedly";

/** Ask for a backup zip to restore; `null` if cancelled. */
export const pickBackupFile = async (filterName: string): Promise<string | null> => {
  const picked = await open({ multiple: false, directory: false, filters: [{ name: filterName, extensions: ["zip"] }] });
  return typeof picked === "string" ? picked : null;
};

/**
 * Add every book of the backup zip at `path` beside the existing ones, with its recording audio.
 * Rejects when the restore could not run at all; then nothing was changed, unless the error
 * starts with {@link RESTORE_STOPPED}.
 */
export const restoreBackupFile = (path: string): Promise<RestoreReport> => invoke("restore_backup_file", { path });

/**
 * How `resetLocalData`'s error starts when a recording is not saved yet (matches
 * `RESET_RECORDING_OPEN` in Rust); nothing was written or deleted.
 */
export const RESET_RECORDING_OPEN = "reset refused: a recording is still being saved";

/**
 * Write a recovery zip next to the database, delete all books, pages, assets and settings, and
 * restart the app. Resolves only on failure (the process restarts on success); refused, with
 * nothing deleted, when a book is too large for the recovery zip (the error names it) or a
 * recording is not saved yet (see {@link RESET_RECORDING_OPEN}).
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
