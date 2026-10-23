// Pen haptics while inking (Windows only): a continuous buzz from pen-down to pen-up and a click when
// ink snaps to a shape. Gated by the `penHaptics` setting; off Windows or when off, no IPC is sent.
import { penHapticsPulse, type HapticKind } from "../ipc/haptics";
import { useSettingsStore } from "../stores/settings";

/** Windows desktop (the only platform with pen haptics). */
export function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const uad = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /^win/i.test(uad?.platform || navigator.platform || "");
}

/** The `penHaptics` setting (default on). */
function enabled(): boolean {
  const settings = useSettingsStore.getState().settings as unknown as { penHaptics?: boolean };
  return settings.penHaptics ?? true;
}

/** Contacts (DOM pointer ids) that got an inkStart and still owe an inkStop. */
const inking = new Set<number>();

/**
 * Pen haptics for one contact: at most one `inkStart` and one `inkStop` per contact (`inkStop` only
 * after an `inkStart`). An open contact is always stopped, even if the setting was turned off
 * mid-stroke, so the pen never keeps buzzing.
 */
export function penHaptics(kind: HapticKind, pointerId: number): void {
  if (kind === "inkStop") {
    if (inking.delete(pointerId)) penHapticsPulse(pointerId, kind);
    return;
  }
  if (!enabled() || !isWindowsPlatform()) return;
  if (kind === "inkStart") {
    if (inking.has(pointerId)) return;
    inking.add(pointerId);
  }
  penHapticsPulse(pointerId, kind);
}

/** Test hook: forget open contacts. */
export function resetPenHaptics(): void {
  inking.clear();
}

export interface PenInkHaptics {
  /** An ink stroke started from the press being handled (pen presses only buzz). */
  start(pointerType: string): void;
  /** The stroke ended, was cancelled or aborted (idempotent). */
  stop(): void;
  /** Ink snapped to a shape. */
  click(): void;
  dispose(): void;
}

/**
 * Wires pen haptics to one canvas. The pointer adapter does not pass pointer ids, so the id of the
 * last pen press on `el` is recorded here (capture phase, before the adapter's own listener).
 */
export function createPenInkHaptics(el: HTMLElement): PenInkHaptics {
  let lastPen: number | null = null;
  let active: number | null = null;
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === "pen") lastPen = e.pointerId;
  };
  el.addEventListener("pointerdown", onDown, true);
  const stop = () => {
    if (active === null) return;
    penHaptics("inkStop", active);
    active = null;
  };
  return {
    start(pointerType) {
      if (pointerType !== "pen" || lastPen === null) return;
      stop();
      active = lastPen;
      penHaptics("inkStart", active);
    },
    stop,
    click() {
      if (active !== null) penHaptics("click", active);
    },
    dispose() {
      stop();
      el.removeEventListener("pointerdown", onDown, true);
    },
  };
}
