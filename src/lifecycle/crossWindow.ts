// Keeps this window's notebook store in step with changes made in other windows (the main window
// and page windows each have their own store). A page window closes itself, through its own close
// handshake, when its page is trashed, and follows renames at once.
import { onNotebookChanged, type NotebookChange } from "../ipc/notebookEvents";
import { closeThisWindow, currentWindowLabel, isPageWindow } from "../ipc/windows";
import { useNotebookStore } from "../stores/notebook";
import { focusedPageId, useTabsStore } from "../stores/tabs";

export const RELOAD_DEBOUNCE_MS = 200;

/** Handles one change; exported for tests. Returns a disposer for the pending reload. */
export function createCrossWindowHandler(self: string): { handle(change: NotebookChange): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closing = false;
  const reload = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      useNotebookStore.getState().load().catch((err) => console.error("reloading the notebook failed", err));
    }, RELOAD_DEBOUNCE_MS);
  };
  return {
    handle(change) {
      if (change.source === self || closing) return;
      if (isPageWindow()) {
        const mine = focusedPageId(useTabsStore.getState());
        if (change.kind === "page-trashed" && change.pageId === mine) {
          closing = true;
          closeThisWindow();
          return;
        }
        if (change.kind === "page-updated" && change.pageId === mine && change.title !== undefined) {
          const title = change.title;
          useNotebookStore.setState((s) => ({
            tree: { ...s.tree, pages: s.tree.pages.map((p) => (p.id === mine ? { ...p, title } : p)) },
          }));
        }
      }
      reload();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Starts listening; returns a detach function. */
export function installCrossWindowSync(): () => void {
  const handler = createCrossWindowHandler(currentWindowLabel());
  let detached = false;
  let unlisten: (() => void) | null = null;
  onNotebookChanged((c) => handler.handle(c))
    .then((fn) => (detached ? fn() : (unlisten = fn)))
    .catch(() => {
      /* not running inside the Tauri shell */
    });
  return () => {
    detached = true;
    unlisten?.();
    handler.dispose();
  };
}
