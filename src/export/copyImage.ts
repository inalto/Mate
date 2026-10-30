// Copy the selection to the clipboard as a PNG image (the same renderer the PNG export uses).
import { selectionBounds } from "../tools/lasso";
import type { Rect } from "../tools/spatialIndex";
import type { EditorStore } from "../stores/editor";
import { renderPagePng } from "./exportPage";

/** Padding (page units) around the selection in region exports. */
export const REGION_PADDING = 16;

/** The selection's bounds plus `REGION_PADDING` on every side; `null` when nothing is selected. */
export function paddedSelectionRegion(store: EditorStore): Rect | null {
  const { elements, selection } = store.getState();
  const b = selectionBounds(elements, selection);
  if (!b) return null;
  const p = REGION_PADDING;
  return { x: b.x - p, y: b.y - p, width: b.width + 2 * p, height: b.height + 2 * p };
}

/** Render the selection to PNG and put it on the clipboard. False (never throws) when it cannot. */
export async function copySelectionAsImage(store: EditorStore): Promise<boolean> {
  try {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.write !== "function" || typeof ClipboardItem === "undefined") return false;
    const region = paddedSelectionRegion(store);
    const pageId = store.getState().loadedPageId;
    if (!region || !pageId) return false;
    const bytes = await renderPagePng(pageId, { region, scale: 2, theme: "light", background: "plain", pageFrame: false });
    const blob = new Blob([bytes as BlobPart], { type: "image/png" });
    await clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}
