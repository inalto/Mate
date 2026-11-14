import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../ipc/backup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../ipc/backup")>()),
  exportBackup: vi.fn(),
  resetLocalData: vi.fn(),
  pickBackupFile: vi.fn(async () => "C:/backups/mate-backup-2026-11-14.zip"),
  restoreBackupFile: vi.fn(),
}));

const notebook = vi.hoisted(() => ({ load: vi.fn(async () => {}) }));
vi.mock("../../../stores/notebook", () => ({ useNotebookStore: { getState: () => notebook } }));

const recording = vi.hoisted(() => ({ active: false, stop: vi.fn(async (): Promise<string | null> => "rec") }));
vi.mock("../../../recording/session", () => ({
  isRecordingActive: () => recording.active,
  useRecording: { getState: () => ({ stop: recording.stop }) },
}));

import { pickBackupFile, resetLocalData, restoreBackupFile, type RestoreReport } from "../../../ipc/backup";
import BackupSection from "../sections/BackupSection";

const book = (unitId: string) => ({ unitId, pages: 1, elements: 2, skipped: 0 });
const report = (over: Partial<RestoreReport> = {}): RestoreReport => ({
  books: [book("a"), book("b")],
  failed: [],
  rejectedAudio: 0,
  lostRecordings: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  recording.active = false;
});
afterEach(cleanup);

/** The row's button, whatever it currently says. */
const restoreButton = () => screen.getByRole("button", { name: /^(Restore from backup…|Restoring…)$/ });

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
    const done = screen.getByRole("alertdialog", { name: "Backup restored" });
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
    expect(restoreButton().textContent).toBe("Restoring…");
    expect(restoreButton().getAttribute("aria-busy")).toBe("true");
    fireEvent.click(restoreButton());
    expect(pickBackupFile).toHaveBeenCalledTimes(1);
    expect(restoreBackupFile).toHaveBeenCalledTimes(1);
    await act(async () => finish(report()));
    expect((restoreButton() as HTMLButtonElement).disabled).toBe(false);
    expect(restoreButton().textContent).toBe("Restore from backup…");
    expect(restoreButton().getAttribute("aria-busy")).toBeNull();
    expect(screen.getByRole("alertdialog").textContent).toContain("2 notebooks restored.");
  });

  it("an error says nothing was changed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(restoreBackupFile).mockRejectedValue("limit exceeded: not a Mate backup (not a zip file)");
    await confirmAndFinish();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("The backup could not be restored. Nothing was changed.");
    expect((restoreButton() as HTMLButtonElement).disabled).toBe(false);
    expect(logged).toHaveBeenCalledWith(expect.anything(), "limit exceeded: not a Mate backup (not a zip file)");
    expect(notebook.load).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("a restore that stopped unexpectedly does not promise nothing changed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(restoreBackupFile).mockRejectedValue("restore stopped unexpectedly: task 7 panicked");
    await confirmAndFinish();
    expect(screen.getByRole("alert").textContent).toBe(
      "The restore stopped unexpectedly. Some notebooks may have been restored.",
    );
    expect(logged).toHaveBeenCalledWith(expect.anything(), "restore stopped unexpectedly: task 7 panicked");
    // Some books may be there: show them.
    expect(notebook.load).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it("reloads the notebook tree after a restore", async () => {
    vi.mocked(restoreBackupFile).mockResolvedValue(report({ books: [book("a")], failed: [{ name: "Films", error: "x" }] }));
    await confirmAndFinish();
    expect(notebook.load).toHaveBeenCalledTimes(1);
  });

  it("a failed reload does not turn the restore into an error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    notebook.load.mockRejectedValueOnce(new Error("db busy"));
    vi.mocked(restoreBackupFile).mockResolvedValue(report());
    await confirmAndFinish();
    expect(screen.getByRole("alertdialog", { name: "Backup restored" }).textContent).toContain("2 notebooks restored.");
    expect(screen.queryByRole("alert")?.textContent ?? "").toBe("");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("says nothing was restored when every notebook failed", async () => {
    vi.mocked(restoreBackupFile).mockResolvedValue(report({ books: [], failed: [{ name: "Films", error: "x" }] }));
    await confirmAndFinish();
    const done = screen.getByRole("alertdialog", { name: "Nothing was restored" });
    expect(done.textContent).toContain("0 notebooks restored.");
    expect(done.textContent).toContain("Could not be restored: Films");
    expect(notebook.load).not.toHaveBeenCalled();
  });
});

describe("BackupSection reset", () => {
  const confirmReset = async () => {
    render(<BackupSection />);
    fireEvent.click(screen.getByRole("button", { name: "Reset local data" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Reset" }));
    });
  };

  it("a reset refused for a recording not saved yet says so", async () => {
    vi.mocked(resetLocalData).mockRejectedValueOnce(
      "reset refused: a recording is still being saved. Stop it, or restart Mate so it can be recovered, then try again.",
    );
    await confirmReset();
    expect(screen.getByRole("alert").textContent).toBe(
      "A recording is still being saved. Stop it, or restart Mate so it can be recovered, then try again.",
    );
    expect((screen.getByRole("button", { name: "Reset local data" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stops a running recording before the reset", async () => {
    recording.active = true;
    let saved!: () => void;
    recording.stop.mockImplementationOnce(() => new Promise((ok) => (saved = () => ok("rec"))));
    await confirmReset();
    expect(recording.stop).toHaveBeenCalledTimes(1);
    expect(resetLocalData).not.toHaveBeenCalled();
    await act(async () => saved());
    expect(resetLocalData).toHaveBeenCalledTimes(1);
  });
});
