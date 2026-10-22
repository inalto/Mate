// Tells the user when the pen stops because the page hit LIMITS.MAX_ELEMENTS_PER_PAGE: a toast the
// first time `limitReached` flips true for each page load of an editor instance.
import { showToast } from "../components/Toast";
import { LIMITS } from "../model/constants";
import { MAX_TABLE_CELLS } from "../text/tableCode";
import type { EditorStore } from "./editor";

export const PAGE_FULL_TOAST = `This page is full (${LIMITS.MAX_ELEMENTS_PER_PAGE} items) — start a new page.`;

export const TABLE_LIMIT_TOAST = `Table is at its size limit (${MAX_TABLE_CELLS.toLocaleString("en-US").replace(/,/g, " ")} cells)`;

export function watchPageLimit(store: EditorStore): () => void {
  let shownFor: string | null = null;
  return store.subscribe((s, prev) => {
    if (s.loadedPageId !== prev.loadedPageId) shownFor = null;
    if (!s.limitReached || prev.limitReached || s.loadedPageId === null) return;
    if (shownFor === s.loadedPageId) return;
    shownFor = s.loadedPageId;
    showToast(s.limitKind === "table" ? TABLE_LIMIT_TOAST : PAGE_FULL_TOAST);
  });
}
