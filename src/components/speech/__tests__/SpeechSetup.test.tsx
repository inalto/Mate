import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../model/constants";
import type { SpeechProviderInfo, SpeechStatus } from "../../../ipc/speech";

vi.mock("../../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../../ipc/app", () => ({ openExternal: vi.fn(async () => {}) }));
vi.mock("../../../ipc/speech", () => ({
  listSpeechProviders: vi.fn(),
  getSpeechStatus: vi.fn(),
  setSpeechKey: vi.fn(async () => {}),
  clearSpeechKey: vi.fn(async () => {}),
  transcribeAudio: vi.fn(),
}));

import { clearSpeechKey, getSpeechStatus, listSpeechProviders, setSpeechKey } from "../../../ipc/speech";
import { useSettingsStore } from "../../../stores/settings";
import { collectEntries } from "../../../routes/Settings/search";
import SpeechSetup from "../SpeechSetup";

const base = { needsKey: true, editableBaseUrl: false, local: false, keyUrl: "https://example.com/keys" };
const PROVIDERS: SpeechProviderInfo[] = [
  { ...base, id: "openai", label: "OpenAI", defaultBaseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini-transcribe" },
  { ...base, id: "groq", label: "Groq", defaultBaseUrl: "https://api.groq.com/openai/v1", defaultModel: "whisper-large-v3-turbo" },
  { ...base, id: "local", label: "Local server", needsKey: false, keyUrl: "", editableBaseUrl: true, local: true, defaultBaseUrl: "http://127.0.0.1:8000/v1", defaultModel: "whisper-1" },
];

let hasKey = false;
const status = (): SpeechStatus => {
  const s = useSettingsStore.getState().settings;
  const p = PROVIDERS.find((x) => x.id === s.speechProvider)!;
  return { configured: hasKey || !p.needsKey, hasKey, provider: p.id, model: p.defaultModel, baseUrl: p.defaultBaseUrl, consent: s.speechConsent === true, needsKey: p.needsKey, local: p.local };
};

beforeEach(() => {
  hasKey = false;
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true });
  vi.mocked(listSpeechProviders).mockResolvedValue(PROVIDERS);
  vi.mocked(getSpeechStatus).mockImplementation(async () => status());
  vi.mocked(setSpeechKey).mockImplementation(async () => {
    hasKey = true;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SpeechSetup", () => {
  it("lists the services and saves a key without keeping it", async () => {
    render(<SpeechSetup />);
    const picker = (await screen.findByLabelText("Speech service")) as HTMLSelectElement;
    await waitFor(() => expect(picker.options).toHaveLength(3));
    expect([...picker.options].map((o) => o.textContent)).toEqual(["OpenAI", "Groq", "Local server"]);
    expect(await screen.findByText("No key")).toBeTruthy();
    const key = screen.getByLabelText("API key") as HTMLInputElement;
    fireEvent.change(key, { target: { value: "sk-secret" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save key" })));
    expect(setSpeechKey).toHaveBeenCalledWith("openai", "sk-secret");
    expect(key.value).toBe("");
    expect(await screen.findByText("Key saved")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove key" })));
    expect(clearSpeechKey).toHaveBeenCalledWith("openai");
  });

  it("switching to a local server shows the address and hides the key", async () => {
    render(<SpeechSetup />);
    const picker = (await screen.findByLabelText("Speech service")) as HTMLSelectElement;
    await waitFor(() => expect(picker.options).toHaveLength(3));
    await act(async () => fireEvent.change(picker, { target: { value: "local" } }));
    expect(useSettingsStore.getState().settings.speechProvider).toBe("local");
    expect(screen.queryByLabelText("API key")).toBeNull();
    const address = screen.getByLabelText("Address") as HTMLInputElement;
    fireEvent.change(address, { target: { value: "http://example.com/v1" } });
    expect(address.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(address, { target: { value: "http://localhost:9000/v1" } });
    expect(address.getAttribute("aria-invalid")).toBe("false");
  });

  it("the consent box and the test button", async () => {
    render(<SpeechSetup />);
    await screen.findByText("No key");
    const consent = screen.getByRole("checkbox", { name: /Send recordings/ }) as HTMLInputElement;
    expect(consent.checked).toBe(false);
    fireEvent.click(consent);
    expect(useSettingsStore.getState().settings.speechConsent).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Test" })));
    expect(await screen.findByText(/Not set up yet/)).toBeTruthy();
  });

  it("indexes its rows for the settings search", async () => {
    render(<SpeechSetup />);
    await screen.findByText("No key");
    const ids = collectEntries(document.body).map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(["set-speechProvider", "set-speechKey", "set-speechModel", "set-speechConsent"]));
  });
});
