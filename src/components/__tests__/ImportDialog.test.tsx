import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, Section, Unit } from "../../model/types";

const ipc = vi.hoisted(() => ({
  sniffImportFiles: vi.fn(),
  importFiles: vi.fn(),
  cancelImport: vi.fn(async () => undefined),
  takePendingImportFiles: vi.fn(async (): Promise<string[]> => []),
  onImportProgress: vi.fn(async () => () => {}),
  onImportFileOpened: vi.fn(async () => () => {}),
}));
vi.mock("../../ipc/import", async (orig) => ({ ...(await orig<object>()), ...ipc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
const webview = vi.hoisted(() => ({ handler: null as null | ((e: { payload: unknown }) => void) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (cb: (e: { payload: unknown }) => void) => {
      webview.handler = cb;
      return () => {};
    },
  }),
}));
const seeded = vi.hoisted(() => ({ tree: null as unknown }));
vi.mock("../../ipc/notebook", () => ({ getNotebookTree: vi.fn(async () => seeded.tree) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(async () => ({})), setSettings: vi.fn(async () => undefined) }));

import { open } from "@tauri-apps/plugin-dialog";
import { MemoryRouter } from "react-router";
import { bookNameFromFile, installImportOpenHandler, useImportStore } from "../../stores/importStore";
import { setNavigator } from "../../stores/navigation";
import { useNotebookStore } from "../../stores/notebook";
import ImportDialog from "../ImportDialog";
import Shell from "../Shell";

const STAMP = "2026-01-01T00:00:00.000Z";
const unit = (id: string, title: string): Unit =>
  ({ id, title, isFavourite: false, isExpanded: true, orderIndex: 0, createdAt: STAMP, updatedAt: STAMP, version: 0 }) as Unit;
const section = { id: "s1", unitId: "u9", title: "S", color: "#000", orderIndex: 0, isExpanded: true, createdAt: STAMP, updatedAt: STAMP, version: 0 } as Section;
const page = { id: "p1", sectionId: "s1", orderIndex: 0 } as Page;

const good = { path: "C:/n/Maths.goodnotes", filename: "Maths.goodnotes", size: 2048, status: "ok", source: "good-notes", sourceName: "GoodNotes" } as const;
const bad = { path: "C:/n/a.note", filename: "a.note", size: 4, status: "rejected", reason: "This file is not a format Mate can import (.note)." } as const;
const report = {
  unitId: "u9", sectionIds: ["s9"], pagesImported: 12, pagesSkippedDuplicate: 3, pagesSkippedLimit: 0, strokes: 340, texts: 5, images: 2,
  elementsSkippedLimit: 0, elementsSkippedInvalid: 0, tablesSkipped: 1, shapesSkipped: 0, warnings: ["One image could not be read."], details: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  webview.handler = null;
  useImportStore.getState().close();
  const tree = { bookshelves: [], units: [unit("u1", "Calculus"), unit("u9", "Imported")], sections: [section], pages: [page] };
  seeded.tree = tree;
  useNotebookStore.setState({ tree, loaded: true });
  ipc.sniffImportFiles.mockResolvedValue([good, bad]);
  ipc.importFiles.mockResolvedValue([{ path: good.path, status: "ok", report }]);
});
afterEach(cleanup);

describe("ImportDialog", () => {
  it("sniffs, names the new book after the first file, imports and reports", async () => {
    const navigate = vi.fn();
    setNavigator(navigate);
    render(<ImportDialog />);
    await act(async () => useImportStore.getState().openDialog({ paths: [good.path, bad.path] }));
    expect(ipc.sniffImportFiles).toHaveBeenCalledWith([good.path, bad.path]);
    expect(screen.getByText("GoodNotes file, 2 KB")).toBeTruthy();
    expect(screen.getByText(/Cannot be imported\. This file is not a format Mate can import/)).toBeTruthy();
    expect((screen.getByLabelText("Book name") as HTMLInputElement).value).toBe("Maths");

    fireEvent.change(screen.getByLabelText("Book name"), { target: { value: "Maths 101" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText("Import finished");
    expect(ipc.importFiles).toHaveBeenCalledWith([good.path], { kind: "new-unit", title: "Maths 101" });
    expect(screen.getByText("12 pages, 340 strokes, 5 text boxes, 2 images.")).toBeTruthy();
    expect(screen.getByText("3 pages already imported, so not added again.")).toBeTruthy();
    expect(screen.getByText("Tables and shapes are not imported yet.")).toBeTruthy();
    expect(screen.getByText("One image could not be read.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open book" }));
    expect(navigate).toHaveBeenCalledWith("/edit/p1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("imports into an existing book chosen in the dialog", async () => {
    render(<ImportDialog />);
    await act(async () => useImportStore.getState().openDialog({ paths: [good.path] }));
    fireEvent.click(screen.getByRole("radio", { name: "An existing book" }));
    fireEvent.change(screen.getByLabelText("Book"), { target: { value: "u9" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText("Import finished");
    expect(ipc.importFiles).toHaveBeenCalledWith([good.path], { kind: "existing-unit", unitId: "u9" });
  });

  it("preselects the book when opened from a book card", async () => {
    render(<ImportDialog />);
    await act(async () => useImportStore.getState().openDialog({ paths: [good.path], unitId: "u1" }));
    expect((screen.getByLabelText("Book") as HTMLSelectElement).value).toBe("u1");
  });

  it("shows failed files with their reason and no Open book when nothing was imported", async () => {
    ipc.importFiles.mockResolvedValue([{ path: good.path, status: "failed", error: "The import was cancelled." }]);
    render(<ImportDialog />);
    await act(async () => useImportStore.getState().openDialog({ paths: [good.path] }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText("Nothing was imported");
    expect(screen.getByText("The import was cancelled.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open book" })).toBeNull();
  });

  it("opens the file picker with the notebook extensions when launched without files", async () => {
    vi.mocked(open).mockResolvedValueOnce([good.path] as never);
    await act(async () => useImportStore.getState().openDialog());
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: true, filters: [{ name: "Notebook files", extensions: expect.arrayContaining(["goodnotes", "sdocx"]) }] }),
    );
    expect(useImportStore.getState().files).toHaveLength(2);
  });

  it("closes when the picker is cancelled", async () => {
    await act(async () => useImportStore.getState().openDialog());
    expect(useImportStore.getState().open).toBe(false);
  });

  it("pending_file_imported_on_startup", async () => {
    ipc.takePendingImportFiles.mockResolvedValueOnce([good.path]);
    const detach = installImportOpenHandler();
    render(<ImportDialog />);
    await screen.findByRole("dialog", { name: "Import notes" });
    await waitFor(() => expect(ipc.sniffImportFiles).toHaveBeenCalledWith([good.path]));
    await screen.findByText("GoodNotes file, 2 KB");
    detach();
  });

  it("drag-drop of a .note file opens the dialog", async () => {
    ipc.sniffImportFiles.mockResolvedValue([{ ...good, path: "C:/n/Lecture.note", filename: "Lecture.note", source: "notability", sourceName: "Notability" }]);
    render(<MemoryRouter><Shell /></MemoryRouter>);
    await waitFor(() => expect(webview.handler).not.toBeNull());
    await act(async () => webview.handler!({ payload: { type: "drop", paths: ["C:/n/x.pdf"], position: { x: 1, y: 1 } } }));
    expect(screen.queryByRole("dialog", { name: "Import notes" })).toBeNull();
    await act(async () => webview.handler!({ payload: { type: "drop", paths: ["C:/n/Lecture.note", "C:/n/x.pdf"], position: { x: 1, y: 1 } } }));
    await screen.findByRole("dialog", { name: "Import notes" });
    expect(ipc.sniffImportFiles).toHaveBeenCalledWith(["C:/n/Lecture.note"]);
  });

  it("never says Derive", async () => {
    const { container } = render(<ImportDialog />);
    await act(async () => useImportStore.getState().openDialog({ paths: [good.path, bad.path] }));
    expect(container.textContent).not.toMatch(/derive/i);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText("Import finished");
    expect(container.textContent).not.toMatch(/derive/i);
  });
});

describe("ImportDialog during an import", () => {
  const pending = () => {
    let resolve!: (v: unknown) => void;
    const p = new Promise((r) => (resolve = r));
    return { p, resolve };
  };

  it("open_with_during_import_does_not_reset", async () => {
    const run = pending();
    ipc.importFiles.mockReturnValueOnce(run.p);
    render(<ImportDialog />);
    await act(async () => useImportStore.getState().openDialog({ paths: [good.path] }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText("Importing");
    ipc.sniffImportFiles.mockClear();
    await act(async () => useImportStore.getState().openDialog({ paths: ["C:/n/Other.note"] }));
    expect(useImportStore.getState().stage).toBe("importing");
    expect(useImportStore.getState().files).toHaveLength(2);
    expect(useImportStore.getState().queued).toEqual(["C:/n/Other.note"]);
    expect(ipc.sniffImportFiles).not.toHaveBeenCalled();
    expect(screen.getByText("1 more file will be offered when this import finishes.")).toBeTruthy();

    await act(async () => run.resolve([{ path: good.path, status: "ok", report }]));
    await screen.findByText("Import finished");
    ipc.sniffImportFiles.mockResolvedValue([{ ...good, path: "C:/n/Other.note", filename: "Other.note" }]);
    fireEvent.click(screen.getByRole("button", { name: "Import 1 more file…" }));
    await screen.findByText("GoodNotes file, 2 KB");
    expect(useImportStore.getState().stage).toBe("review");
    expect(ipc.sniffImportFiles).toHaveBeenCalledWith(["C:/n/Other.note"]);
  });

  it("ignores a second submit while importing", async () => {
    const run = pending();
    ipc.importFiles.mockReturnValueOnce(run.p);
    await act(async () => useImportStore.getState().openDialog({ paths: [good.path] }));
    const first = useImportStore.getState().run();
    await useImportStore.getState().run();
    await waitFor(() => expect(ipc.importFiles).toHaveBeenCalledTimes(1));
    run.resolve([{ path: good.path, status: "ok", report }]);
    await first;
    await useImportStore.getState().run(); // done: not a review step any more
    expect(ipc.importFiles).toHaveBeenCalledTimes(1);
  });

  it("cancel shows that the current file is finishing", async () => {
    const run = pending();
    ipc.importFiles.mockReturnValueOnce(run.p);
    render(<ImportDialog />);
    await act(async () => useImportStore.getState().openDialog({ paths: [good.path] }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel import" }));
    await screen.findByText("Cancelling… finishing the current file.");
    expect(ipc.cancelImport).toHaveBeenCalled();
    await act(async () => run.resolve([{ path: good.path, status: "failed", error: "The import was cancelled." }]));
  });

  it("shows invalid-item counts but never the log-only details", async () => {
    const invalid = "4 items were left out because their position or size was unreadable.";
    ipc.importFiles.mockResolvedValue([
      {
        path: good.path,
        status: "ok",
        report: { ...report, elementsSkippedInvalid: 4, warnings: [invalid], details: ["page write failed: secret"] },
      },
    ]);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { container } = render(<ImportDialog />);
    await act(async () => useImportStore.getState().openDialog({ paths: [good.path] }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText(invalid);
    expect(screen.getAllByText(/position or size/)).toHaveLength(1);
    expect(container.textContent).not.toContain("secret");
    expect(debug).toHaveBeenCalled();
    debug.mockRestore();
  });

  it("closes on a backdrop click only when not importing", async () => {
    render(<ImportDialog />);
    await act(async () => useImportStore.getState().openDialog({ paths: [good.path] }));
    expect(document.activeElement?.closest("[role=dialog]")).not.toBeNull();
    fireEvent.click(document.querySelector(".backdrop")!);
    expect(useImportStore.getState().open).toBe(false);
  });
});

describe("copy", () => {
  it("lists skipped tables and shapes with the exact line", async () => {
    render(<ImportDialog />);
    await act(async () => useImportStore.getState().openDialog({ paths: [good.path] }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText("Import finished");
    const skipped = screen.getByRole("list", { name: "Skipped" });
    expect(skipped.textContent).toContain("Tables and shapes are not imported yet.");
    expect(skipped.textContent).not.toMatch(/could not be imported/);
  });

  it("shows each skip message once", async () => {
    const limit = "3 items were left out because a page or stroke was too large.";
    const rep = { ...report, tablesSkipped: 2, shapesSkipped: 1, elementsSkippedLimit: 3 };
    const warnings = ["2 tables were not imported.", "1 shapes were not imported.", limit];
    ipc.importFiles.mockResolvedValue([
      { path: good.path, status: "ok", report: { ...rep, warnings } },
      { path: "C:/b.goodnotes", status: "ok", report: { ...rep, warnings } },
    ]);
    render(<ImportDialog />);
    await act(async () => useImportStore.getState().openDialog({ paths: [good.path] }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText("Import finished");
    expect(screen.getAllByText(limit)).toHaveLength(1);
    expect(screen.getAllByText("Tables and shapes are not imported yet.")).toHaveLength(1);
    expect(screen.queryByText(/tables were not imported/)).toBeNull();
    expect(screen.queryByText(/over the size limits/)).toBeNull();
  });

  it("names the book after a Windows path's file", () => {
    expect(bookNameFromFile(String.raw`C:\Users\me\Maths.goodnotes`)).toBe("Maths");
    expect(bookNameFromFile("/home/me/Physics.note")).toBe("Physics");
  });

  it("never says Derive in the entry points", () => {
    const sources = import.meta.glob(
      ["../TopBar.tsx", "../BookCard.tsx", "../ImportDialog.tsx", "../../routes/Library.tsx", "../../stores/importStore.ts"],
      { query: "?raw", import: "default", eager: true },
    );
    expect(Object.keys(sources)).toHaveLength(5);
    for (const [f, text] of Object.entries(sources)) expect(text as string, f).not.toMatch(/derive/i);
  });
});
