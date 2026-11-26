import { beforeEach, describe, expect, it, vi } from "vitest";
import { originOf } from "../../model/content";
import type { Element, NotebookTree } from "../../model/types";
import { useEditorStore } from "../editor";
import { useNotebookStore } from "../notebook";
import { useTabsStore } from "../tabs";
import { copiesForPage, goToOrigin, sendTargets } from "../sendSelection";

const base = { isExpanded: true, isFavourite: false, createdAt: "", updatedAt: "", version: 0 };
const tree = {
  bookshelves: [],
  units: [
    { ...base, id: "u2", title: "Physics", orderIndex: 1 },
    { ...base, id: "u1", title: "Algebra", orderIndex: 0 },
  ],
  sections: [
    { ...base, id: "s1", unitId: "u1", title: "Week 1", color: "", orderIndex: 0 },
    { ...base, id: "s2", unitId: "u2", title: "Notes", color: "", orderIndex: 0 },
    { ...base, id: "s3", unitId: "gone", title: "Orphan", color: "", orderIndex: 0 },
  ],
  pages: [
    { ...base, id: "p3", sectionId: "s2", title: "Waves", depth: 0, orderIndex: 0 },
    { ...base, id: "p2", sectionId: "s1", title: "Second", depth: 0, orderIndex: 1 },
    { ...base, id: "p1", sectionId: "s1", title: "First", depth: 0, orderIndex: 0 },
    { ...base, id: "p4", sectionId: "s1", title: "Binned", depth: 0, orderIndex: 2, deletedAt: "x" },
    { ...base, id: "p5", sectionId: "s3", title: "Lost", depth: 0, orderIndex: 0 },
  ],
} as unknown as NotebookTree;

describe("send selection to another page", () => {
  it("targets_are_the_other_live_pages_in_notebook_order", () => {
    const targets = sendTargets(tree, "p1");
    expect(targets.map((x) => x.page.id)).toEqual(["p2", "p3"]);
    expect(targets.map((x) => x.path)).toEqual(["Algebra \u203a Week 1", "Physics \u203a Notes"]);
  });

  it("copies_get_fresh_ids_the_target_page_and_rebound_connectors", () => {
    const el = (id: string, over: Partial<Element> = {}): Element => ({
      id,
      pageId: "p1",
      type: "shape",
      points: [],
      color: "#000000",
      width: 2,
      isHighlighter: false,
      createdAt: "old",
      updatedAt: "old",
      version: 7,
      ...over,
    });
    const src = [
      el("a"),
      el("c", { type: "connector", content: { mode: "straight", source: { id: "a", side: "right" }, target: { id: "elsewhere", side: "left" } } }),
    ];
    const out = copiesForPage(src, "p2", "now");
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.pageId === "p2" && e.version === 0 && e.createdAt === "now")).toBe(true);
    expect(out[0].id).not.toBe("a");
    const ends = out[1].content as { source?: { id: string }; target?: { id: string } };
    expect(ends.source?.id).toBe(out[0].id); // follows the copy
    expect(ends.target).toBeUndefined(); // its element stayed behind: that end is freed
  });
});

const shape = (id: string, over: Partial<Element> = {}): Element => ({
  id,
  pageId: "p1",
  type: "shape",
  points: [],
  color: "#000000",
  width: 2,
  isHighlighter: false,
  createdAt: "old",
  updatedAt: "old",
  version: 1,
  ...over,
});

describe("origin link of sent copies", () => {
  it("a_copy_remembers_the_page_and_element_it_came_from", () => {
    const [a, b] = copiesForPage([shape("a"), shape("b", { content: { zIndex: 3 } })], "p2", "now");
    expect(originOf(a)).toEqual({ pageId: "p1", elementId: "a" });
    expect(originOf(b)).toEqual({ pageId: "p1", elementId: "b" });
    expect((b.content as { zIndex?: number }).zIndex).toBe(3); // other content kept
  });

  it("a_copy_of_a_copy_keeps_the_first_origin", () => {
    const first = copiesForPage([shape("a")], "p2", "t")[0];
    const second = copiesForPage([first], "p3", "t")[0];
    expect(originOf(second)).toEqual({ pageId: "p1", elementId: "a" });
  });

  it("origin_reader_rejects_malformed_content", () => {
    for (const content of [undefined, null, 5, "x", [], {}, { origin: null }, { origin: "p" }, { origin: { pageId: "p" } },
      { origin: { pageId: "", elementId: "e" } }, { origin: { pageId: "p", elementId: 3 } }]) {
      expect(originOf({ content })).toBeNull();
    }
    expect(originOf({ content: { origin: { pageId: "p", elementId: "e" } } })).toEqual({ pageId: "p", elementId: "e" });
  });
});

describe("goToOrigin", () => {
  const openPage = vi.fn();
  const withOrigin = { content: { origin: { pageId: "p2", elementId: "e1" } } };
  const load = (pageId: string, els: Element[]) =>
    useEditorStore.setState({ pageId, loadedPageId: pageId, elements: new Map(els.map((e) => [e.id, e])), selection: new Set() });

  beforeEach(() => {
    openPage.mockReset();
    useTabsStore.setState({ openPage });
    useNotebookStore.setState({ tree: tree as NotebookTree });
  });

  it("opens_the_page_and_selects_and_frames_the_element", async () => {
    load("p2", [shape("e1", { pageId: "p2", points: [{ x: 0, y: 0 } as never] })]);
    const fit = vi.fn();
    useEditorStore.setState({ fitSelection: fit });
    expect(await goToOrigin(withOrigin)).toBe("element");
    expect(openPage).toHaveBeenCalledWith("p2");
    expect([...useEditorStore.getState().selection]).toEqual(["e1"]);
    expect(fit).toHaveBeenCalled();
  });

  it("waits_for_the_page_to_load_before_selecting", async () => {
    load("p1", []);
    openPage.mockImplementation(() => {
      setTimeout(() => load("p2", [shape("e1", { pageId: "p2" })]), 10);
    });
    useEditorStore.setState({ fitSelection: vi.fn() });
    expect(await goToOrigin(withOrigin)).toBe("element");
    expect([...useEditorStore.getState().selection]).toEqual(["e1"]);
  });

  it("opens_only_the_page_when_the_element_is_gone", async () => {
    load("p2", []);
    expect(await goToOrigin(withOrigin)).toBe("page");
    expect(openPage).toHaveBeenCalledWith("p2");
    expect(useEditorStore.getState().selection.size).toBe(0);
  });

  it("reports_gone_and_opens_nothing_when_the_page_is_missing_or_binned", async () => {
    expect(await goToOrigin({ content: { origin: { pageId: "p4", elementId: "e1" } } })).toBe("gone"); // binned
    expect(await goToOrigin({ content: { origin: { pageId: "nope", elementId: "e1" } } })).toBe("gone");
    expect(await goToOrigin({ content: undefined })).toBe("gone");
    expect(openPage).not.toHaveBeenCalled();
  });
});
