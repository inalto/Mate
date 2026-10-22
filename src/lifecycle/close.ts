// Safe close handshake. Rust intercepts the window close, calls `__mateFlushAndClose(id)`, and
// destroys the window only when we confirm via `complete_close_attempt`.
import { showToast } from "../components/Toast";
import { elementsQueue } from "../ipc/elementsQueue";
import * as lifecycle from "../ipc/lifecycle";
import { focusedPageId, useTabsStore } from "../stores/tabs";

export const CLEAN_EXIT_KEY = "mate_clean_exit_v1";
export const SAFE_CLOSE_TOAST =
  "Could not close safely — Your notes are not fully saved. Keep Mate open and try again.";

declare global {
  interface Window {
    __mateFlushAndClose?: (attemptId: number) => Promise<void>;
    __mateCloseAttemptCancelled?: (attemptId: number) => void;
  }
}

const safeSet = (k: string, v: string) => {
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
  const clean = consumeCleanExit();
  recoveryPageId = clean ? null : focusedPageId(useTabsStore.getState());
}
export const getRecoveryPageId = (): string | null => recoveryPageId;
export const dismissRecovery = (): void => {
  recoveryPageId = null;
};

export function installCloseHandler(): void {
  let current: number | null = null;

  window.__mateFlushAndClose = async (id) => {
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
      try {
        await lifecycle.writeRecoveryArtifact(`mate-recovery-${savedAt.replace(/[:.]/g, "-")}.json`, contents);
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
        showToast(SAFE_CLOSE_TOAST);
      }
      return;
    }
    current = null;
    safeSet(CLEAN_EXIT_KEY, "1");
    try {
      await lifecycle.completeCloseAttempt(id);
    } catch (err) {
      console.error("complete_close_attempt failed", err);
      try {
        localStorage.removeItem(CLEAN_EXIT_KEY); // we are still running
      } catch {
        // ignore
      }
    }
  };

  window.__mateCloseAttemptCancelled = (id) => {
    if (current !== id) return;
    current = null;
    showToast(SAFE_CLOSE_TOAST);
  };

  // Best-effort flush on reload / navigation away (e.g. dev reloads).
  const bestEffort = () => void elementsQueue.flushAll();
  window.addEventListener("beforeunload", bestEffort);
  window.addEventListener("pagehide", bestEffort);
}
