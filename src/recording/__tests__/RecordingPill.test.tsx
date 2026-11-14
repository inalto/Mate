// The top bar's recording pill and the banner for time lost in the background.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { useRecording } from "../session";
import { RecordingGapBanner, RecordingPill } from "../RecordingPill";

const real = useRecording.getState();
const stop = vi.fn(async () => null);

beforeEach(() => {
  useRecording.setState({ ...real, phase: "idle", stop });
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  useRecording.setState(real);
});

const both = () => (
  <>
    <RecordingPill />
    <RecordingGapBanner />
  </>
);

describe("RecordingPill", () => {
  it("is hidden while idle", () => {
    const { container } = render(both());
    expect(container.textContent).toBe("");
  });

  it("the pill shows the elapsed time and the gap banner until dismissed", () => {
    useRecording.setState({ phase: "recording", elapsedMs: 125_000, lostMs: 30_000 });
    render(both());
    const pill = screen.getByRole("button", { name: "Recording 2:05" });
    expect(pill.querySelector(".rec-dot")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("0:30 was not recorded while Mate was in the background.");
    // It does not time out.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(useRecording.getState().lostMs).toBeNull();
    // The pill opens the same menu as the toolbar button.
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop recording" }));
    expect(stop).toHaveBeenCalled();
  });

  it("says Paused while paused", () => {
    useRecording.setState({ phase: "paused", elapsedMs: 9_000 });
    render(both());
    expect(screen.getByRole("button", { name: "Paused 0:09" })).toBeTruthy();
  });
});
