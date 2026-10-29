import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: { flushAll: vi.fn(async () => {}) } }));
vi.mock("../windowBridge", () => ({ openPageInWindow: vi.fn() }));

import { elementsQueue } from "../../ipc/elementsQueue";
import type { Page } from "../../model/types";
import { useChromeStore } from "../../stores/chrome";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useTabsStore } from "../../stores/tabs";
import { runEditorShortcut, sectionPageOrder, turnPage } from "../editorCommands";
import i18n from "../../i18n";
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
      "setPanHold",
    ].map((k) => [k, vi.fn()]),
  );
  useEditorStore.setState({ ...spies, selection: new Set<string>(), viewport: { width: 800, height: 600 } } as never);
  useChromeStore.setState({ paletteOpen: false, shortcutsOpen: false, modalDepth: 0 });
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
    useChromeStore.setState({ shortcutsOpen: false });
    runEditorShortcut("window.openPage", {});
    expect(openPageInWindow).toHaveBeenCalledWith("b");
  });

  it("help_overlay_blocks_editor_shortcuts_and_traps_focus", () => {
    useChromeStore.setState({ shortcutsOpen: true, modalDepth: 1 }); // as the mounted overlay sets it
    for (const a of ["delete", "undo", "cut", "escape", "duplicate", "save", "page.next"]) runEditorShortcut(a as never, {});
    expect(spies.select).not.toHaveBeenCalled();
    expect(elementsQueue.flushAll).not.toHaveBeenCalled();
    expect(focused()).toBe("b");
    runEditorShortcut("help.shortcuts", {});
    expect(useChromeStore.getState().shortcutsOpen).toBe(true);
  });

  it("modal_depth_blocks_editor_shortcuts_until_every_modal_is_popped", () => {
    const { pushModal, popModal } = useChromeStore.getState();
    pushModal();
    pushModal();
    for (const a of ["delete", "undo", "escape", "save", "page.next", "help.shortcuts", "palette.open"]) runEditorShortcut(a as never, {});
    expect(spies.select).not.toHaveBeenCalled();
    expect(elementsQueue.flushAll).not.toHaveBeenCalled();
    expect(useChromeStore.getState().shortcutsOpen).toBe(false);
    expect(useChromeStore.getState().paletteOpen).toBe(false);
    popModal();
    runEditorShortcut("selectAll", {});
    expect(spies.selectAll).not.toHaveBeenCalled();
    popModal();
    popModal(); // never below zero
    expect(useChromeStore.getState().modalDepth).toBe(0);
    runEditorShortcut("selectAll", {});
    expect(spies.selectAll).toHaveBeenCalled();
  });

  it("pan_release_passes_modal_guard", () => {
    // Space went down before a menu opened (or the window lost focus while a dialog was open):
    // the release must still end the pan, else pen strokes keep panning.
    useChromeStore.setState({ modalDepth: 1 });
    runEditorShortcut("pan", { phase: "down" });
    expect(spies.setPanHold).not.toHaveBeenCalled(); // a new pan does not start under a modal
    runEditorShortcut("pan", { phase: "up" });
    expect(spies.setPanHold).toHaveBeenCalledWith(false);
  });
});

describe("turnPage", () => {
  it("at_the_end_creates_and_opens_a_page", async () => {
    const createPage = vi.fn(async (sectionId: string, title: string) => ({ ...page("new", 2, null, sectionId), title }));
    useNotebookStore.setState({ createPage } as never);
    await turnPage(1); // "b" is the last page of s1 (a, a1, b)
    expect(createPage).toHaveBeenCalledWith("s1", i18n.t("common.pageName", { n: 4 }));
    expect(focused()).toBe("new");
  });

  it("in_the_middle_steps", async () => {
    const createPage = vi.fn();
    useNotebookStore.setState({ createPage } as never);
    await turnPage(-1);
    expect(focused()).toBe("a1");
    await turnPage(1);
    expect(focused()).toBe("b");
    expect(createPage).not.toHaveBeenCalled();
  });

  it("a_second_turn_while_creating_does_nothing", async () => {
    let resolve!: (p: Page) => void;
    const createPage = vi.fn(() => new Promise<Page>((r) => (resolve = r)));
    useNotebookStore.setState({ createPage } as never);
    const first = turnPage(1);
    await turnPage(1); // swipe again while the first create is in flight
    await turnPage(-1);
    expect(createPage).toHaveBeenCalledTimes(1);
    expect(focused()).toBe("b");
    resolve(page("new", 2));
    await first;
    expect(focused()).toBe("new");
    // The guard is released afterwards ("new" is not in the mocked tree: go back to "b" first).
    useTabsStore.getState().openPage("b");
    await turnPage(-1);
    expect(focused()).toBe("a1");
  });

  it("created_page_not_opened_when_focus_moved", async () => {
    let resolve!: (p: Page) => void;
    const createPage = vi.fn(() => new Promise<Page>((r) => (resolve = r)));
    useNotebookStore.setState({ createPage } as never);
    const pending = turnPage(1);
    useTabsStore.getState().openPage("x"); // the user went elsewhere meanwhile
    resolve(page("new", 2));
    await pending;
    expect(focused()).toBe("x");
  });

  it("failed_create_is_ignored", async () => {
    const createPage = vi.fn(async () => {
      throw new Error("disk full");
    });
    useNotebookStore.setState({ createPage } as never);
    await expect(turnPage(1)).resolves.toBeUndefined();
    expect(focused()).toBe("b");
    // Not stuck: the next turn still runs.
    await turnPage(-1);
    expect(focused()).toBe("a1");
  });

  it("at_the_start_backwards_does_nothing", async () => {
    const createPage = vi.fn();
    useNotebookStore.setState({ createPage } as never);
    useTabsStore.getState().openPage("a");
    await turnPage(-1);
    expect(focused()).toBe("a");
    expect(createPage).not.toHaveBeenCalled();
  });
});
