// `notebook://changed`: Rust broadcasts it to every window after a notebook mutation, so page
// windows and the main window (each with its own notebook store) stay in step.
import { listen } from "@tauri-apps/api/event";

export const NOTEBOOK_CHANGED = "notebook://changed";

export interface NotebookChange {
  /** "page-trashed": trashed or purged; "page-updated": record saved (rename...); "tree": anything else. */
  kind: "page-trashed" | "page-updated" | "tree";
  pageId?: string;
  title?: string;
  /** Label of the window that made the change. */
  source: string;
}

/** Resolves with an unlisten function. */
export const onNotebookChanged = (handler: (change: NotebookChange) => void): Promise<() => void> =>
  listen<NotebookChange>(NOTEBOOK_CHANGED, (event) => handler(event.payload));
