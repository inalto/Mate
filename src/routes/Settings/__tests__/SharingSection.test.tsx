import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../ipc/share", () => ({
  nextcloudStatus: vi.fn(),
  nextcloudLoginStart: vi.fn(async () => {}),
  nextcloudLoginPoll: vi.fn(),
  nextcloudLogout: vi.fn(async () => {}),
}));

import { nextcloudLoginPoll, nextcloudLoginStart, nextcloudLogout, nextcloudStatus } from "../../../ipc/share";
import SharingSection, { SIGN_IN_TIMEOUT_MS } from "../sections/SharingSection";

const out = { signedIn: false, server: "", user: "" };
const inn = { signedIn: true, server: "https://cloud.example.com", user: "ana" };
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(nextcloudStatus).mockResolvedValue(out);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const signInFlow = async () => {
  render(<SharingSection />);
  await tick(0);
  fireEvent.change(screen.getByLabelText("Nextcloud server address"), { target: { value: "https://cloud.example.com" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign in" })); });
};

describe("SharingSection", () => {
  it("signs in by polling every 2 seconds until done", async () => {
    vi.mocked(nextcloudLoginPoll).mockResolvedValueOnce({ done: false }).mockResolvedValueOnce({ done: true });
    await signInFlow();
    expect(nextcloudLoginStart).toHaveBeenCalledWith("https://cloud.example.com");
    expect(screen.getByText(/Waiting for you to approve/)).toBeTruthy();
    await tick(1900);
    expect(nextcloudLoginPoll).not.toHaveBeenCalled();
    await tick(200);
    expect(nextcloudLoginPoll).toHaveBeenCalledTimes(1);
    vi.mocked(nextcloudStatus).mockResolvedValue(inn);
    await tick(2000);
    expect(nextcloudLoginPoll).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Signed in as ana on https:\/\/cloud\.example\.com/)).toBeTruthy();
    await tick(6000);
    expect(nextcloudLoginPoll).toHaveBeenCalledTimes(2);
  });

  it("stops polling when cancelled", async () => {
    vi.mocked(nextcloudLoginPoll).mockResolvedValue({ done: false });
    await signInFlow();
    await tick(2100);
    expect(nextcloudLoginPoll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await tick(6000);
    expect(nextcloudLoginPoll).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("shows an error when sign-in cannot start", async () => {
    vi.mocked(nextcloudLoginStart).mockRejectedValueOnce("That address is not a Nextcloud server");
    await signInFlow();
    expect(screen.getByRole("alert").textContent).toContain("not a Nextcloud server");
    expect(nextcloudLoginPoll).not.toHaveBeenCalled();
  });

  it("keeps polling through a few failures, then shows the error and stops", async () => {
    vi.mocked(nextcloudLoginPoll).mockRejectedValue("Could not reach the server");
    await signInFlow();
    await tick(2000 * 4 + 100);
    expect(nextcloudLoginPoll).toHaveBeenCalledTimes(4);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/Waiting for you to approve/)).toBeTruthy();
    await tick(2000);
    expect(nextcloudLoginPoll).toHaveBeenCalledTimes(5);
    expect(screen.getByRole("alert").textContent).toContain("Could not reach the server");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    await tick(6000);
    expect(nextcloudLoginPoll).toHaveBeenCalledTimes(5);
  });

  it("a success resets the failure count", async () => {
    vi.mocked(nextcloudLoginPoll)
      .mockRejectedValueOnce("x")
      .mockRejectedValueOnce("x")
      .mockRejectedValueOnce("x")
      .mockRejectedValueOnce("x")
      .mockResolvedValueOnce({ done: false })
      .mockRejectedValueOnce("x")
      .mockRejectedValueOnce("x")
      .mockResolvedValueOnce({ done: true });
    await signInFlow();
    vi.mocked(nextcloudStatus).mockResolvedValue(inn);
    await tick(2000 * 8 + 100);
    expect(nextcloudLoginPoll).toHaveBeenCalledTimes(8);
    expect(screen.getByText(/Signed in as ana/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("gives up after 20 minutes", async () => {
    vi.mocked(nextcloudLoginPoll).mockResolvedValue({ done: false });
    await signInFlow();
    await tick(SIGN_IN_TIMEOUT_MS - 1000);
    expect(screen.getByText(/Waiting for you to approve/)).toBeTruthy();
    const calls = vi.mocked(nextcloudLoginPoll).mock.calls.length;
    await tick(2000);
    expect(screen.getByRole("alert").textContent).toContain("The sign-in link has expired. Start again.");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    await tick(10000);
    expect(vi.mocked(nextcloudLoginPoll).mock.calls.length).toBeLessThanOrEqual(calls + 1);
    expect(SIGN_IN_TIMEOUT_MS).toBe(20 * 60 * 1000);
  });

  it("signs out", async () => {
    vi.mocked(nextcloudStatus).mockResolvedValueOnce(inn).mockResolvedValue(out);
    render(<SharingSection />);
    await tick(0);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await tick(0);
    expect(nextcloudLogout).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });
});
