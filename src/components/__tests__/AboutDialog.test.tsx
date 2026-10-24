import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  relaunch: vi.fn(async () => {}),
  onUpdateProgress: vi.fn(),
}));
vi.mock("../../ipc/updater", () => ipc);
vi.mock("../../ipc/app", () => ({ getAppVersion: vi.fn(async () => "0.5.1") }));
const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { useChromeStore } from "../../stores/chrome";
import AboutDialog from "../AboutDialog";
import TopBar from "../TopBar";

beforeEach(() => {
  useChromeStore.setState({ modalDepth: 0, updateAvailable: null, aboutOpen: false });
  ipc.onUpdateProgress.mockImplementation(async () => () => {});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AboutDialog", () => {
  it("about_shows_version_and_star_link", async () => {
    render(<AboutDialog onClose={() => {}} />);
    expect(await screen.findByText("Version 0.5.1")).toBeTruthy();
    expect(screen.getByText("Local-first handwriting and math notes.")).toBeTruthy();
    expect(screen.getByText("If Mate is useful to you, a star on GitHub helps others find it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Star on GitHub" }));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/inalto/Mate");
  });

  it("about_checks_for_updates_and_offers_install", async () => {
    ipc.checkForUpdate.mockResolvedValue({ configured: true, available: true, version: "0.6.0" });
    let emit: (p: { downloaded: number; total: number | null }) => void = () => {};
    ipc.onUpdateProgress.mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    let finish: () => void = () => {};
    ipc.installUpdate.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    render(<AboutDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Version 0.6.0 is available")).toBeTruthy();
    expect(useChromeStore.getState().updateAvailable).toBe("0.6.0");
    fireEvent.click(screen.getByRole("button", { name: "Install 0.6.0" }));
    await waitFor(() => expect(ipc.installUpdate).toHaveBeenCalledWith("0.6.0"));
    act(() => emit({ downloaded: 1024 * 1024, total: 4 * 1024 * 1024 }));
    expect(await screen.findByText("Downloading 0.6.0: 1.0 MB of 4.0 MB")).toBeTruthy();
    await act(async () => finish());
    fireEvent.click(await screen.findByRole("button", { name: "Restart to update" }));
    expect(ipc.relaunch).toHaveBeenCalled();
  });

  it("about_up_to_date_and_not_configured_copy", async () => {
    ipc.checkForUpdate.mockResolvedValueOnce({ configured: true, available: false });
    render(<AboutDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("You have the latest version")).toBeTruthy();
  });

  it("about_not_configured_copy", async () => {
    ipc.checkForUpdate.mockResolvedValue({ configured: false, available: false });
    render(<AboutDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Updates are not configured for this build.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Install/ })).toBeNull();
  });

  it("about_is_modal_and_closes_on_escape", () => {
    const onClose = vi.fn();
    const { unmount } = render(<AboutDialog onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Mate" })).toBeTruthy();
    expect(useChromeStore.getState().modalDepth).toBe(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(useChromeStore.getState().modalDepth).toBe(0);
  });

  it("about_closes_on_backdrop", () => {
    const onClose = vi.fn();
    const { container } = render(<AboutDialog onClose={onClose} />);
    fireEvent.mouseDown(container.querySelector(".backdrop")!);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("More menu", () => {
  const renderBar = () =>
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>,
    );

  it("menu_badge_when_update_available", () => {
    renderBar();
    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
    act(() => useChromeStore.getState().setUpdateAvailable("0.6.0"));
    expect(screen.getByRole("button", { name: "More actions, update available" })).toBeTruthy();
  });

  it("menu_opens_about", async () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "About Mate" }));
    expect(await screen.findByRole("dialog", { name: "Mate" })).toBeTruthy();
  });
});
