import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/notebook", () => ({}));

import type { Page } from "../../model/types";
import { useNotebookStore } from "../notebook";
import { TABS_STORAGE_KEY, useTabsStore } from "../tabs";

const page = (id: string, title: string): Page => ({
  id,
  sectionId: "s",
  title,
  isExpanded: true,
  isFavourite: false,
  depth: 0,
  mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  version: 0,
});

const s = () => useTabsStore.getState();

describe("tabs store", () => {
  beforeEach(() => {
    localStorage.clear();
    useNotebookStore.setState({
      loaded: true,
      tree: { bookshelves: [], units: [], sections: [], pages: [page("a", "Alpha"), page("b", "Beta"), page("c", "Gamma")] },
    });
    useTabsStore.getState().reset();
  });

  it("openPage_reuses_tab_showing_page", () => {
    s().openPage("a");
    const first = s().activeTabId;
    s().openPage("b", { newTab: true });
    expect(s().tabs).toHaveLength(2);
    s().openPage("a", { newTab: true });
    expect(s().tabs).toHaveLength(2);
    expect(s().activeTabId).toBe(first);
    // Without newTab the active tab's page is replaced.
    s().openPage("c");
    expect(s().tabs).toHaveLength(2);
    expect(s().tabs[0].panes[0].pageId).toBe("c");
  });

  it("split_creates_two_panes_and_label_A_pipe_B", () => {
    s().openPage("a");
    const id = s().activeTabId!;
    s().split(id, "b");
    const tab = s().tabs[0];
    expect(tab.panes.map((p) => p.pageId)).toEqual(["a", "b"]);
    expect(tab.label).toBe("Alpha | Beta");
    expect(tab.focusedPaneIndex).toBe(1);
    s().split(id, "c"); // never more than two panes
    expect(s().tabs[0].panes.map((p) => p.pageId)).toEqual(["a", "c"]);
  });

  it("exitSplit_keeps_chosen_pane", () => {
    s().openPage("a");
    const id = s().activeTabId!;
    s().split(id, "b");
    s().exitSplit(id, 1);
    expect(s().tabs[0].panes.map((p) => p.pageId)).toEqual(["b"]);
    expect(s().tabs[0].label).toBe("Beta");
    expect(s().tabs[0].focusedPaneIndex).toBe(0);
  });

  it("persists_to_localStorage", () => {
    s().openPage("a");
    s().openPage("b", { newTab: true });
    const saved = JSON.parse(localStorage.getItem(TABS_STORAGE_KEY)!);
    expect(saved.tabs).toHaveLength(2);
    expect(saved.activeTabId).toBe(s().activeTabId);
    s().closeTab(s().activeTabId!);
    expect(JSON.parse(localStorage.getItem(TABS_STORAGE_KEY)!).tabs).toHaveLength(1);
    expect(s().activeTabId).toBe(s().tabs[0].id);
  });
});
