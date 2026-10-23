import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: { flushAll: vi.fn(async () => {}) } }));
vi.mock("../windowBridge", () => ({ openPageInWindow: vi.fn() }));

import { elementsQueue } from "../../ipc/elementsQueue";
import type { Page } from "../../model/types";
import { useChromeStore } from "../../stores/chrome";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useTabsStore } from "../../stores/tabs";
import { runEditorShortcut, sectionPageOrder } from "../editorCommands";
import { openPageInWindow } from "../windowBridge";

const page = (id: string, orderIndex: number, parentId: string | null = null, sectionId = "s1"): Page =>
  ({ id, sectionId, parentId, title: id, orderIndex, depth: parentId ? 1 : 0 }) as Page;

let spies: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  spies = Object.fromEntries(
    [
      "duplicateSelection",
      "bringForward",
      "sendBackward",
      "toFront",
      "toBack",
      "resetCamera",
      "setCamera",
      "groupSelection",
      "ungroupSelection",
      "selectAll",
      "select",
    ].map((k) => [k, vi.fn()]),
  );
  useEditorStore.setState({ ...spies, selection: new Set<string>(), viewport: { width: 800, height: 600 } } as never);
  useChromeStore.setState({ paletteOpen: false, shortcutsOpen: false });
  useNotebookStore.setState({
    tree: {
      bookshelves: [],
      units: [],
      sections: [],
      pages: [page("a", 0), page("a1", 0, "a"), page("b", 1), page("x", 0, null, "s2")],
    },
    duplicatePage: vi.fn(async () => null),
  } as never);
  useTabsStore.getState().reset();
  useTabsStore.getState().openPage("b");
});
afterEach(() => vi.clearAllMocks());

const focused = () => {
  const t = useTabsStore.getState();
  return t.tabs.find((x) => x.id === t.activeTabId)!.panes[0].pageId;
};

describe("runEditorShortcut", () => {
  it("ctrl_d_duplicates_selection_else_page", () => {
    runEditorShortcut("duplicate", {});
    expect(useNotebookStore.getState().duplicatePage).toHaveBeenCalledWith("b");
    expect(spies.duplicateSelection).not.toHaveBeenCalled();
    useEditorStore.setState({ selection: new Set(["e1"]) });
    runEditorShortcut("duplicate", {});
    expect(spies.duplicateSelection).toHaveBeenCalledTimes(1);
    expect(useNotebookStore.getState().duplicatePage).toHaveBeenCalledTimes(1);
    runEditorShortcut("page.duplicate", {});
    expect(useNotebookStore.getState().duplicatePage).toHaveBeenCalledTimes(2);
  });

  it("dispatches_arrange_group_and_selection_actions", () => {
    const cases: [string, string][] = [
      ["arrange.forward", "bringForward"],
      ["arrange.backward", "sendBackward"],
      ["arrange.front", "toFront"],
      ["arrange.back", "toBack"],
      ["group", "groupSelection"],
      ["ungroup", "ungroupSelection"],
      ["selectAll", "selectAll"],
      ["deselect", "select"],
    ];
    for (const [action, method] of cases) {
      runEditorShortcut(action as never, {});
      expect(spies[method], action).toHaveBeenCalledTimes(1);
    }
  });

  it("dispatches_zoom", () => {
    runEditorShortcut("zoom.reset", {});
    expect(spies.resetCamera).toHaveBeenCalledTimes(1);
    runEditorShortcut("zoom.in", {});
    runEditorShortcut("zoom.out", {});
    expect(spies.setCamera).toHaveBeenCalledTimes(2);
  });

  it("steps_through_pages_in_sidebar_order_within_the_section", () => {
    expect(sectionPageOrder(useNotebookStore.getState().tree.pages, "s1")).toEqual(["a", "a1", "b"]);
    runEditorShortcut("page.prev", {});
    expect(focused()).toBe("a1");
    runEditorShortcut("page.prev", {});
    runEditorShortcut("page.prev", {}); // already first: stays
    expect(focused()).toBe("a");
    runEditorShortcut("page.next", {});
    expect(focused()).toBe("a1");
  });

  it("save_flushes_queue_help_opens_overlay_and_window_bridge_is_called", () => {
    runEditorShortcut("save", {});
    expect(elementsQueue.flushAll).toHaveBeenCalled();
    runEditorShortcut("help.shortcuts", {});
    expect(useChromeStore.getState().shortcutsOpen).toBe(true);
    runEditorShortcut("window.openPage", {});
    expect(openPageInWindow).toHaveBeenCalledWith("b");
  });
});
