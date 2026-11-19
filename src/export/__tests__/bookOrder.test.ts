import { describe, expect, it } from "vitest";
import type { NotebookTree, Page, Section } from "../../model/types";
import { orderedSections } from "../bookOrder";

const STAMP = "2026-01-01T00:00:00.000Z";
const section = (id: string, orderIndex: number, extra: Partial<Section> = {}): Section => ({
  id,
  unitId: "u1",
  title: id,
  color: "#000",
  orderIndex,
  isExpanded: true,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
  ...extra,
});
const page = (id: string, sectionId: string, orderIndex: number, extra: Partial<Page> = {}): Page => ({
  id,
  sectionId,
  title: id,
  isExpanded: false,
  isFavourite: false,
  depth: 0,
  mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
  ...extra,
});
const tree = (sections: Section[], pages: Page[]): NotebookTree => ({ bookshelves: [], units: [], sections, pages });
const ids = (t: NotebookTree, scope: Parameters<typeof orderedSections>[1]) =>
  orderedSections(t, scope).map((s) => [s.section.id, s.pages.map((p) => p.id)]);

describe("orderedSections", () => {
  it("orders sections and pages by their order index", () => {
    const t = tree(
      [section("s2", 1), section("s1", 0)],
      [page("c", "s2", 0), page("b", "s1", 1), page("a", "s1", 0)],
    );
    expect(ids(t, { kind: "book", unitId: "u1" })).toEqual([
      ["s1", ["a", "b"]],
      ["s2", ["c"]],
    ]);
  });

  it("puts nested pages right after their parent", () => {
    const t = tree(
      [section("s1", 0)],
      [
        page("b", "s1", 1),
        page("a", "s1", 0),
        page("a2", "s1", 1, { parentId: "a", depth: 1 }),
        page("a1", "s1", 0, { parentId: "a", depth: 1 }),
        page("a1x", "s1", 0, { parentId: "a1", depth: 2 }),
      ],
    );
    expect(ids(t, { kind: "book", unitId: "u1" })).toEqual([["s1", ["a", "a1", "a1x", "a2", "b"]]]);
  });

  it("keeps a page whose parent is missing or deleted, at the top level", () => {
    const t = tree(
      [section("s1", 0)],
      [
        page("a", "s1", 0),
        page("orphan", "s1", 1, { parentId: "gone", depth: 1 }),
        page("dead", "s1", 2, { deletedAt: STAMP }),
        page("child-of-dead", "s1", 0, { parentId: "dead", depth: 1 }),
      ],
    );
    expect(ids(t, { kind: "book", unitId: "u1" })).toEqual([["s1", ["a", "child-of-dead", "orphan"]]]);
  });

  it("leaves out deleted sections, other books and sections without pages", () => {
    const t = tree(
      [section("s1", 0), section("empty", 1), section("dead", 2, { deletedAt: STAMP }), section("other", 3, { unitId: "u2" })],
      [page("a", "s1", 0), page("d", "dead", 0), page("o", "other", 0)],
    );
    expect(ids(t, { kind: "book", unitId: "u1" })).toEqual([["s1", ["a"]]]);
  });

  it("returns only the section asked for", () => {
    const t = tree([section("s1", 0), section("s2", 1)], [page("a", "s1", 0), page("c", "s2", 0)]);
    expect(ids(t, { kind: "section", sectionId: "s2" })).toEqual([["s2", ["c"]]]);
    expect(ids(t, { kind: "section", sectionId: "nope" })).toEqual([]);
  });
});
