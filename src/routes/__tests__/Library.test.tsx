import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Unit } from "../../model/types";

vi.mock("../../ipc/notebook", () => ({
  getNotebookTree: vi.fn(async () => ({ bookshelves: [], units: [], sections: [], pages: [] })),
  upsertBookshelf: vi.fn(async () => {}),
  upsertUnit: vi.fn(async () => {}),
  upsertSection: vi.fn(async () => {}),
  upsertPage: vi.fn(async () => {}),
  softDeleteEntity: vi.fn(async () => {}),
  restoreEntity: vi.fn(async () => {}),
  listTrash: vi.fn(async () => []),
  purgeEntity: vi.fn(async () => {}),
  purgeTrashOlderThan: vi.fn(async () => 0),
}));
vi.mock("../../ipc/archive", () => ({
  importUnitArchive: vi.fn(async () => ({ unitId: "new", pages: 3, elements: 10, skipped: 2 })),
  exportUnitArchive: vi.fn(async () => "C:/physics.mate"),
}));
const pickAndImportPdf = vi.hoisted(() => vi.fn(async () => ({ id: "pdf-page" })));
vi.mock("../../pdf/import", () => ({ pickAndImportPdf }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router", async (orig) => ({ ...(await orig<typeof import("react-router")>()), useNavigate: () => navigate }));
vi.mock("../../ipc/settings", () => ({
  getSettings: vi.fn(),
  patchSettings: vi.fn(async () => {}),
}));

import { exportUnitArchive, importUnitArchive } from "../../ipc/archive";
import { getNotebookTree } from "../../ipc/notebook";
import { useNotebookStore } from "../../stores/notebook";
import Library from "../Library";

const unit = (id: string, title: string): Unit => ({
  id,
  title,
  isFavourite: false,
  isExpanded: true,
  orderIndex: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  version: 0,
});
const setUnits = (units: Unit[]) =>
  useNotebookStore.setState({
    tree: { bookshelves: [], units, sections: [], pages: [] },
    loaded: true,
  });
const renderLibrary = () =>
  render(
    <MemoryRouter>
      <Library />
    </MemoryRouter>,
  );

beforeEach(() => setUnits([]));
afterEach(cleanup);

describe("Library", () => {
  it("renders No books yet when tree empty", () => {
    renderLibrary();
    expect(screen.getByText("No books yet")).toBeTruthy();
    expect(screen.getByText("New book")).toBeTruthy();
  });

  it("renders a card per unit and a New book tile", () => {
    setUnits([unit("1", "Physics"), unit("2", "Chemistry")]);
    renderLibrary();
    expect(screen.getByText("Physics")).toBeTruthy();
    expect(screen.getByText("Chemistry")).toBeTruthy();
    expect(screen.getByText("New book")).toBeTruthy();
    expect(screen.queryByText("No books yet")).toBeNull();
  });

  it("filters books by search text", () => {
    setUnits([unit("1", "Physics"), unit("2", "Chemistry")]);
    renderLibrary();
    fireEvent.change(screen.getByPlaceholderText("Search books"), { target: { value: "chem" } });
    expect(screen.queryByText("Physics")).toBeNull();
    expect(screen.getByText("Chemistry")).toBeTruthy();
  });

  it("shows empty shelves and creates a new shelf in Shelves view", async () => {
    useNotebookStore.setState({
      tree: {
        bookshelves: [
          { id: "s1", title: "Empty shelf", order: 0, isExpanded: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: 0 },
        ],
        units: [],
        sections: [],
        pages: [],
      },
      loaded: true,
    });
    renderLibrary();
    fireEvent.click(screen.getByText("Shelves"));
    expect(await screen.findByText("Empty shelf")).toBeTruthy();
    fireEvent.click(screen.getByText("New shelf"));
    const input = screen.getByLabelText("New shelf name");
    fireEvent.change(input, { target: { value: "Maths" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Maths")).toBeTruthy();
  });

  it("imports a book, reloads the tree and reports counts", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    renderLibrary();
    fireEvent.click(screen.getByText("Import book…"));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(importUnitArchive).toHaveBeenCalled();
    expect(getNotebookTree).toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toContain("3 pages, 10 elements, 2 skipped");
    alert.mockRestore();
  });

  it("exports a book from its card menu", async () => {
    setUnits([unit("1", "Physics")]);
    renderLibrary();
    fireEvent.click(screen.getByLabelText("Actions for Physics"));
    fireEvent.click(screen.getByText("Export book…"));
    await waitFor(() => expect(exportUnitArchive).toHaveBeenCalledWith("1"));
  });

  it("imports a PDF as a page and opens it", async () => {
    setUnits([unit("1", "Physics")]);
    renderLibrary();
    fireEvent.click(screen.getByText("Import PDF…"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/edit/pdf-page"));
    expect(pickAndImportPdf).toHaveBeenCalledTimes(1);
  });
});
