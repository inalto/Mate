import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, Section, Unit } from "../../model/types";

const win = vi.hoisted(() => ({ page: false }));

vi.mock("../../ipc/windows", () => ({
  isPageWindow: () => win.page,
  setThisWindowTitle: vi.fn(),
  closeThisWindow: vi.fn(),
  openPageWindow: vi.fn(async () => "page-p1"),
}));
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
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
// The canvas, overlays and tutor are not under test here.
vi.mock("../../canvas/CanvasView", () => ({ default: () => <div data-testid="canvas" /> }));
vi.mock("../../tutor/TutorController", () => ({ default: () => null }));
vi.mock("../../overlay/OverlayLayer", () => ({ default: () => null }));
vi.mock("../../overlay/boxEditors", () => ({ preloadBoxEditors: () => {} }));
vi.mock("../../thumbnails", () => ({ watchThumbnails: () => () => {} }));
vi.mock("../../components/Toolbar", () => ({ default: () => <div data-testid="toolbar" /> }));
vi.mock("../../components/SelectionBar", () => ({ default: () => null }));
vi.mock("../../components/Sidebar", () => ({ default: () => <nav data-testid="sidebar" /> }));
vi.mock("../../components/TabBar", () => ({ default: () => <div data-testid="tabbar" /> }));

import { setThisWindowTitle } from "../../ipc/windows";
import { useNotebookStore } from "../../stores/notebook";
import { useTabsStore } from "../../stores/tabs";
import Editor from "../Editor";

const stamp = "2026-01-01T00:00:00Z";
const unit: Unit = { id: "u", title: "Book", isFavourite: false, isExpanded: true, orderIndex: 0, createdAt: stamp, updatedAt: stamp, version: 0 };
const section: Section = { id: "s1", unitId: "u", title: "Notes", color: "#000", orderIndex: 0, isExpanded: true, createdAt: stamp, updatedAt: stamp, version: 0 };
const page: Page = {
  id: "p1", sectionId: "s1", title: "Algebra", isExpanded: true, isFavourite: false, depth: 0, mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 }, thumbnailVersion: 0, orderIndex: 0,
  createdAt: stamp, updatedAt: stamp, version: 0,
};

const renderEditor = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/edit/:pageId" element={<Editor />} />
      </Routes>
    </MemoryRouter>,
  );

describe("Editor", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useTabsStore.getState().reset();
    useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [unit], sections: [section], pages: [page] } });
  });
  afterEach(() => {
    cleanup();
    win.page = false;
  });

  it("main_window_shows_sidebar_and_tabs", () => {
    renderEditor("/edit/p1");
    expect(screen.getByTestId("sidebar")).toBeTruthy();
    expect(screen.getByTestId("tabbar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Home" })).toBeTruthy();
    expect(setThisWindowTitle).not.toHaveBeenCalled();
  });

  it("toolbar_precedes_the_canvas_so_the_dock_side_is_right", () => {
    renderEditor("/edit/p1");
    const editor = document.querySelector(".editor")!;
    expect(editor.getAttribute("data-dock")).toBe("top");
    const children = Array.from(editor.children);
    expect(children[0].getAttribute("data-testid")).toBe("toolbar");
    expect(children[1].classList.contains("editor-canvas")).toBe(true);
  });

  it("editor_in_window_mode_hides_chrome", () => {
    win.page = true;
    localStorage.clear();
    renderEditor("/edit/p1?window=1");
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.queryByTestId("tabbar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Toggle sidebar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New tab" })).toBeNull();
    // Keeps the page title, canvas and toolbar.
    expect((screen.getByRole("textbox", { name: "Page title" }) as HTMLInputElement).value).toBe("Algebra");
    expect(screen.getByTestId("canvas")).toBeTruthy();
    expect(screen.getByTestId("toolbar")).toBeTruthy();
    expect(setThisWindowTitle).toHaveBeenCalledWith("Algebra");
    // The main window's stored tabs are untouched.
    expect(localStorage.getItem("mate_tabs_v1")).toBeNull();
  });
});
