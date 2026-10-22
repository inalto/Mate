import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, Section, Unit } from "../../model/types";

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
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));

import { useNotebookStore } from "../../stores/notebook";
import { useTabsStore } from "../../stores/tabs";
import Sidebar from "../Sidebar";

const stamp = "2026-01-01T00:00:00Z";
const unit: Unit = { id: "u", title: "Book", isFavourite: false, isExpanded: true, orderIndex: 0, createdAt: stamp, updatedAt: stamp, version: 0 };
const section = (id: string, title: string, orderIndex = 0): Section => ({
  id, unitId: "u", title, color: "#000", orderIndex, isExpanded: true, createdAt: stamp, updatedAt: stamp, version: 0,
});
const page = (id: string, title: string, extra: Partial<Page> = {}): Page => ({
  id, sectionId: "s1", title, isExpanded: true, isFavourite: false, depth: 0, mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 }, thumbnailVersion: 0, orderIndex: 0,
  createdAt: stamp, updatedAt: stamp, version: 0, ...extra,
});

const renderSidebar = () =>
  render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );

describe("Sidebar", () => {
  beforeEach(() => {
    localStorage.clear();
    useTabsStore.getState().reset();
    useNotebookStore.setState({
      loaded: true,
      tree: {
        bookshelves: [],
        units: [unit],
        sections: [section("s1", "Notes")],
        pages: [page("p1", "Parent"), page("p2", "Child", { parentId: "p1", depth: 1 })],
      },
    });
    useTabsStore.getState().openPage("p1");
  });
  afterEach(cleanup);

  it("renders_nested_pages_under_their_parent", () => {
    renderSidebar();
    const parent = screen.getByRole("treeitem", { name: /Parent/ });
    const child = within(parent).getByRole("treeitem", { name: /Child/ });
    expect(child.getAttribute("aria-level")).toBe("2");
    expect(screen.getAllByRole("treeitem", { name: /Child/ })).toHaveLength(1);
  });

  it("shows_empty_states", () => {
    useNotebookStore.setState({ tree: { bookshelves: [], units: [unit], sections: [], pages: [] } });
    const { unmount } = renderSidebar();
    expect(screen.getByText("No sections")).toBeTruthy();
    unmount();
    useNotebookStore.setState({ tree: { bookshelves: [], units: [unit], sections: [section("s1", "Notes")], pages: [] } });
    renderSidebar();
    expect(screen.getByText("No pages yet")).toBeTruthy();
  });

  it("context_menu_delete_calls_trash_page", () => {
    const trash = vi.fn(async () => {});
    useNotebookStore.setState({ trash });
    renderSidebar();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Child" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(trash).toHaveBeenCalledWith("page", "p2");
  });
});
