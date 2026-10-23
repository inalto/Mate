// Page windows: a page opened in its own native window (`/edit/<pageId>?window=1`). The main
// window keeps its tabs; a page window shows one page, without sidebar or tabs.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface PageWindowInfo {
  pageId: string;
  label: string;
}

/** Opens `pageId` in its own window, or focuses the window already showing it; resolves with its label. */
export const openPageWindow = (pageId: string): Promise<string> => invoke("open_page_window", { pageId });

/** Focuses the window showing `pageId`; false if none is open. */
export const focusPageWindow = (pageId: string): Promise<boolean> => invoke("focus_page_window", { pageId });

export const listPageWindows = (): Promise<PageWindowInfo[]> => invoke("list_page_windows");

// Read once at startup: this window was opened at `?window=1`. In-app navigation may drop the query.
let pageWindow = (() => {
  try {
    return new URLSearchParams(window.location.search).get("window") === "1";
  } catch {
    return false;
  }
})();

/** True in a page window (no sidebar, no tabs, nothing persisted for the main window's tabs). */
export const isPageWindow = (): boolean => pageWindow;

/** Tests only. */
export const setPageWindowForTests = (value: boolean): void => {
  pageWindow = value;
};

/** This window's label ("main" or "page-<id>"); "main" outside the Tauri shell. */
export function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

/** Sets this native window's title (best effort; a no-op outside the Tauri shell). */
export function setThisWindowTitle(title: string): void {
  try {
    void getCurrentWindow().setTitle(title).catch(() => {});
  } catch {
    /* not running inside the Tauri shell */
  }
}

/** Closes this window through the close handshake (the page window's only exit). */
export function closeThisWindow(): void {
  try {
    void getCurrentWindow().close().catch((err) => console.error("closing the window failed", err));
  } catch {
    /* not running inside the Tauri shell */
  }
}
