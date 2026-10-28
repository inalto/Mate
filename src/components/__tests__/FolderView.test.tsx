import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bookshelf, Unit } from "../../model/types";

vi.mock("../../ipc/notebook", () => ({
  getNotebookTree: vi.fn(async () => ({ bookshelves: [], units: [], sections: [], pages: [] })),
  upsertBookshelf: vi.fn(async () => {}),
  moveBookshelf: vi.fn(async () => {}),
  upsertUnit: vi.fn(async () => {}),
  upsertSection: vi.fn(async () => {}),
  upsertPage: vi.fn(async () => {}),
  softDeleteEntity: vi.fn(async () => {}),
  restoreEntity: vi.fn(async () => {}),
  listTrash: vi.fn(async () => []),
  purgeEntity: vi.fn(async () => {}),
  purgeTrashOlderThan: vi.fn(async () => 0),
}));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import * as ipc from "../../ipc/notebook";
import { useNotebookStore } from "../../stores/notebook";
import FolderView from "../FolderView";

const stamp = "2026-01-01T00:00:00Z";
const folder = (id: string, title: string, order: number, parentId?: string): Bookshelf => ({
  id, title, order, isExpanded: true, createdAt: stamp, updatedAt: stamp, version: 0, parentId,
});
const book = (id: string, title: string, bookshelfId?: string): Unit => ({
  id, title, isFavourite: false, isExpanded: true, orderIndex: 0, createdAt: stamp, updatedAt: stamp, version: 0, bookshelfId,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Maths > Algebra > Linear > Matrices > Eigen; Physics at the root.
  useNotebookStore.setState({
    tree: {
      bookshelves: [
        folder("m", "Maths", 0),
        folder("p", "Physics", 1),
        folder("al", "Algebra", 2, "m"),
        folder("li", "Linear", 3, "al"),
        folder("ma", "Matrices", 4, "li"),
        folder("ei", "Eigen", 5, "ma"),
      ],
      units: [book("u1", "Loose notes"), book("u2", "Calculus", "m"), book("u3", "Optics", "p")],
      sections: [],
      pages: [],
    },
    loaded: true,
  });
});
afterEach(cleanup);

const renderView = (query = "") =>
  render(
    <MemoryRouter>
      <FolderView query={query} />
    </MemoryRouter>,
  );
const crumbs = () => within(screen.getByRole("navigation", { name: "Folder path" })).getByRole("list").textContent;
const open = (title: string) => fireEvent.click(screen.getByRole("button", { name: `Open folder ${title}` }));

describe("FolderView", () => {
  it("shows top-level folders before the unfiled books at the root", () => {
    renderView();
    expect(crumbs()).toBe("Folders");
    const folders = screen.getAllByRole("button", { name: /^Open folder/ }).map((b) => b.getAttribute("aria-label"));
    expect(folders).toEqual(["Open folder Maths", "Open folder Physics"]);
    expect(screen.getByRole("heading", { name: "Unfiled" })).toBeTruthy();
    expect(screen.getByText("Loose notes")).toBeTruthy();
    expect(screen.queryByText("Calculus")).toBeNull();
    // Folder cards come before book cards in the document.
    const maths = screen.getByRole("button", { name: "Open folder Maths" });
    const loose = screen.getByText("Loose notes");
    expect(maths.compareDocumentPosition(loose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens a folder and returns through the breadcrumb", () => {
    renderView();
    open("Maths");
    expect(crumbs()).toBe("Folders›Maths");
    expect(screen.getByRole("button", { name: "Open folder Algebra" })).toBeTruthy();
    expect(screen.getByText("Calculus")).toBeTruthy();
    expect(screen.queryByText("Loose notes")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Folders" }));
    expect(crumbs()).toBe("Folders");
    expect(screen.getByText("Loose notes")).toBeTruthy();
  });

  it("shows the last three levels and an ellipsis on deep paths", () => {
    renderView();
    for (const t of ["Maths", "Algebra", "Linear", "Matrices"]) open(t);
    expect(crumbs()).toBe("Folders›…›Algebra›Linear›Matrices");
    fireEvent.click(screen.getByRole("button", { name: "Algebra" }));
    expect(crumbs()).toBe("Folders›Maths›Algebra");
    expect(screen.queryByText("This folder is empty")).toBeNull();
    for (const t of ["Linear", "Matrices", "Eigen"]) open(t);
    expect(screen.getByText("This folder is empty")).toBeTruthy();
  });

  it("creates a new folder in the current folder", async () => {
    renderView();
    open("Physics");
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const input = screen.getByLabelText("New folder name");
    fireEvent.change(input, { target: { value: "Waves" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("button", { name: "Open folder Waves" })).toBeTruthy();
    expect(vi.mocked(ipc.upsertBookshelf).mock.calls[0][0]).toMatchObject({ title: "Waves", parentId: "p" });
  });

  it("moves a folder from its menu, greying itself and its subfolders", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Actions for folder Maths" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const dialog = screen.getByRole("dialog", { name: "Move Maths to…" });
    const target = (name: string) => within(dialog).getByRole("button", { name }) as HTMLButtonElement;
    expect(target("Maths").disabled).toBe(true);
    expect(target("Eigen").disabled).toBe(true);
    expect(target("Unfiled").disabled).toBe(true); // already at the root
    fireEvent.click(target("Physics"));
    await waitFor(() => expect(ipc.moveBookshelf).toHaveBeenCalledWith("m", "p"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: "Open folder Maths" })).toBeNull();
  });

  it("deletes a folder from its menu", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Actions for folder Physics" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(ipc.softDeleteEntity).toHaveBeenCalledWith("bookshelf", "p"));
  });

  it("renames a folder from its menu", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Actions for folder Physics" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByLabelText("Folder name");
    fireEvent.change(input, { target: { value: "Physics II" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(vi.mocked(ipc.upsertBookshelf).mock.calls[0][0]).toMatchObject({ id: "p", title: "Physics II" }),
    );
  });

  it("moves a book into a folder from the book menu", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Loose notes" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const dialog = screen.getByRole("dialog", { name: "Move Loose notes to…" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Linear" }));
    await waitFor(() =>
      expect(vi.mocked(ipc.upsertUnit).mock.calls[0][0]).toMatchObject({ id: "u1", bookshelfId: "li" }),
    );
  });

  it("filters the current folder's books by the search text", () => {
    renderView("zzz");
    expect(screen.queryByText("Loose notes")).toBeNull();
    expect(screen.getByRole("button", { name: "Open folder Maths" })).toBeTruthy();
  });
});
