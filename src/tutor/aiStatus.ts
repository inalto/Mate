// Whether the tutor may run at all: AI consent given, the tutor switched on and a key stored for
// the provider. Until all three hold, nothing is segmented, no marker or gesture is active and
// nothing is sent. The key part comes from `get_ai_status` (Rust), cached here and refreshed when
// a key is saved or removed and when the provider, model, address, consent or tutor switch changes
// (the address once typing pauses and the setting is written). The keychain is only read while
// consent and the tutor switch are both on.
import { create } from "zustand";
import { getAiStatus } from "../ipc/ai";
import type { AiVision, Settings } from "../model/types";
import { flushSettings, useSettingsStore } from "../stores/settings";
import { onKeyChanged } from "./attempts";

interface AiStatusState {
  /** A key is stored for the current provider; null until first read. */
  configured: boolean | null;
  /** What the provider can do with images; "no" means the tutor cannot check. */
  vision: AiVision | null;
  refresh(): Promise<void>;
  /**
   * Read the status once, and only with consent and the tutor on (later calls do nothing until
   * `refresh`).
   */
  ensure(): void;
}

let reads = 0;

/** Reading the key status (a keychain access) is only worth it when the tutor could run. */
const mayRead = (s: Pick<Settings, "aiConsent" | "tutorEnabled"> = useSettingsStore.getState().settings): boolean =>
  s.aiConsent === true && s.tutorEnabled;

export const useAiStatus = create<AiStatusState>((set, get) => ({
  configured: null,
  vision: null,
  async refresh() {
    const n = ++reads;
    let configured = false;
    let vision: AiVision | null = null;
    try {
      const status = await getAiStatus();
      configured = status.configured;
      vision = status.vision ?? null;
    } catch (e) {
      console.warn("reading the AI status failed", e);
    }
    if (n === reads) set({ configured, vision });
  },
  ensure() {
    if (get().configured === null && reads === 0 && mayRead()) void get().refresh();
  },
}));

onKeyChanged(() => {
  if (mayRead()) void useAiStatus.getState().refresh();
});

/** Quiet time after typing an address before the status is read again. */
export const ADDRESS_REFRESH_MS = 500;
let addressTimer: ReturnType<typeof setTimeout> | null = null;

// Subscribed once for the app (not per editor): a provider switch or model fix in Settings updates
// `configured` even while no page is open.
useSettingsStore.subscribe((s, prev) => {
  const a = s.settings;
  const b = prev.settings;
  const changed =
    a.aiProvider !== b.aiProvider || a.aiModel !== b.aiModel || a.aiConsent !== b.aiConsent || a.tutorEnabled !== b.tutorEnabled;
  if (changed && mayRead(a)) void useAiStatus.getState().refresh();
  if (a.aiBaseUrl !== b.aiBaseUrl) {
    if (addressTimer !== null) clearTimeout(addressTimer);
    addressTimer = setTimeout(() => {
      addressTimer = null;
      // Rust reads the stored settings: write the address first.
      void flushSettings()
        .catch(() => {})
        .then(() => (mayRead() ? useAiStatus.getState().refresh() : undefined));
    }, ADDRESS_REFRESH_MS);
  }
});

/**
 * The tutor's master gate: consent, the tutor switch and a configured provider. A text-only
 * provider (`vision === "no"`) cannot read handwriting, so checking stays off.
 */
export const tutorActive = (
  s: Pick<Settings, "aiConsent" | "tutorEnabled">,
  configured: boolean | null,
  vision: AiVision | null = null,
): boolean => s.aiConsent === true && s.tutorEnabled && configured === true && vision !== "no";
