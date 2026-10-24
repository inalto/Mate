import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Unit } from "../../model/types";

vi.mock("../../ipc/share", () => ({
  detectSyncFolders: vi.fn(),
  saveArchiveTo: vi.fn(),
  pickFolder: vi.fn(),
  nextcloudStatus: vi.fn(),
  nextcloudShare: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));
vi.mock("../../stores/navigation", () => ({ navigateTo: vi.fn() }));

import { navigateTo } from "../../stores/navigation";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { detectSyncFolders, nextcloudShare, nextcloudStatus, pickFolder, saveArchiveTo, type SyncFolder } from "../../ipc/share";
import ShareDialog from "../ShareDialog";

const unit = { id: "u1", title: "Algebra" } as Unit;
const onClose = vi.fn();
const signedOut = { signedIn: false, server: "", user: "" };
const signedIn = { signedIn: true, server: "https://cloud.example.com", user: "ana" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(detectSyncFolders).mockResolvedValue([{ service: "dropbox", label: "Dropbox", path: "C:/Dropbox" }]);
  vi.mocked(nextcloudStatus).mockResolvedValue(signedOut);
});
afterEach(cleanup);

describe("ShareDialog", () => {
  it("saves a copy to a detected folder and can reveal it", async () => {
    vi.mocked(saveArchiveTo).mockResolvedValue("C:/Dropbox/Mate/Algebra.mate");
    render(<ShareDialog unit={unit} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Share Algebra" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Dropbox" }));
    expect(await screen.findByText(/C:\/Dropbox\/Mate\/Algebra\.mate/)).toBeTruthy();
    expect(saveArchiveTo).toHaveBeenCalledWith("u1", "C:/Dropbox");
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(revealItemInDir).toHaveBeenCalledWith("C:/Dropbox/Mate/Algebra.mate");
  });

  it("lets the user choose another folder, and ignores cancel", async () => {
    vi.mocked(pickFolder).mockResolvedValueOnce(null).mockResolvedValueOnce("D:/Shared");
    vi.mocked(saveArchiveTo).mockResolvedValue("D:/Shared/Mate/Algebra.mate");
    render(<ShareDialog unit={unit} onClose={onClose} />);
    const choose = await screen.findByRole("button", { name: "Choose another folder…" });
    fireEvent.click(choose);
    await waitFor(() => expect(pickFolder).toHaveBeenCalledTimes(1));
    expect(saveArchiveTo).not.toHaveBeenCalled();
    await waitFor(() => expect((choose as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(choose);
    expect(await screen.findByText(/D:\/Shared\/Mate\/Algebra\.mate/)).toBeTruthy();
    expect(saveArchiveTo).toHaveBeenCalledWith("u1", "D:/Shared");
  });

  it("shows an inline error when saving fails", async () => {
    vi.mocked(saveArchiveTo).mockRejectedValue("disk full");
    render(<ShareDialog unit={unit} onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dropbox" }));
    expect((await screen.findByRole("alert")).textContent).toContain("disk full");
  });

  it("says it is looking for folders until the search ends", async () => {
    let resolve!: (v: SyncFolder[]) => void;
    vi.mocked(detectSyncFolders).mockReturnValue(new Promise((r) => (resolve = r)));
    render(<ShareDialog unit={unit} onClose={onClose} />);
    expect(screen.getByText("Looking for synced folders…")).toBeTruthy();
    expect(screen.queryByText(/No synced folders found/)).toBeNull();
    await act(async () => resolve([]));
    expect(screen.queryByText("Looking for synced folders…")).toBeNull();
    expect(screen.getByText(/No synced folders found/)).toBeTruthy();
  });

  it("points to Settings when Nextcloud is not set up", async () => {
    render(<ShareDialog unit={unit} onClose={onClose} />);
    const setUp = await screen.findByRole("button", { name: "Set up in Settings" });
    expect(screen.queryByRole("button", { name: "Upload and get link" })).toBeNull();
    fireEvent.click(setUp);
    expect(onClose).toHaveBeenCalled();
    expect(navigateTo).toHaveBeenCalledWith("/settings#sharing");
  });

  it("warns that the link is public and defaults to 30 days", async () => {
    vi.mocked(nextcloudStatus).mockResolvedValue(signedIn);
    render(<ShareDialog unit={unit} onClose={onClose} />);
    const select = (await screen.findByLabelText("Link expires")) as HTMLSelectElement;
    expect(select.value).toBe("30");
    expect(screen.getByText("Anyone with the link can download this book.")).toBeTruthy();
  });

  it("uploads with the chosen expiry and copies the link", async () => {
    vi.mocked(nextcloudStatus).mockResolvedValue(signedIn);
    vi.mocked(nextcloudShare).mockResolvedValue({ url: "https://cloud.example.com/s/abc", path: "/Mate/Algebra.mate" });
    render(<ShareDialog unit={unit} onClose={onClose} />);
    const select = await screen.findByLabelText("Link expires");
    fireEvent.change(select, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload and get link" }));
    const link = (await screen.findByLabelText("Share link")) as HTMLInputElement;
    expect(link.value).toBe("https://cloud.example.com/s/abc");
    expect(link.readOnly).toBe(true);
    expect(nextcloudShare).toHaveBeenCalledWith("u1", 7);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://cloud.example.com/s/abc"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("sends null for a link that never expires and shows upload errors", async () => {
    vi.mocked(nextcloudStatus).mockResolvedValue(signedIn);
    vi.mocked(nextcloudShare).mockRejectedValue(new Error("Could not reach the server"));
    render(<ShareDialog unit={unit} onClose={onClose} />);
    fireEvent.change(await screen.findByLabelText("Link expires"), { target: { value: "never" } });
    fireEvent.click(await screen.findByRole("button", { name: "Upload and get link" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the server");
    expect(nextcloudShare).toHaveBeenCalledWith("u1", null);
  });

  it("closes", async () => {
    render(<ShareDialog unit={unit} onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
