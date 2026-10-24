import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../model/constants";
import type { AiProviderInfo, AiStatus } from "../../../model/types";

vi.mock("../../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../../ipc/app", () => ({ openExternal: vi.fn(async () => {}) }));
vi.mock("../../../ipc/ai", () => ({
  setAiKey: vi.fn(async () => {}),
  clearAiKey: vi.fn(async () => {}),
  getAiStatus: vi.fn(),
  testAiKey: vi.fn(async () => {}),
  listAiProviders: vi.fn(),
  listAiModels: vi.fn(),
}));

import { clearAiKey, getAiStatus, listAiModels, listAiProviders, setAiKey, testAiKey } from "../../../ipc/ai";
import { openExternal } from "../../../ipc/app";
import { patchSettings } from "../../../ipc/settings";
import { collectEntries } from "../../../routes/Settings/search";
import { flushSettings, useSettingsStore } from "../../../stores/settings";
import AiSettings from "../../AiSettings";
import { NO_VISION_NOTE } from "../AiSetup";

const SECRET = "sk-test-very-secret";
const base = { canListModels: false, keyUrl: "", cost: "Paid", privacy: "Sent to the service.", defaultBaseUrl: "", editableBaseUrl: false };
const PROVIDERS: AiProviderInfo[] = [
  { ...base, id: "anthropic", label: "Anthropic", group: "cloud", needsKey: true, defaultModel: "claude-opus-5-5", vision: "yes", canListModels: true, keyUrl: "https://console.anthropic.com" },
  { ...base, id: "openai", label: "OpenAI", group: "cloud", needsKey: true, defaultModel: "gpt-5", vision: "yes" },
  { ...base, id: "deepseek", label: "DeepSeek", group: "cloud", needsKey: true, defaultModel: "deepseek-flash", vision: "no" },
  { ...base, id: "ollama", label: "Ollama", group: "local", needsKey: false, defaultModel: "qwen3-vl:8b", vision: "dependsOnModel", canListModels: true, editableBaseUrl: true, defaultBaseUrl: "http://localhost:11434", cost: "Free (local)" },
  { ...base, id: "custom", label: "Custom endpoint", group: "custom", needsKey: false, defaultModel: "", vision: "dependsOnModel", editableBaseUrl: true },
];
let status: AiStatus;

const statusFor = (id: string): AiStatus => {
  const p = PROVIDERS.find((x) => x.id === id)!;
  return { configured: !p.needsKey && id !== "custom", provider: id, model: p.defaultModel, consent: false, needsKey: p.needsKey, vision: p.vision, baseUrl: p.defaultBaseUrl };
};

beforeEach(() => {
  vi.clearAllMocks();
  status = statusFor("anthropic");
  vi.mocked(listAiProviders).mockResolvedValue(PROVIDERS);
  vi.mocked(getAiStatus).mockImplementation(async () => ({ ...status, provider: useSettingsStore.getState().settings.aiProvider }));
  vi.mocked(setAiKey).mockImplementation(async () => {
    status.configured = true;
  });
  vi.mocked(clearAiKey).mockImplementation(async () => {
    status.configured = false;
  });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
});
afterEach(cleanup);

const pick = async (label: string) => {
  fireEvent.click(await screen.findByRole("radio", { name: label }));
  await act(flushSettings);
};

describe("AiSetup", () => {
  it("lists providers in three groups", async () => {
    render(<AiSettings />);
    for (const title of ["Cloud services", "On this computer", "Custom"]) {
      expect(await screen.findByRole("group", { name: title })).toBeTruthy();
    }
    expect(within(screen.getByRole("group", { name: "On this computer" })).getByRole("radio", { name: "Ollama" })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Cloud services" })).getAllByRole("radio")).toHaveLength(3);
  });

  it("opens the explainer when nothing is configured and collapses it once set up", async () => {
    const { container } = render(<AiSettings />);
    await screen.findByRole("radio", { name: "Anthropic" });
    expect(container.querySelector("details")!.open).toBe(true);
    expect(screen.getByText("Checking handwritten maths (the tutor)")).toBeTruthy();
    cleanup();
    status.configured = true;
    const second = render(<AiSettings />);
    await waitFor(() => expect(second.container.querySelector("details")!.open).toBe(false));
  });

  it("selecting a provider resets model and address and opens its key link", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, aiModel: "old", aiBaseUrl: "http://x" } });
    render(<AiSettings />);
    await pick("OpenAI");
    const s = useSettingsStore.getState().settings;
    expect([s.aiProvider, s.aiModel, s.aiBaseUrl]).toEqual(["openai", "", ""]);
    expect((screen.getByLabelText("Model") as HTMLInputElement).placeholder).toBe("gpt-5");
    expect(screen.getByText(/to OpenAI to check your work/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Get a key" })[0]);
    expect(openExternal).toHaveBeenCalledWith("https://console.anthropic.com");
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
    await act(flushSettings);
    expect(JSON.stringify(useSettingsStore.getState().settings)).not.toContain(SECRET);
    for (const call of vi.mocked(patchSettings).mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET);
  });

  it("tests and removes a saved key and shows errors", async () => {
    status.configured = true;
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, aiConsent: true } });
    render(<AiSettings />);
    expect(await screen.findByText("Key saved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connection works.")).toBeTruthy();
    vi.mocked(testAiKey).mockRejectedValueOnce("The API key was not accepted. Check it in Settings.");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("The API key was not accepted. Check it in Settings.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(clearAiKey).toHaveBeenCalledWith("anthropic"));
    expect(await screen.findByText("No key")).toBeTruthy();
  });

  it("does not claim a cloud key works when permission is off", async () => {
    status.configured = true;
    render(<AiSettings />);
    await screen.findByText("Key saved");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/not tested/)).toBeTruthy();
  });

  it("local providers hide the key field and say nothing leaves the computer", async () => {
    render(<AiSettings />);
    await pick("Ollama");
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save key" })).toBeNull();
    expect(screen.getByText("No key needed")).toBeTruthy();
    expect(screen.getByText(/processed on this computer; nothing is sent to the internet/)).toBeTruthy();
    const address = screen.getByLabelText("Address") as HTMLInputElement;
    expect(address.placeholder).toBe("http://localhost:11434");
    fireEvent.change(address, { target: { value: "http://192.168.1.5:11434" } });
    expect(useSettingsStore.getState().settings.aiBaseUrl).toBe("http://192.168.1.5:11434");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connection works.")).toBeTruthy();
    expect(testAiKey).toHaveBeenCalledWith("ollama");
    await act(flushSettings);
  });

  it("custom shows an optional key and an address", async () => {
    render(<AiSettings />);
    await pick("Custom endpoint");
    expect(screen.getByLabelText("API key (optional)")).toBeTruthy();
    expect(screen.getByLabelText("Address")).toBeTruthy();
    expect(screen.getByText("No key (optional)")).toBeTruthy();
  });

  it("fetch models fills the datalist and shows errors", async () => {
    vi.mocked(listAiModels).mockResolvedValueOnce(["claude-a", "claude-b"]);
    const { container } = render(<AiSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Fetch models" }));
    expect(await screen.findByText("Found 2 models.")).toBeTruthy();
    expect([...container.querySelectorAll("datalist option")].map((o) => (o as HTMLOptionElement).value)).toEqual(["claude-a", "claude-b"]);
    vi.mocked(listAiModels).mockRejectedValueOnce("Could not reach the service.");
    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    expect(await screen.findByText("Could not reach the service.")).toBeTruthy();
  });

  it("a text-only provider shows the tutor note", async () => {
    render(<AiSettings />);
    await screen.findByRole("radio", { name: "Anthropic" });
    expect(screen.queryByText(NO_VISION_NOTE)).toBeNull();
    status = statusFor("deepseek");
    await pick("DeepSeek");
    expect(await screen.findByText(NO_VISION_NOTE)).toBeTruthy();
  });

  it("provider cards are searchable by label", async () => {
    const { container } = render(
      <div data-section-id="tutor" data-section-title="Tutor">
        <AiSettings />
      </div>,
    );
    await screen.findByRole("radio", { name: "DeepSeek" });
    const labels = collectEntries(container).map((e) => e.label);
    expect(labels).toEqual(expect.arrayContaining(["Anthropic", "DeepSeek", "Ollama"]));
  });
});
