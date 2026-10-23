import { invoke } from "@tauri-apps/api/core";

export type HapticKind = "inkStart" | "inkStop" | "click";

/** Fire-and-forget pen haptics (Windows; a no-op elsewhere). Never awaited, never throws. */
export function penHapticsPulse(pointerId: number, kind: HapticKind): void {
  try {
    invoke("pen_haptics_pulse", { pointerId, kind }).catch(() => {});
  } catch {
    // Outside the Tauri shell `invoke` can throw synchronously.
  }
}
