import { invoke } from "@tauri-apps/api/core";

/**
 * Ask where to save an exported file (native save dialog, `suggestedName` preselected) and write
 * `bytes` there. Sent as the raw request body so large images skip JSON encoding. Resolves to the
 * written path, or `null` if the dialog was cancelled.
 */
export const writeExportFile = (suggestedName: string, bytes: Uint8Array): Promise<string | null> =>
  invoke("write_export_file", bytes, { headers: { "x-suggested-name": suggestedName } });
