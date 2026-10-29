import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../model/constants";

vi.mock("../../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../../ipc/speech", () => ({
  listSpeechProviders: vi.fn(async () => [{ id: "openai", label: "OpenAI" }]),
  getSpeechStatus: vi.fn(async () => ({ configured: true })),
  transcribeAudio: vi.fn(),
}));

import { cancelDictation, useDictation } from "../../../speech/dictate";
import { useSettingsStore } from "../../../stores/settings";
import { DictateButton } from "../../DictateButton";

beforeEach(() => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true }));
afterEach(() => {
  cleanup();
  cancelDictation();
});

describe("DictateButton", () => {
  it("first press asks for consent; Not now closes the question", async () => {
    render(<DictateButton />);
    const btn = screen.getByRole("button", { name: "Dictate" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(btn));
    const dialog = screen.getByRole("alertdialog", { name: "Send recordings to OpenAI?" });
    expect(dialog).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Not now" })));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows the recording and transcribing states", () => {
    render(<DictateButton />);
    act(() => useDictation.setState({ phase: "recording", startedAt: Date.now() }));
    const stop = screen.getByRole("button", { name: "Stop dictating" });
    expect(stop.getAttribute("aria-pressed")).toBe("true");
    expect(stop.textContent).toContain("0:00");
    act(() => useDictation.setState({ phase: "transcribing", startedAt: null }));
    expect((screen.getByRole("button", { name: "Transcribing…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is disabled while starting, and unmounting cancels dictation", () => {
    const { unmount } = render(<DictateButton />);
    act(() => useDictation.setState({ phase: "starting", startedAt: null }));
    expect((screen.getByRole("button", { name: "Dictate" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => useDictation.setState({ phase: "recording", startedAt: Date.now() }));
    unmount();
    expect(useDictation.getState().phase).toBe("idle");
  });

  it("renders the consent question on <body>, outside the toolbar", async () => {
    render(
      <div className="toolbar">
        <DictateButton />
      </div>,
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Dictate" })));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.closest(".toolbar")).toBeNull();
    expect(dialog.closest(".backdrop")?.parentElement).toBe(document.body);
    expect(document.activeElement?.textContent).toBe("Not now");
  });
});
