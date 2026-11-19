// The pages of a section or a book in the order the sidebar shows them: sections by order, pages
// by order under their parent, children right after their parent.
import type { NotebookTree, Page, Section } from "../model/types";

export type ExportScope = { kind: "section"; sectionId: string } | { kind: "book"; unitId: string };

export interface OrderedSection {
  section: Section;
  /** Depth-first sidebar order. */
  pages: Page[];
}

const byOrder = (a: { orderIndex: number }, b: { orderIndex: number }) => a.orderIndex - b.orderIndex;

/**
 * The sections of `scope` with their pages. Deleted sections and pages are left out, a page whose
 * parent is missing sits at the top level (as in the sidebar), and a section without pages is dropped.
 */
export function orderedSections(tree: NotebookTree, scope: ExportScope): OrderedSection[] {
  const sections = tree.sections
    .filter((s) => !s.deletedAt && (scope.kind === "section" ? s.id === scope.sectionId : s.unitId === scope.unitId))
    .sort(byOrder);
  const live = tree.pages.filter((p) => !p.deletedAt);
  const ids = new Set(live.map((p) => p.id));
  const byParent = new Map<string | undefined, Page[]>();
  for (const p of [...live].sort(byOrder)) {
    const key = p.parentId && ids.has(p.parentId) ? p.parentId : undefined;
    byParent.set(key, [...(byParent.get(key) ?? []), p]);
  }
  const out: OrderedSection[] = [];
  for (const section of sections) {
    const pages: Page[] = [];
    const seen = new Set<string>();
    const walk = (p: Page) => {
      if (seen.has(p.id) || p.sectionId !== section.id) return;
      seen.add(p.id);
      pages.push(p);
      for (const child of byParent.get(p.id) ?? []) walk(child);
    };
    for (const p of byParent.get(undefined) ?? []) walk(p);
    if (pages.length > 0) out.push({ section, pages });
  }
  return out;
}
