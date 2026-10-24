import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../model/constants";
import type { AiProviderInfo, AiStatus, Settings } from "../../../model/types";

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
import i18n, { loadLanguage } from "../../../i18n";

const NO_VISION_NOTE = i18n.t("ai.noVision");

const SECRET = "sk-test-very-secret";
const base = { canListModels: false, keyUrl: "", cost: "paid", privacy: "sentTo", defaultBaseUrl: "", editableBaseUrl: false } as const;
const PROVIDERS: AiProviderInfo[] = [
  { ...base, id: "anthropic", label: "Anthropic", group: "cloud", needsKey: true, defaultModel: "claude-opus-5-5", vision: "yes", canListModels: true, keyUrl: "https://console.anthropic.com" },
  { ...base, id: "openai", label: "OpenAI", group: "cloud", needsKey: true, defaultModel: "gpt-5", vision: "yes" },
  { ...base, id: "deepseek", label: "DeepSeek", group: "cloud", needsKey: true, defaultModel: "deepseek-flash", vision: "no", cost: "paidLow", privacy: "textSentTo" },
  { ...base, id: "ollama", label: "Ollama", group: "local", needsKey: false, defaultModel: "qwen3-vl:8b", vision: "dependsOnModel", canListModels: true, editableBaseUrl: true, defaultBaseUrl: "http://localhost:11434", cost: "freeLocal", privacy: "local" },
  { ...base, id: "lmstudio", label: "LM Studio", group: "local", needsKey: false, defaultModel: "", vision: "dependsOnModel", canListModels: true, editableBaseUrl: true, defaultBaseUrl: "http://localhost:1234", cost: "freeLocal", privacy: "local" },
  { ...base, id: "custom", label: "Custom endpoint", group: "custom", needsKey: false, defaultModel: "", vision: "dependsOnModel", editableBaseUrl: true, cost: "depends", privacy: "custom" },
];

/** Keys stored per provider (the fake keychain). */
let keys: Set<string>;

/** The Rust status rules: configured = key (cloud) / always (local) / an address (custom). */
const statusOf = (s: Settings): AiStatus => {
  const p = PROVIDERS.find((x) => x.id === s.aiProvider)!;
  const typed = s.aiBaseUrl.trim();
  const url = typed || p.defaultBaseUrl;
  const localHost = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.)/.test(url);
  const valid = typed === "" || url.startsWith("https://") || localHost;
  const hasKey = keys.has(p.id);
  return {
    configured: valid && (p.needsKey ? hasKey : p.group === "local" || url !== ""),
    hasKey,
    local: valid && p.group !== "cloud" && localHost,
    provider: p.id,
    model: s.aiModel || p.defaultModel,
    consent: s.aiConsent === true,
    needsKey: p.needsKey,
    vision: p.vision,
    baseUrl: url,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  keys = new Set();
  vi.mocked(listAiProviders).mockResolvedValue(PROVIDERS);
  vi.mocked(getAiStatus).mockImplementation(async () => statusOf(useSettingsStore.getState().settings));
  vi.mocked(setAiKey).mockImplementation(async (id) => {
    keys.add(id);
  });
  vi.mocked(clearAiKey).mockImplementation(async (id) => {
    keys.delete(id);
  });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
});
afterEach(cleanup);

const pick = async (label: string) => {
  fireEvent.click(await screen.findByRole("radio", { name: label }));
  await act(flushSettings);
};

const statusLine = () => screen.getByRole("status").textContent ?? "";

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
    keys.add("anthropic");
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
    expect(input.placeholder).toBe("Saved (hidden)");
    await act(flushSettings);
    expect(JSON.stringify(useSettingsStore.getState().settings)).not.toContain(SECRET);
    for (const call of vi.mocked(patchSettings).mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET);
  });

  it("tests and removes a saved key and shows errors", async () => {
    keys.add("anthropic");
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
    keys.add("anthropic");
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
    expect(screen.getByText("Nothing leaves this computer.")).toBeTruthy();
    const address = screen.getByLabelText("Address") as HTMLInputElement;
    expect(address.placeholder).toBe("http://localhost:11434");
    fireEvent.change(address, { target: { value: "http://192.168.1.5:11434" } });
    expect(useSettingsStore.getState().settings.aiBaseUrl).toBe("http://192.168.1.5:11434");
    expect(screen.getByText(/processed on this computer/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connection works.")).toBeTruthy();
    expect(testAiKey).toHaveBeenCalledWith("ollama");
    await act(flushSettings);
  });

  it("a local provider at a remote address does not claim to stay on this computer", async () => {
    render(<AiSettings />);
    await pick("Ollama");
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "https://ollama.example.com" } });
    await act(flushSettings);
    await waitFor(() => expect(screen.getByText("Your handwriting and text are sent to the address above.")).toBeTruthy());
    expect(screen.queryByText(/processed on this computer/)).toBeNull();
    expect(screen.queryByText("Nothing leaves this computer.")).toBeNull();
    expect(screen.getByText(/to the server at the address above/)).toBeTruthy();
  });

  it("refuses a plain http address that is not local", async () => {
    render(<AiSettings />);
    await pick("Custom endpoint");
    const address = screen.getByLabelText("Address");
    const error = "Use an https:// address, or a local address such as http://localhost:11434.";
    expect(screen.queryByText(error)).toBeNull();
    fireEvent.change(address, { target: { value: "http://api.example.com" } });
    expect(screen.getByText(error)).toBeTruthy();
    fireEvent.change(address, { target: { value: "http://localhost:8080" } });
    expect(screen.queryByText(error)).toBeNull();
    fireEvent.change(address, { target: { value: "https://api.example.com" } });
    expect(screen.queryByText(error)).toBeNull();
    await act(flushSettings);
  });

  it("custom shows an optional key and an address", async () => {
    render(<AiSettings />);
    await pick("Custom endpoint");
    expect(screen.getByLabelText("API key (optional)")).toBeTruthy();
    expect(screen.getByLabelText("Address")).toBeTruthy();
    expect(screen.getByText("No key (optional)")).toBeTruthy();
  });

  it("custom with an address and no key: no key, nothing to remove", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, aiProvider: "custom", aiBaseUrl: "https://api.example.com" } });
    render(<AiSettings />);
    await waitFor(() => expect(getAiStatus).toHaveBeenCalled());
    expect(await screen.findByText("No key (optional)")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Remove key" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("API key (optional)") as HTMLInputElement).placeholder).not.toBe("Saved (hidden)");
    expect(statusLine()).not.toContain("Enter the address");
  });

  it("custom with a key and no address: key saved, address missing", async () => {
    keys.add("custom");
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, aiProvider: "custom", aiModel: "m" } });
    render(<AiSettings />);
    expect(await screen.findByText("Key saved")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Remove key" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("API key (optional)") as HTMLInputElement).placeholder).toBe("Saved (hidden)");
    expect(statusLine()).toContain("Enter the address of the service.");
  });

  it("asks for a model name where there is no default", async () => {
    render(<AiSettings />);
    await pick("LM Studio");
    const model = screen.getByLabelText("Model") as HTMLInputElement;
    expect(model.placeholder).toBe("Type the model name");
    expect(statusLine()).toContain("Enter a model name.");
    fireEvent.change(model, { target: { value: "qwen" } });
    expect(statusLine()).not.toContain("Enter a model name.");
    await act(flushSettings);
  });

  it("hints at a vision model when it depends on the model", async () => {
    const hint = "Pick a model that can read images, or the tutor cannot check handwriting.";
    render(<AiSettings />);
    await screen.findByRole("radio", { name: "Anthropic" });
    expect(screen.queryByText(hint)).toBeNull();
    await pick("Ollama");
    expect(screen.getByText(hint)).toBeTruthy();
  });

  it("fetch models fills the datalist, says what it sends and shows errors", async () => {
    vi.mocked(listAiModels).mockResolvedValueOnce(["claude-a", "claude-b"]);
    const { container } = render(<AiSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Fetch models" }));
    expect(screen.getByText("Sends your key to Anthropic to list its models; nothing else is sent.")).toBeTruthy();
    expect(await screen.findByText("Found 2 models.")).toBeTruthy();
    expect([...container.querySelectorAll("datalist option")].map((o) => (o as HTMLOptionElement).value)).toEqual(["claude-a", "claude-b"]);
    vi.mocked(listAiModels).mockRejectedValueOnce("Could not reach the service.");
    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    expect(await screen.findByText("Could not reach the service.")).toBeTruthy();
  });

  it("a text-only provider shows the tutor note under the picker and asks to send text only", async () => {
    render(<AiSettings />);
    await screen.findByRole("radio", { name: "Anthropic" });
    expect(screen.queryByText(NO_VISION_NOTE)).toBeNull();
    await pick("DeepSeek");
    const note = await screen.findByText(NO_VISION_NOTE);
    const picker = screen.getByRole("group", { name: "Custom" });
    const model = screen.getByLabelText("Model");
    expect(picker.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const consent = screen.getByText(/Send the text of your notes to DeepSeek/);
    expect(consent.textContent).not.toMatch(/image|handwriting/i);
  });

  it("words cost and privacy codes in the interface language", async () => {
    render(<AiSettings />);
    await screen.findByRole("radio", { name: "Anthropic" });
    expect(screen.getAllByText("Cost: Paid").length).toBeGreaterThan(0);
    expect(screen.getByText("Cost: Paid, low cost")).toBeTruthy();
    expect(screen.getByText("Cost: Depends on the service")).toBeTruthy();
    expect(screen.getAllByText("Cost: Free (runs on this computer)")).toHaveLength(2);
    expect(screen.getByText("Checked notes are sent to Anthropic.")).toBeTruthy();
    await pick("DeepSeek");
    expect(screen.getByText("Text is sent to DeepSeek.")).toBeTruthy();
    await pick("Custom endpoint");
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "http://localhost:8080" } });
    await act(flushSettings);
    expect(await screen.findByText("Checked notes are sent to the address you enter.")).toBeTruthy();
  });

  it("puts notes under the input row, after its buttons", async () => {
    render(<AiSettings />);
    const button = await screen.findByRole("button", { name: "Fetch models" });
    const note = screen.getByText("Sends your key to Anthropic to list its models; nothing else is sent.");
    const body = button.closest(".ai-field-body");
    expect(body).toBeTruthy();
    expect(button.closest(".ai-row")?.parentElement).toBe(body);
    expect(note.parentElement).toBe(body);
    expect(note.closest(".ai-row")).toBeNull();
    expect(button.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText("Model").closest(".ai-row")).toBe(button.closest(".ai-row"));
    // Status: the text and the Test button share a row; the result goes underneath.
    const test = screen.getByRole("button", { name: "Test connection" });
    expect(test.closest(".ai-row")).toBe(screen.getByRole("status").closest(".ai-row"));
    // Icons are decorative.
    for (const svg of button.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows setup errors from Rust in the interface language", async () => {
    expect(await loadLanguage("it")).toBe(true);
    await i18n.changeLanguage("it");
    try {
      keys.add("anthropic");
      render(<AiSettings />);
      expect(await screen.findByText("Costo: A pagamento, costo basso")).toBeTruthy();
      expect(screen.getByText("Gli appunti da controllare vengono inviati al servizio Anthropic.")).toBeTruthy();
      vi.mocked(testAiKey).mockRejectedValueOnce({ kind: "noKey", message: "Save an API key first." });
      fireEvent.click(await screen.findByRole("button", { name: "Prova la connessione" }));
      expect(await screen.findByText("Prima salva una chiave API.")).toBeTruthy();
      vi.mocked(listAiModels).mockRejectedValueOnce({
        kind: "unreachable",
        message: "Could not reach Ollama at http://localhost:11434. Is it running?",
        detail: "Ollama (http://localhost:11434)",
      });
      fireEvent.click(screen.getByRole("button", { name: "Scarica i modelli" }));
      expect(await screen.findByText("Non riesco a raggiungere Ollama (http://localhost:11434). È avviato?")).toBeTruthy();
      vi.mocked(listAiModels).mockRejectedValueOnce({ kind: "badAddress", message: "Use an https:// address…" });
      fireEvent.click(screen.getByRole("button", { name: "Scarica i modelli" }));
      expect(await screen.findByText(/^Usa un indirizzo https:\/\//)).toBeTruthy();
    } finally {
      await i18n.changeLanguage("en");
    }
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
