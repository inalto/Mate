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
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/windows", () => ({
  openPageWindow: vi.fn(async () => "page-p2"),
  isPageWindow: () => false,
}));

vi.mock("../../stores/clearPage", () => ({ clearPage: vi.fn(async () => 0), pageIsOpen: vi.fn(() => true) }));

import { act } from "@testing-library/react";
import { clearPage, pageIsOpen } from "../../stores/clearPage";
import { openPageWindow } from "../../ipc/windows";
import { setPlatformForTests } from "../../platform";
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

  it("sidebar_menu_opens_page_window", () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Child" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in new window" }));
    expect(openPageWindow).toHaveBeenCalledWith("p2");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("sidebar_menu_hides_page_window_on_mobile", () => {
    setPlatformForTests(true);
    try {
      renderSidebar();
      fireEvent.contextMenu(screen.getByRole("button", { name: "Child" }));
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: "Open in new window" })).toBeNull();
    } finally {
      setPlatformForTests(false);
    }
  });
});

describe("Sidebar page actions", () => {
  const rowButton = (name: string) => screen.getByRole("button", { name });
  const layOutRows = () => {
    // jsdom has no layout: give the three top-level rows 30 px each.
    document.querySelectorAll<HTMLElement>("li[data-page-id] > .sb-row").forEach((r, i) => {
      r.getBoundingClientRect = () => ({ top: i * 30, height: 30, left: 0, width: 200, bottom: i * 30 + 30, right: 200, x: 0, y: i * 30, toJSON: () => ({}) }) as DOMRect;
    });
  };
  const drop = (id: string) => document.querySelector(`li[data-page-id="${id}"]`)?.getAttribute("data-drop");
  let movePageTo: ReturnType<typeof vi.fn>;
  let insertPage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    useTabsStore.getState().reset();
    movePageTo = vi.fn(async () => {});
    insertPage = vi.fn(async () => page("new", "New"));
    useNotebookStore.setState({
      loaded: true,
      movePageTo,
      insertPage,
      tree: {
        bookshelves: [],
        units: [unit],
        sections: [section("s1", "Notes")],
        pages: [page("a", "Alpha", { orderIndex: 0 }), page("b", "Beta", { orderIndex: 1 }), page("c", "Gamma", { orderIndex: 2 })],
      },
    } as never);
    useTabsStore.getState().openPage("a");
    vi.mocked(clearPage).mockClear();
    vi.mocked(pageIsOpen).mockReturnValue(true);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("the page actions button opens the page menu without a right-click", () => {
    renderSidebar();
    const beta = screen.getByRole("treeitem", { name: "Beta" });
    fireEvent.click(within(beta).getByRole("button", { name: "Page actions" }));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Move up" })).toBeTruthy();
  });

  it("new page above and below insert next to the page and open the new page", async () => {
    const openPage = vi.spyOn(useTabsStore.getState(), "openPage");
    openPage.mockClear(); // the store keeps the spied function across tests
    renderSidebar();
    fireEvent.contextMenu(rowButton("Beta"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New page below" }));
    expect(insertPage).toHaveBeenCalledWith("b", "below", "Page 4");
    await act(async () => {});
    expect(openPage).toHaveBeenCalledWith("new", { newTab: false });
    fireEvent.contextMenu(rowButton("Beta"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New page above" }));
    expect(insertPage).toHaveBeenLastCalledWith("b", "above", "Page 4");
  });

  it("clear page asks first and clears only on confirm", () => {
    renderSidebar();
    fireEvent.contextMenu(rowButton("Beta"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear page…" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.getAttribute("aria-label")).toContain("Beta");
    expect(dialog.textContent).toContain("You can undo this");
    expect(clearPage).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(clearPage).not.toHaveBeenCalled();

    fireEvent.contextMenu(rowButton("Beta"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear page…" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear" }));
    expect(clearPage).toHaveBeenCalledWith("b");
  });

  it("clearing a page that is not open warns that it cannot be undone", () => {
    vi.mocked(pageIsOpen).mockReturnValue(false);
    renderSidebar();
    fireEvent.contextMenu(rowButton("Gamma"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear page…" }));
    expect(screen.getByRole("alertdialog").textContent).toContain("cannot be undone");
  });

  it("a mouse drag moves the row to the slot it is dropped on and does not open the page", () => {
    const openPage = vi.spyOn(useTabsStore.getState(), "openPage");
    openPage.mockClear(); // the store keeps the spied function across tests
    renderSidebar();
    layOutRows();
    const beta = rowButton("Beta");
    fireEvent.pointerDown(beta, { button: 0, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 45 });
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 60 });
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 85 });
    expect(drop("c")).toBe("after");
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 85 });
    fireEvent.click(beta);
    expect(movePageTo).toHaveBeenCalledWith("b", 2);
    expect(document.querySelector("[data-drop]")).toBeNull();
    expect(openPage).not.toHaveBeenCalled(); // the click that ends a drag opens nothing
    fireEvent.click(beta);
    expect(openPage).toHaveBeenCalledWith("b", { newTab: false }); // later clicks work again
  });

  it("a mouse press that barely moves is a click, and a drop on its own slot writes nothing", () => {
    renderSidebar();
    layOutRows();
    const beta = rowButton("Beta");
    fireEvent.pointerDown(beta, { button: 0, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 45 });
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientX: 12, clientY: 46 });
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse", clientX: 12, clientY: 46 });
    expect(movePageTo).not.toHaveBeenCalled();
    fireEvent.pointerDown(beta, { button: 0, pointerId: 2, pointerType: "mouse", clientX: 10, clientY: 45 });
    fireEvent.pointerMove(window, { pointerId: 2, pointerType: "mouse", clientX: 10, clientY: 55 });
    fireEvent.pointerUp(window, { pointerId: 2, pointerType: "mouse", clientX: 10, clientY: 55 });
    expect(movePageTo).not.toHaveBeenCalled();
  });

  it("a finger must hold before it drags: a quick swipe scrolls instead", () => {
    vi.useFakeTimers();
    renderSidebar();
    layOutRows();
    const gamma = rowButton("Gamma");
    // Quick swipe: moves at once, never picks up.
    fireEvent.pointerDown(gamma, { button: 0, pointerId: 1, pointerType: "touch", clientX: 10, clientY: 75 });
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 20 });
    act(() => void vi.advanceTimersByTime(1000));
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 5 });
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 5 });
    expect(movePageTo).not.toHaveBeenCalled();
    // Hold, then drag to the top.
    fireEvent.pointerDown(gamma, { button: 0, pointerId: 2, pointerType: "touch", clientX: 10, clientY: 75 });
    act(() => void vi.advanceTimersByTime(400));
    fireEvent.pointerMove(window, { pointerId: 2, pointerType: "touch", clientX: 10, clientY: 5 });
    expect(drop("a")).toBe("before");
    fireEvent.pointerUp(window, { pointerId: 2, pointerType: "touch", clientX: 10, clientY: 5 });
    expect(movePageTo).toHaveBeenCalledWith("c", 0);
  });

  it("Escape and a cancelled pointer abandon the drag", () => {
    renderSidebar();
    layOutRows();
    const alpha = rowButton("Alpha");
    fireEvent.pointerDown(alpha, { button: 0, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 15 });
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 85 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 85 });
    fireEvent.pointerDown(alpha, { button: 0, pointerId: 2, pointerType: "mouse", clientX: 10, clientY: 15 });
    fireEvent.pointerMove(window, { pointerId: 2, pointerType: "mouse", clientX: 10, clientY: 85 });
    fireEvent.pointerCancel(window, { pointerId: 2 });
    fireEvent.pointerUp(window, { pointerId: 2, pointerType: "mouse", clientX: 10, clientY: 85 });
    expect(movePageTo).not.toHaveBeenCalled();
    expect(document.querySelector("[data-drop]")).toBeNull();
  });
});
