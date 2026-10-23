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
import { installImportOpenHandler, useImportStore } from "../../stores/importStore";
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
  elementsSkippedLimit: 0, tablesSkipped: 1, shapesSkipped: 0, warnings: ["One image could not be read."],
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
    expect(screen.getByText("1 table could not be imported.")).toBeTruthy();
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
