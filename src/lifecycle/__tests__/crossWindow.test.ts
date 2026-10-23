import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "../../model/types";

const win = vi.hoisted(() => ({ page: false }));
vi.mock("../../ipc/windows", () => ({
  isPageWindow: () => win.page,
  closeThisWindow: vi.fn(),
  currentWindowLabel: () => (win.page ? "page-p1" : "main"),
}));
vi.mock("../../ipc/notebook", () => ({
  getNotebookTree: vi.fn(async () => ({ bookshelves: [], units: [], sections: [], pages: [] })),
}));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));

import { getNotebookTree } from "../../ipc/notebook";
import { closeThisWindow } from "../../ipc/windows";
import { useNotebookStore } from "../../stores/notebook";
import { useTabsStore } from "../../stores/tabs";
import { createCrossWindowHandler, RELOAD_DEBOUNCE_MS } from "../crossWindow";

const stamp = "2026-01-01T00:00:00Z";
const page = (id: string, title: string): Page => ({
  id, sectionId: "s1", title, isExpanded: true, isFavourite: false, depth: 0, mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 }, thumbnailVersion: 0, orderIndex: 0,
  createdAt: stamp, updatedAt: stamp, version: 0,
});

describe("cross-window notebook sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    useTabsStore.getState().reset();
    useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [], sections: [], pages: [page("p1", "Algebra")] } });
    useTabsStore.getState().openPage("p1");
  });
  afterEach(() => {
    vi.useRealTimers();
    win.page = false;
  });

  it("page_window_closes_when_its_page_is_trashed_elsewhere", () => {
    win.page = true;
    const h = createCrossWindowHandler("page-p1");
    h.handle({ kind: "page-trashed", pageId: "p2", source: "main" });
    expect(closeThisWindow).not.toHaveBeenCalled();
    h.handle({ kind: "page-trashed", pageId: "p1", source: "main" });
    h.handle({ kind: "tree", source: "main" });
    expect(closeThisWindow).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it("page_window_follows_a_rename_made_elsewhere", () => {
    win.page = true;
    const h = createCrossWindowHandler("page-p1");
    h.handle({ kind: "page-updated", pageId: "p1", title: "Linear algebra", source: "main" });
    expect(useNotebookStore.getState().tree.pages[0].title).toBe("Linear algebra");
    h.dispose();
  });

  it("main_reloads_the_tree_once_for_a_burst_of_foreign_changes_and_ignores_its_own", async () => {
    const h = createCrossWindowHandler("main");
    h.handle({ kind: "page-updated", pageId: "p1", title: "X", source: "main" });
    await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS * 2);
    expect(getNotebookTree).not.toHaveBeenCalled();
    h.handle({ kind: "page-updated", pageId: "p1", title: "X", source: "page-p1" });
    h.handle({ kind: "tree", source: "page-p1" });
    await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS * 2);
    expect(getNotebookTree).toHaveBeenCalledTimes(1);
    // Main never closes itself.
    h.handle({ kind: "page-trashed", pageId: "p1", source: "page-p1" });
    expect(closeThisWindow).not.toHaveBeenCalled();
    h.dispose();
  });
});
