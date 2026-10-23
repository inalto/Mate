import { invoke } from "@tauri-apps/api/core";

/** Zip every book to a file chosen in a save dialog. Resolves to the path, or `null` if cancelled. */
export const exportBackup = (): Promise<string | null> => invoke("export_backup");

/**
 * Write a recovery zip next to the database, delete all books, pages, assets and settings, and
 * restart the app. Resolves only on failure (the process restarts on success).
 */
export const resetLocalData = (): Promise<void> => invoke("reset_local_data");
