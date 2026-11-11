import { describe, expect, it } from "vitest";
import type { Element, NotebookTree } from "../../model/types";
import { copiesForPage, sendTargets } from "../sendSelection";

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
