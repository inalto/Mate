import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../../ipc/app", () => ({ openExternal: vi.fn(async () => {}) }));
vi.mock("../../../ipc/ai", () => ({ getAiStatus: vi.fn() }));
vi.mock("../../../ipc/speech", () => ({
  listSpeechProviders: vi.fn(async () => []),
  getSpeechStatus: vi.fn(async () => ({ configured: false, hasKey: false, provider: "openai", model: "", baseUrl: "", consent: false, needsKey: true, local: false })),
  setSpeechKey: vi.fn(async () => {}),
  clearSpeechKey: vi.fn(async () => {}),
  testSpeechKey: vi.fn(async () => {}),
}));

import { getAiStatus } from "../../../ipc/ai";
import { DEFAULT_SETTINGS } from "../../../model/constants";
import type { AiStatus } from "../../../model/types";
import { useSettingsStore } from "../../../stores/settings";
import DictationSection from "../sections/DictationSection";

const NEEDS_AI = "Set up the AI assistant in Settings, Tutor & recognition (consent and a key) to use this.";
const maths = () => screen.getByLabelText("Convert spoken maths to notation") as HTMLInputElement;
const tidy = () => screen.getByLabelText("Tidy dictation with the AI assistant") as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAiStatus).mockResolvedValue({ configured: true } as AiStatus);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true });
});
afterEach(cleanup);

describe("DictationSection", () => {
  it("converts spoken maths by default and the switch writes the setting", async () => {
    render(<DictationSection />);
    expect(maths().checked).toBe(true);
    expect(screen.getByText(/become y = x \+ 10 and are inserted as an equation/)).toBeTruthy();
    await act(async () => fireEvent.click(maths()));
    expect(useSettingsStore.getState().settings.dictationMath).toBe(false);
  });

  it("the tidy-up is off and unavailable without AI consent; the keychain is not read", async () => {
    render(<DictationSection />);
    expect(tidy().checked).toBe(false);
    expect(tidy().disabled).toBe(true);
    expect(document.getElementById("set-dictationTidy-hint")?.textContent).toContain(NEEDS_AI);
    expect(screen.getByText(/never the audio/)).toBeTruthy();
    expect(getAiStatus).not.toHaveBeenCalled();
  });

  it("with consent and a configured assistant the tidy-up can be turned on", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, aiConsent: true } });
    render(<DictationSection />);
    await waitFor(() => expect(tidy().disabled).toBe(false));
    expect(document.getElementById("set-dictationTidy-hint")?.textContent).not.toContain(NEEDS_AI);
    await act(async () => fireEvent.click(tidy()));
    expect(useSettingsStore.getState().settings.dictationTidy).toBe(true);
  });

  it("with consent but no key the tidy-up stays unavailable", async () => {
    vi.mocked(getAiStatus).mockResolvedValue({ configured: false } as AiStatus);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, aiConsent: true } });
    render(<DictationSection />);
    await waitFor(() => expect(getAiStatus).toHaveBeenCalled());
    expect(tidy().disabled).toBe(true);
    expect(screen.getByText(/consent and a key/)).toBeTruthy();
  });

  it("a tidy-up left on without the assistant can still be turned off", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, dictationTidy: true } });
    render(<DictationSection />);
    expect(tidy().disabled).toBe(false);
    await act(async () => fireEvent.click(tidy()));
    expect(useSettingsStore.getState().settings.dictationTidy).toBe(false);
  });
});
