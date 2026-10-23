// Flush without closing: Rust calls `__mateFlushOnly(token)` in every window before an update is
// installed (on Windows the installer ends the process with no close handshake). We commit open
// edits, wait for the write-behind queue and settings, and answer with `report_flush`.
import { invoke } from "@tauri-apps/api/core";
import { elementsQueue } from "../ipc/elementsQueue";
import { endAllEdits } from "../overlay/useEditSession";
import { flushSettings } from "../stores/settings";

declare global {
  interface Window {
    __mateFlushOnly?: (token: number) => Promise<void>;
  }
}

export async function flushOnly(token: number): Promise<void> {
  let ok = true;
  try {
    endAllEdits();
    await elementsQueue.flushAll();
    ok = elementsQueue.failed() === 0;
  } catch {
    ok = false;
  }
  try {
    await flushSettings();
  } catch {
    // Preferences, not notes: a failed settings write does not block the update.
  }
  try {
    await invoke("report_flush", { token, ok });
  } catch {
    // Rust times the round out and aborts the install.
  }
}

export function installFlushOnly(): () => void {
  window.__mateFlushOnly = flushOnly;
  return () => {
    delete window.__mateFlushOnly;
  };
}
