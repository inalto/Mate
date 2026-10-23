import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";

const ipc = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  relaunch: vi.fn(async () => {}),
  onUpdateProgress: vi.fn(),
}));
vi.mock("../../ipc/updater", () => ipc);
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.4.0") }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));

import { useSettingsStore } from "../../stores/settings";
import { useToastStore } from "../Toast";
import UpdateSection, { NOT_CONFIGURED_COPY, StartupUpdateCheck } from "../UpdateSection";

beforeEach(() => {
  useToastStore.getState().dismiss();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
  ipc.onUpdateProgress.mockImplementation(async () => () => {});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UpdateSection", () => {
  it("unsigned_or_missing_manifest_is_not_installed", async () => {
    ipc.checkForUpdate.mockResolvedValue({ configured: false, available: false });
    render(<UpdateSection />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText(NOT_CONFIGURED_COPY)).toBeTruthy();
    expect(NOT_CONFIGURED_COPY).toBe("Updates are not configured for this build.");
    expect(screen.queryByRole("button", { name: /^Install/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
    expect(ipc.installUpdate).not.toHaveBeenCalled();
  });

  it("update_flow_check_install_restart", async () => {
    ipc.checkForUpdate.mockResolvedValue({ configured: true, available: true, version: "0.5.0", notes: "Faster ink." });
    let emit: (p: { downloaded: number; total: number | null }) => void = () => {};
    ipc.onUpdateProgress.mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    let finish: () => void = () => {};
    ipc.installUpdate.mockImplementation(() => new Promise<void>((r) => (finish = r)));

    render(<UpdateSection />);
    expect(await screen.findByText("Mate 0.4.0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Install 0.5.0" }));

    await waitFor(() => expect(ipc.installUpdate).toHaveBeenCalled());
    // Until the first chunk arrives every window is being saved.
    expect(screen.getByText("Saving your work…")).toBeTruthy();
    expect(ipc.installUpdate).toHaveBeenCalledWith("0.5.0");
    act(() => emit({ downloaded: 1024 * 1024, total: 4 * 1024 * 1024 }));
    expect(await screen.findByText(/1\.0 MB of 4\.0 MB/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();

    await act(async () => finish());
    fireEvent.click(await screen.findByRole("button", { name: "Restart to update" }));
    expect(ipc.relaunch).toHaveBeenCalledTimes(1);
  });

  it("shows_up_to_date_and_errors_without_throwing", async () => {
    ipc.checkForUpdate.mockResolvedValueOnce({ configured: true, available: false });
    render(<UpdateSection />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("You are up to date.")).toBeTruthy();
    ipc.checkForUpdate.mockRejectedValueOnce("network down");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText(/network down/)).toBeTruthy();
  });
});

describe("StartupUpdateCheck", () => {
  it("startup_check_failure_is_silent", async () => {
    ipc.checkForUpdate.mockRejectedValue(new Error("offline"));
    render(<StartupUpdateCheck />);
    await waitFor(() => expect(ipc.checkForUpdate).toHaveBeenCalled());
    await act(async () => {});
    expect(useToastStore.getState().message).toBeNull();
  });

  it("toasts_only_when_an_update_is_available", async () => {
    ipc.checkForUpdate.mockResolvedValue({ configured: true, available: true, version: "0.5.0" });
    render(<StartupUpdateCheck />);
    await waitFor(() => expect(useToastStore.getState().message).toBe("Mate 0.5.0 is available."));
  });

  it("does_not_check_when_the_setting_is_off", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, checkUpdatesOnStartup: false }, loaded: true });
    render(<StartupUpdateCheck />);
    await act(async () => {});
    expect(ipc.checkForUpdate).not.toHaveBeenCalled();
  });
});
