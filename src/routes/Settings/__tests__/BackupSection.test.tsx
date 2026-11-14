import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../ipc/backup", () => ({
  exportBackup: vi.fn(),
  resetLocalData: vi.fn(),
  pickBackupFile: vi.fn(async () => "C:/backups/mate-backup-2026-11-14.zip"),
  restoreBackupFile: vi.fn(),
}));

import { pickBackupFile, restoreBackupFile, type RestoreReport } from "../../../ipc/backup";
import BackupSection from "../sections/BackupSection";

const book = (unitId: string) => ({ unitId, pages: 1, elements: 2, skipped: 0 });
const report = (over: Partial<RestoreReport> = {}): RestoreReport => ({
  books: [book("a"), book("b")],
  failed: [],
  rejectedAudio: 0,
  lostRecordings: [],
  ...over,
});

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const restoreButton = () => screen.getByRole("button", { name: "Restore from backup…" });

/** Click Restore, let the picker resolve, and return the confirmation dialog. */
const openConfirm = async () => {
  render(<BackupSection />);
  await act(async () => {
    fireEvent.click(restoreButton());
  });
  return screen.getByRole("alertdialog", { name: "Restore this backup?" });
};

const confirmAndFinish = async () => {
  const dialog = await openConfirm();
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
  });
};

describe("BackupSection restore", () => {
  it("asks before restoring", async () => {
    vi.mocked(restoreBackupFile).mockResolvedValue(report());
    const dialog = await openConfirm();
    expect(pickBackupFile).toHaveBeenCalledTimes(1);
    expect(dialog.textContent).toContain(
      "Notebooks from the backup are added beside the ones you already have. Nothing is replaced or deleted.",
    );
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel", "Restore"]);
    expect(restoreBackupFile).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(restoreBackupFile).not.toHaveBeenCalled();
  });

  it("does nothing when the file dialog is cancelled", async () => {
    vi.mocked(pickBackupFile).mockResolvedValueOnce(null);
    render(<BackupSection />);
    await act(async () => {
      fireEvent.click(restoreButton());
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(restoreBackupFile).not.toHaveBeenCalled();
  });

  it("shows what was restored", async () => {
    vi.mocked(restoreBackupFile).mockResolvedValue(
      report({ failed: [{ name: "Films", error: "archive error" }], rejectedAudio: 3 }),
    );
    await confirmAndFinish();
    expect(restoreBackupFile).toHaveBeenCalledWith("C:/backups/mate-backup-2026-11-14.zip");
    const done = screen.getByRole("alertdialog");
    expect(done.textContent).toContain("2 notebooks restored.");
    expect(done.textContent).toContain("Could not be restored: Films");
    expect(done.textContent).toContain("3 audio files in the backup were not valid and were skipped.");
    expect(done.textContent).not.toContain("without their audio");
    const buttons = within(done).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Close"]);
    fireEvent.click(buttons[0]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("lists notebooks that lost their audio", async () => {
    vi.mocked(restoreBackupFile).mockResolvedValue(report({ lostRecordings: ["Physics", "Chemistry"] }));
    await confirmAndFinish();
    const done = screen.getByRole("alertdialog");
    expect(done.textContent).toContain(
      "Recordings in these notebooks came back without their audio: Physics, Chemistry",
    );
    expect(done.textContent).not.toContain("Could not be restored");
    expect(done.textContent).not.toContain("were not valid");
  });

  it("the button is disabled while restoring", async () => {
    let finish: (r: RestoreReport) => void = () => {};
    vi.mocked(restoreBackupFile).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await confirmAndFinish();
    expect((restoreButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(restoreButton());
    expect(pickBackupFile).toHaveBeenCalledTimes(1);
    expect(restoreBackupFile).toHaveBeenCalledTimes(1);
    await act(async () => finish(report()));
    expect((restoreButton() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("alertdialog").textContent).toContain("2 notebooks restored.");
  });

  it("an error says nothing was changed", async () => {
    vi.mocked(restoreBackupFile).mockRejectedValue("limit exceeded: not a Mate backup (not a zip file)");
    await confirmAndFinish();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("The backup could not be restored. Nothing was changed.");
    expect((restoreButton() as HTMLButtonElement).disabled).toBe(false);
  });
});
