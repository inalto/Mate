import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastHost, showToast, useToastStore } from "../Toast";

beforeEach(() => {
  useToastStore.setState({ message: null, action: null, persistent: false, expiresAfterMs: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("close-anyway toast", () => {
  it("expires_after_its_own_timeout_even_with_an_action", () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => showToast("Saved a recovery file", { label: "Close anyway", onClick: () => {} }, { expiresAfterMs: 30_000 }));
    act(() => void vi.advanceTimersByTime(29_000));
    expect(screen.getByRole("alert")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(1_100));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an_action_toast_without_expiry_still_waits_for_the_user", () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => showToast("x", { label: "Do", onClick: () => {} }));
    act(() => void vi.advanceTimersByTime(120_000));
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
