// Safe close handshake. Rust intercepts the window close, calls `__mateFlushAndClose(id)`, and
// destroys the window only when we confirm via `complete_close_attempt`.
import { showToast } from "../components/Toast";
import i18n from "../i18n";
import { elementsQueue } from "../ipc/elementsQueue";
import { isPageWindow } from "../ipc/windows";
import * as lifecycle from "../ipc/lifecycle";
import { endAllEdits } from "../overlay/useEditSession";
import { flushSettings } from "../stores/settings";
import { focusedPageId, useTabsStore } from "../stores/tabs";

export const CLEAN_EXIT_KEY = "mate_clean_exit_v1";
export const safeCloseToast = (): string => i18n.t("lifecycle.safeClose");

export const stillSavingToast = (): string => i18n.t("lifecycle.stillSaving");

declare global {
  interface Window {
    __mateFlushAndClose?: (attemptId: number) => Promise<void>;
    __mateCloseAttemptCancelled?: (attemptId: number) => void;
    /** Main window: its close was cancelled because a page window could not save. */
    __mateCloseRefused?: () => void;
  }
}

const safeSet = (k: string, v: string) => {
  // The clean-exit flag describes the app session, which the main window owns: a page window
  // closing is not the app exiting.
  if (isPageWindow()) return;
  try {
    localStorage.setItem(k, v);
  } catch {
    // Storage unavailable: the recovery card may show spuriously next launch.
  }
};

/** Reads and clears the clean-exit flag; true if the previous session ended through the safe close. */
export function consumeCleanExit(): boolean {
  try {
    const clean = localStorage.getItem(CLEAN_EXIT_KEY) === "1";
    localStorage.removeItem(CLEAN_EXIT_KEY);
    return clean;
  } catch {
    return true;
  }
}

let recoveryPageId: string | null = null;

/** Call once at startup: remembers the page that was open if the last session did not exit cleanly. */
export function initRecovery(): void {
  if (isPageWindow()) return;
  const clean = consumeCleanExit();
  recoveryPageId = clean ? null : focusedPageId(useTabsStore.getState());
}
export const getRecoveryPageId = (): string | null => recoveryPageId;
export const dismissRecovery = (): void => {
  recoveryPageId = null;
};

/** The "Close anyway" offer lapses after this long (the situation it described has moved on). */
export const CLOSE_ANYWAY_EXPIRY_MS = 30_000;

export function installCloseHandler(): void {
  let current: number | null = null;

  window.__mateFlushAndClose = async (id) => {
    // Open box editors hold their edits locally until the session ends: commit them into the queue.
    endAllEdits();
    try {
      if (!(await lifecycle.closeAttemptStarted(id))) return;
    } catch {
      return;
    }
    current = id;
    await elementsQueue.flushAll();
    if (current !== id) return; // cancelled meanwhile (watchdog); the toast was already shown
    if (elementsQueue.failed() > 0) {
      const { pending, failed } = elementsQueue.snapshot();
      const savedAt = new Date().toISOString();
      const contents = JSON.stringify({ app: "Mate", schemaVersion: 1, savedAt, pending, failed }, null, 2);
      let recoveryPath: string | null = null;
      try {
        const written = await lifecycle.writeRecoveryArtifact(
          `mate-recovery-${savedAt.replace(/[:.]/g, "-")}.json`,
          contents,
        );
        recoveryPath = written.path;
      } catch (err) {
        console.error("could not write recovery artifact", err);
      }
      if (current === id) {
        current = null;
        try {
          await lifecycle.cancelCloseAttempt(id);
        } catch {
          // Rust's watchdog clears the attempt anyway.
        }
        if (recoveryPath === null) {
          showToast(safeCloseToast());
        } else {
          showToast(i18n.t("lifecycle.safeCloseRecovery", { path: recoveryPath }), {
            label: i18n.t("lifecycle.closeAnyway"),
            onClick: () => {
              safeSet(CLEAN_EXIT_KEY, "0"); // not a clean exit: the recovery card shows next launch
              void lifecycle.completeCloseAttempt(id, true).catch((err) => console.error("close anyway failed", err));
            },
          }, { expiresAfterMs: CLOSE_ANYWAY_EXPIRY_MS });
        }
      }
      return;
    }
    try {
      await flushSettings();
    } catch (err) {
      // Preferences, not notes: a failed settings write does not hold the window open.
      console.error("saving settings before close failed", err);
    }
    if (current !== id) return;
    current = null;
    safeSet(CLEAN_EXIT_KEY, "1");
    try {
      await lifecycle.completeCloseAttempt(id);
    } catch (err) {
      console.error("complete_close_attempt failed", err);
      try {
        if (!isPageWindow()) localStorage.removeItem(CLEAN_EXIT_KEY); // we are still running
      } catch {
        // ignore
      }
    }
  };

  window.__mateCloseAttemptCancelled = (id) => {
    if (current !== id) return;
    current = null;
    showToast(stillSavingToast());
  };

  // Closing the main window first closes every page window; one could not save, so Mate stays open
  // (that window says why).
  window.__mateCloseRefused = () => showToast(safeCloseToast());

  // Best-effort flush on reload / navigation away (e.g. dev reloads).
  const bestEffort = () => {
    endAllEdits();
    void elementsQueue.flushAll();
    flushSettings().catch((err) => console.error("saving settings failed", err));
  };
  window.addEventListener("beforeunload", bestEffort);
  window.addEventListener("pagehide", bestEffort);
}
