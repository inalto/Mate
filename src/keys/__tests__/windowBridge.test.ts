import { describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/windows", () => ({ openPageWindow: vi.fn(async () => "page-p1") }));
const showToast = vi.fn();
vi.mock("../../components/Toast", () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import { openPageWindow } from "../../ipc/windows";
import { openPageInWindow } from "../windowBridge";

describe("window.openPage bridge", () => {
  it("window_open_page_shortcut_opens_a_page_window", async () => {
    openPageInWindow("p1");
    expect(openPageWindow).toHaveBeenCalledWith("p1");
    vi.mocked(openPageWindow).mockRejectedValueOnce(new Error("Mate is closing"));
    openPageInWindow("p2");
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());
  });
});
