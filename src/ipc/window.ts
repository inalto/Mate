// Fullscreen of this native window (presentation mode). Outside the Tauri shell (browser, tests)
// every call is a no-op: `isFullscreen` resolves false and `setFullscreen` does nothing.
import { getCurrentWindow } from "@tauri-apps/api/window";

const inTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Turn this window's fullscreen on or off; failures (no permission on a platform) are logged. */
export async function setFullscreen(on: boolean): Promise<void> {
  if (!inTauri()) return;
  try {
    await getCurrentWindow().setFullscreen(on);
  } catch (err) {
    console.error("setting fullscreen failed", err);
  }
}

/** True when this window is fullscreen (false outside the Tauri shell or on failure). */
export async function isFullscreen(): Promise<boolean> {
  if (!inTauri()) return false;
  try {
    return await getCurrentWindow().isFullscreen();
  } catch {
    return false;
  }
}
