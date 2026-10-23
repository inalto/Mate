import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/notebook", () => ({ getNotebookTree: vi.fn(async () => ({})) }));
vi.mock("../../ipc/app", () => ({ getAppVersion: vi.fn(async () => "0.5.0") }));

import { useNotebookStore } from "../../stores/notebook";
import { setNavigator } from "../../stores/navigation";
import { useSettingsStore } from "../../stores/settings";
import { resetFileLaunch, markFileLaunch } from "../fileLaunch";
import LaunchChecks from "../LaunchChecks";
import type { Page } from "../../model/types";

const nav = vi.fn();
const tree = (pages: Partial<Page>[]) =>
  ({ bookshelves: [], units: [], sections: [], pages }) as unknown as ReturnType<typeof useNotebookStore.getState>["tree"];

function setup(s: Partial<typeof DEFAULT_SETTINGS>, pages: Partial<Page>[] = []) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...s }, loaded: true });
  useNotebookStore.setState({ tree: tree(pages), loaded: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFileLaunch();
  setNavigator(nav);
});
afterEach(cleanup);

describe("LaunchChecks", () => {
  it("first run redirects to welcome and only remembers the version", async () => {
    setup({ onboardingDone: false });
    render(<LaunchChecks />);
    await waitFor(() => expect(useSettingsStore.getState().settings.lastSeenVersion).toBe("0.5.0"));
    expect(nav).toHaveBeenCalledWith("/welcome");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("existing_library_skips_welcome_and_shows_whats_new", async () => {
    setup({ onboardingDone: false, lastSeenVersion: "0.4.0" }, [{ id: "p1" }]);
    render(<LaunchChecks />);
    await screen.findByRole("dialog", { name: "What's new" });
    expect(nav).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().settings.onboardingDone).toBe(true);
  });

  it("trashed pages do not count as a library", async () => {
    setup({ onboardingDone: false }, [{ id: "p1", deletedAt: "2026-01-01T00:00:00Z" }]);
    render(<LaunchChecks />);
    await waitFor(() => expect(nav).toHaveBeenCalledWith("/welcome"));
  });

  it("pending_file_on_first_run_skips_welcome", async () => {
    setup({ onboardingDone: false });
    markFileLaunch();
    render(<LaunchChecks />);
    await waitFor(() => expect(useSettingsStore.getState().settings.onboardingDone).toBe(true));
    expect(nav).not.toHaveBeenCalled();
  });

  it("a file arriving after the check marks onboarding done", async () => {
    setup({ onboardingDone: false });
    render(<LaunchChecks />);
    await waitFor(() => expect(nav).toHaveBeenCalledWith("/welcome"));
    act(() => markFileLaunch());
    expect(useSettingsStore.getState().settings.onboardingDone).toBe(true);
  });

  it("does not re-show after finishing", async () => {
    setup({ onboardingDone: true, lastSeenVersion: "0.5.0" });
    render(<LaunchChecks />);
    await new Promise((r) => setTimeout(r, 20));
    expect(nav).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
