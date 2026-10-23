import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { AiStatus } from "../../model/types";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/ai", () => ({
  setAiKey: vi.fn(async () => {}),
  clearAiKey: vi.fn(async () => {}),
  getAiStatus: vi.fn(),
  testAiKey: vi.fn(async () => {}),
}));

import { clearAiKey, getAiStatus, setAiKey, testAiKey } from "../../ipc/ai";
import { patchSettings } from "../../ipc/settings";
import { flushSettings, useSettingsStore } from "../../stores/settings";
import AiSettings from "../AiSettings";

const SECRET = "sk-test-very-secret";
let status: AiStatus;

beforeEach(() => {
  vi.clearAllMocks();
  status = { configured: false, provider: "anthropic", model: "claude-opus-5-5", consent: false };
  vi.mocked(getAiStatus).mockImplementation(async () => ({ ...status }));
  vi.mocked(setAiKey).mockImplementation(async () => {
    status.configured = true;
  });
  vi.mocked(clearAiKey).mockImplementation(async () => {
    status.configured = false;
  });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
});
afterEach(cleanup);

describe("AiSettings", () => {
  it("shows the consent copy for the selected provider and stores consent in settings", async () => {
    render(<AiSettings />);
    const consent = screen.getByLabelText(
      "Send handwriting images and text to Anthropic to check your work. Nothing is sent until you turn this on.",
    ) as HTMLInputElement;
    expect(consent.checked).toBe(false);
    fireEvent.click(consent);
    expect(useSettingsStore.getState().settings.aiConsent).toBe(true);

    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "openai" } });
    expect(useSettingsStore.getState().settings.aiProvider).toBe("openai");
    expect(screen.getByText(/to OpenAI to check your work/)).toBeTruthy();
    expect((screen.getByLabelText("Model") as HTMLInputElement).placeholder).toBe("gpt-5");
    await act(flushSettings);
  });

  it("uses a password input and saves the key only through setAiKey", async () => {
    render(<AiSettings />);
    expect(await screen.findByText("No key")).toBeTruthy();
    const input = screen.getByLabelText("API key") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: `  ${SECRET}  ` } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(setAiKey).toHaveBeenCalledWith("anthropic", `  ${SECRET}  `));
    expect(await screen.findByText("Key saved")).toBeTruthy();
    expect(input.value).toBe("");

    // The key never reaches settings, in memory or on disk.
    await act(flushSettings);
    expect(JSON.stringify(useSettingsStore.getState().settings)).not.toContain(SECRET);
    for (const call of vi.mocked(patchSettings).mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET);
  });

  it("does not claim the key works when consent is off (nothing was sent)", async () => {
    status.configured = true;
    render(<AiSettings />);
    expect(await screen.findByText("Key saved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Test key" }));
    expect(await screen.findByText("Key saved (not tested — turn on consent to test)")).toBeTruthy();
    expect(screen.queryByText("Key works.")).toBeNull();
  });

  it("removes and tests the key", async () => {
    status.configured = true;
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, aiConsent: true } });
    render(<AiSettings />);
    expect(await screen.findByText("Key saved")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Test key" }));
    expect(await screen.findByText("Key works.")).toBeTruthy();
    expect(testAiKey).toHaveBeenCalledWith("anthropic");

    vi.mocked(testAiKey).mockRejectedValueOnce("The API key was not accepted. Check it in Settings.");
    fireEvent.click(screen.getByRole("button", { name: "Test key" }));
    expect(await screen.findByText("The API key was not accepted. Check it in Settings.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(clearAiKey).toHaveBeenCalledWith("anthropic"));
    expect(await screen.findByText("No key")).toBeTruthy();
  });

  it("saves the model override in settings", async () => {
    render(<AiSettings />);
    const model = screen.getByLabelText("Model") as HTMLInputElement;
    expect(model.placeholder).toBe("claude-opus-5-5");
    fireEvent.change(model, { target: { value: "claude-sonnet-5" } });
    expect(useSettingsStore.getState().settings.aiModel).toBe("claude-sonnet-5");
    await act(flushSettings);
  });
});
