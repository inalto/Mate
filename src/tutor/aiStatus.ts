// Whether the tutor may run at all: AI consent given, the tutor switched on and a key stored for
// the provider. Until all three hold, nothing is segmented, no marker or gesture is active and
// nothing is sent. The key part comes from `get_ai_status` (Rust), cached here and refreshed when
// a key is saved or removed and when the provider or consent changes.
import { create } from "zustand";
import { getAiStatus } from "../ipc/ai";
import type { Settings } from "../model/types";
import { onKeyChanged } from "./attempts";

interface AiStatusState {
  /** A key is stored for the current provider; null until first read. */
  configured: boolean | null;
  refresh(): Promise<void>;
  /** Read the status once (later calls do nothing until `refresh`). */
  ensure(): void;
}

let reads = 0;

export const useAiStatus = create<AiStatusState>((set, get) => ({
  configured: null,
  async refresh() {
    const n = ++reads;
    let configured = false;
    try {
      configured = (await getAiStatus()).configured;
    } catch (e) {
      console.warn("reading the AI status failed", e);
    }
    if (n === reads) set({ configured });
  },
  ensure() {
    if (get().configured === null && reads === 0) void get().refresh();
  },
}));

onKeyChanged(() => void useAiStatus.getState().refresh());

/** The tutor's master gate: consent, the tutor switch and a configured key. */
export const tutorActive = (s: Pick<Settings, "aiConsent" | "tutorEnabled">, configured: boolean | null): boolean =>
  s.aiConsent === true && s.tutorEnabled && configured === true;
