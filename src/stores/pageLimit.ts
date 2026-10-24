// Tells the user when the pen stops because the page hit LIMITS.MAX_ELEMENTS_PER_PAGE: a toast the
// first time `limitReached` flips true for each page load of an editor instance.
import { showToast } from "../components/Toast";
import i18n from "../i18n";
import { LIMITS } from "../model/constants";
import { MAX_TABLE_CELLS } from "../text/tableCode";
import type { EditorStore } from "./editor";

export const pageFullToast = (): string => i18n.t("editor.pageFull", { max: LIMITS.MAX_ELEMENTS_PER_PAGE });

export const tableLimitToast = (): string =>
  i18n.t("editor.tableLimit", { max: MAX_TABLE_CELLS.toLocaleString("en-US").replace(/,/g, " ") });

export function watchPageLimit(store: EditorStore): () => void {
  let shownFor: string | null = null;
  return store.subscribe((s, prev) => {
    if (s.loadedPageId !== prev.loadedPageId) shownFor = null;
    if (!s.limitReached || prev.limitReached || s.loadedPageId === null) return;
    if (shownFor === s.loadedPageId) return;
    shownFor = s.loadedPageId;
    showToast(s.limitKind === "table" ? tableLimitToast() : pageFullToast());
  });
}
