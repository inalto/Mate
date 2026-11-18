import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
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

  it("focusPane_keeps_active_tab_when_page_open_in_another_tab", () => {
    s().openPage("b");
    const x = s().activeTabId!;
    s().openPage("a", { newTab: true });
    const y = s().activeTabId!;
    s().split(y, "b"); // b is now in tab X and in split tab Y
    s().focusPane(y, 0);
    s().focusPane(y, 1);
    s().openPage("b"); // what the URL sync does
    expect(s().activeTabId).toBe(y);
    expect(s().activeTabId).not.toBe(x);
    expect(s().tabs.find((t) => t.id === y)!.focusedPaneIndex).toBe(1);
  });
});

describe("tabs across books", () => {
  const section = (id: string, unitId: string) => ({
    id,
    unitId,
    title: id,
    color: "#000",
    orderIndex: 0,
    isExpanded: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    version: 0,
  });
  const inSection = (id: string, sectionId: string): Page => ({ ...page(id, id.toUpperCase()), sectionId });

  beforeEach(() => {
    localStorage.clear();
    useNotebookStore.setState({
      loaded: true,
      tree: {
        bookshelves: [],
        units: [],
        sections: [section("s1", "maths"), section("s1b", "maths"), section("s2", "history")],
        // m1..m3 are in the book "maths" (two sections), h1 and h2 in "history"; x has no known section.
        pages: [inSection("m1", "s1"), inSection("m2", "s1b"), inSection("m3", "s1"), inSection("h1", "s2"), inSection("h2", "s2"), inSection("x", "gone")],
      },
    });
    useTabsStore.getState().reset();
  });

  const shown = () => s().tabs.map((t) => t.panes.map((p) => p.pageId).join("|"));

  it("openPage_other_book_opens_new_tab", () => {
    s().openPage("m1");
    s().openPage("h1");
    expect(shown()).toEqual(["m1", "h1"]);
    expect(s().tabs[1].id).toBe(s().activeTabId);
  });

  it("openPage_same_book_replaces", () => {
    s().openPage("m1");
    s().openPage("m2"); // another section of the same book
    expect(shown()).toEqual(["m2"]);
  });

  it("openPage_unknown_book_replaces", () => {
    s().openPage("m1");
    s().openPage("x");
    expect(shown()).toEqual(["x"]);
    s().openPage("h1");
    expect(shown()).toEqual(["h1"]);
  });

  it("openPage_other_book_reuses_its_tab", () => {
    s().openPage("m1");
    s().openPage("h1");
    s().openPage("m1");
    expect(shown()).toEqual(["m1", "h1"]);
    expect(s().activeTabId).toBe(s().tabs[0].id);
  });

  it("openPage_other_book_from_split_keeps_split", () => {
    s().openPage("m1");
    s().split(s().activeTabId!, "m2");
    s().openPage("h1");
    expect(shown()).toEqual(["m1|m2", "h1"]);
  });

  it("openPage_follows_the_focused_pane_book", () => {
    s().openPage("m1");
    s().split(s().activeTabId!, "h1"); // focus is on h1
    s().openPage("h2");
    expect(shown()).toEqual(["m1|h2"]);
  });

  it("new_tab_sits_after_last_tab_of_its_book", () => {
    s().openPage("m1");
    s().openPage("h1");
    s().openPage("m3", { newTab: true });
    expect(shown()).toEqual(["m1", "m3", "h1"]);
    s().activateTab(s().tabs[0].id);
    s().openPage("h2", { newTab: true });
    expect(shown()).toEqual(["m1", "m3", "h1", "h2"]);
  });
});
