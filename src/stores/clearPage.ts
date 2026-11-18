// "Clear page": remove what was written or placed on a page. Locked elements and the pages of an
// imported PDF stay. A page shown in an editor pane is cleared through that editor (one undo step);
// any other page is cleared in the database, which cannot be undone.
import { deleteElements, loadElements } from "../ipc/elements";
import { elementsQueue } from "../ipc/elementsQueue";
import { isLocked, isPdfPlacement } from "../model/content";
import type { Element } from "../model/types";
import { updateThumbnail } from "../thumbnails";
import type { EditorStore } from "./editor";
import { editorForPane } from "./focusedEditor";
import { useNotebookStore } from "./notebook";

const clearable = (el: Element): boolean => !isLocked(el) && !isPdfPlacement(el);

const editorShowing = (pageId: string): EditorStore | null => {
  for (const i of [0, 1] as const) {
    const store = editorForPane(i);
    if (store.getState().pageId === pageId) return store;
  }
  return null;
};

/** True when an editor pane shows the page (so clearing it can be undone). */
export const pageIsOpen = (pageId: string): boolean => editorShowing(pageId) !== null;

/** Clear the page; resolves to how many elements were removed. */
export async function clearPage(pageId: string): Promise<number> {
  const editor = editorShowing(pageId);
  if (editor) {
    const ids = [...editor.getState().elements.values()].filter(clearable).map((el) => el.id);
    if (ids.length > 0) editor.getState().removeElements(ids, "Clear page");
    return ids.length;
  }
  // Strokes drawn just before the page was left may still sit in the write-behind queue.
  await elementsQueue.flushAll();
  const els = await loadElements(pageId);
  const ids = els.filter(clearable).map((el) => el.id);
  if (ids.length === 0) return 0;
  await deleteElements(ids);
  // Nothing redraws a page that is not open: refresh its thumbnail here (best effort).
  const page = useNotebookStore.getState().tree.pages.find((p) => p.id === pageId);
  if (page) {
    try {
      await updateThumbnail(pageId, els.filter((el) => !clearable(el)), page);
    } catch (err) {
      console.warn("thumbnail after clear failed", err);
    }
  }
  return ids.length;
}
