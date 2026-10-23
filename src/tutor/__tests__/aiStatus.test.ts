// Module-level reactions to settings changes: they must work with no editor (and no tutor session)
// mounted, e.g. while the user fixes the model in Settings.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/ai", () => ({
  getAiStatus: vi.fn(async () => ({ configured: true, provider: "anthropic", model: "m", consent: true })),
}));

import { getAiStatus } from "../../ipc/ai";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Settings } from "../../model/types";
import { useSettingsStore } from "../../stores/settings";
import { notifyKeyChanged, sessionAttempts } from "../attempts";
import { useAiStatus } from "../aiStatus";

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const set = (partial: Partial<Settings>) =>
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...partial } }));

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true });
  vi.mocked(getAiStatus).mockClear();
  sessionAttempts.clearAuthBlock();
});

describe("AI status and block, app-wide", () => {
  it("a model fix or provider switch in Settings clears the block with no editor open", () => {
    for (const change of [{ aiModel: "claude-sonnet-5" }, { aiProvider: "openai" as const }, { aiConsent: true }]) {
      sessionAttempts.setBlock("unknownModel", "That model isn't available.");
      set(change);
      expect(sessionAttempts.block).toBeNull();
    }
    // Unrelated settings leave it alone.
    sessionAttempts.setBlock("auth", "The API key was not accepted.");
    set({ theme: "dark" });
    expect(sessionAttempts.block).not.toBeNull();
  });

  it("refreshes the key status on provider, model and consent changes with no editor open", async () => {
    set({ aiConsent: true, tutorEnabled: true });
    await flush();
    expect(getAiStatus).toHaveBeenCalledTimes(1);
    expect(useAiStatus.getState().configured).toBe(true);
    vi.mocked(getAiStatus).mockResolvedValueOnce({ configured: false, provider: "openai", model: "gpt-5", consent: true });
    set({ aiProvider: "openai" });
    await flush();
    expect(getAiStatus).toHaveBeenCalledTimes(2);
    expect(useAiStatus.getState().configured).toBe(false);
    set({ aiModel: "gpt-5-mini" });
    await flush();
    expect(getAiStatus).toHaveBeenCalledTimes(3);
  });

  it("never reads the keychain without consent and the tutor on", async () => {
    // Consent off: no read on changes, key saves or ensure().
    set({ aiConsent: false, tutorEnabled: true, aiProvider: "openai" });
    notifyKeyChanged();
    useAiStatus.getState().ensure();
    await flush();
    // Tutor off, consent on: still nothing.
    set({ tutorEnabled: false });
    set({ aiConsent: true });
    useAiStatus.getState().ensure();
    await flush();
    expect(getAiStatus).not.toHaveBeenCalled();
    // Both on: the status is read.
    set({ tutorEnabled: true });
    await flush();
    expect(getAiStatus).toHaveBeenCalledTimes(1);
  });
});
