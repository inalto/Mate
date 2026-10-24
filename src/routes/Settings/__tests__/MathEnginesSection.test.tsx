import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../ipc/math", () => ({
  wolframStatus: vi.fn(),
  setWolframAppid: vi.fn(async () => {}),
  clearWolframAppid: vi.fn(async () => {}),
  testWolframAppid: vi.fn(async () => {}),
}));
vi.mock("../../../ipc/app", () => ({ openExternal: vi.fn(async () => {}) }));
vi.mock("../../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { openExternal } from "../../../ipc/app";
import { clearWolframAppid, setWolframAppid, testWolframAppid, wolframStatus } from "../../../ipc/math";
import { DEFAULT_SETTINGS } from "../../../model/constants";
import { useSettingsStore } from "../../../stores/settings";
import MathEnginesSection, { EXPLAINER } from "../sections/MathEnginesSection";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(wolframStatus).mockResolvedValue({ configured: false, consent: false });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
});
afterEach(cleanup);

const input = () => screen.getByLabelText("Wolfram|Alpha AppID") as HTMLInputElement;
const btn = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("MathEnginesSection", () => {
  it("explains the two engines and links to the developer site", async () => {
    render(<MathEnginesSection />);
    expect(screen.getByRole("heading", { level: 2, name: "Maths engines" })).toBeTruthy();
    expect(screen.getByText(EXPLAINER)).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "developer.wolframalpha.com" }));
    expect(openExternal).toHaveBeenCalledWith("https://developer.wolframalpha.com/");
    await waitFor(() => expect(wolframStatus).toHaveBeenCalled());
  });

  it("saves the AppID, clears the field and shows it as saved", async () => {
    render(<MathEnginesSection />);
    expect(btn("Save").disabled).toBe(true);
    expect(btn("Test").disabled).toBe(true);
    fireEvent.change(input(), { target: { value: " abc-123 " } });
    vi.mocked(wolframStatus).mockResolvedValue({ configured: true, consent: false });
    fireEvent.click(btn("Save"));
    await waitFor(() => expect(setWolframAppid).toHaveBeenCalledWith(" abc-123 "));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("AppID saved"));
    expect(input().value).toBe("");
    expect(input().type).toBe("password");
  });

  it("tests and removes a saved AppID, showing errors as plain text", async () => {
    vi.mocked(wolframStatus).mockResolvedValue({ configured: true, consent: false });
    render(<MathEnginesSection />);
    await waitFor(() => expect(btn("Test").disabled).toBe(false));
    fireEvent.click(btn("Test"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("The AppID works."));
    expect(testWolframAppid).toHaveBeenCalledTimes(1);
    vi.mocked(testWolframAppid).mockRejectedValueOnce("The AppID was not accepted. Check it in Settings.");
    fireEvent.click(btn("Test"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("The AppID was not accepted. Check it in Settings."));
    vi.mocked(wolframStatus).mockResolvedValue({ configured: false, consent: false });
    fireEvent.click(btn("Remove"));
    await waitFor(() => expect(clearWolframAppid).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("No AppID"));
  });

  it("the consent toggle writes wolframConsent", async () => {
    render(<MathEnginesSection />);
    const box = screen.getByLabelText("Send typed maths to Wolfram|Alpha when I ask") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(useSettingsStore.getState().settings.wolframConsent).toBe(true));
  });
});
