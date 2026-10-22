// Page thumbnails: render the page (background + strokes) into an offscreen canvas 320 px wide and
// export WebP. Always drawn with the light theme so cards look the same in every app theme.
import { paintBackground, type Rect } from "./canvas/background";
import { sheetSize } from "./canvas/camera";
import { renderStroke } from "./ink/render";
import { saveThumbnail } from "./ipc/thumbnails";
import type { Element, Page } from "./model/types";
import { editorForPane, getFocusedEditor } from "./stores/focusedEditor";
import type { EditorStore } from "./stores/editor";
import { useNotebookStore } from "./stores/notebook";
import { useSettingsStore } from "./stores/settings";
import { elementBounds } from "./tools/spatialIndex";
import { renderOrder } from "./tools/zorder";

export const THUMB_WIDTH = 320;
export const THUMB_MAX_HEIGHT = 480;
export const THUMB_QUALITY = 0.6;
export const THUMB_DEBOUNCE_MS = 2000;
const CONTENT_PADDING = 40;

/** World-space rectangle shown in the thumbnail: the first sheet (page mode) or content + padding. */
export function thumbnailRegion(page: Page, elements: Iterable<Element>, defaultAspect: string): Rect {
  if (page.mode === "page") {
    const { width, height } = sheetSize(page, defaultAspect);
    return { x: 0, y: 0, width, height };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    const b = elementBounds(el);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1024, height: 768 };
  const width = Math.max(maxX - minX + 2 * CONTENT_PADDING, 320);
  const height = Math.max(maxY - minY + 2 * CONTENT_PADDING, 240);
  return { x: minX - CONTENT_PADDING, y: minY - CONTENT_PADDING, width, height };
}

/** Render `elements` of `page` to a WebP blob, 320 px wide. */
export async function captureThumbnail(pageId: string, elements: Iterable<Element>, page: Page): Promise<Blob> {
  const aspect = useSettingsStore.getState().settings.defaultPageAspectRatio;
  const list = [...elements].filter((e) => e.pageId === pageId);
  const region = thumbnailRegion(page, list, aspect);
  const scale = THUMB_WIDTH / region.width;
  const height = Math.min(THUMB_MAX_HEIGHT, Math.max(1, Math.round(region.height * scale)));
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, THUMB_WIDTH, height);
  ctx.scale(scale, scale);
  ctx.translate(-region.x, -region.y);
  const clip: Rect = { x: region.x, y: region.y, width: region.width, height: height / scale };
  const sheet = { mode: page.mode, ...sheetSize(page, aspect), count: 1 };
  const colors = { paper: "#ffffff", desk: "#eceef1" };
  paintBackground(ctx, page.backgroundConfig, clip, sheet, "light", colors);
  for (const el of renderOrder(list)) if (el.type === "stroke") renderStroke(ctx, el, "light", scale);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("thumbnail encoding failed"))), "image/webp", THUMB_QUALITY),
  );
}

/** Capture and store a page's thumbnail, then refresh the tree so cards pick up the new version. */
export async function updateThumbnail(pageId: string, elements: Iterable<Element>, page: Page): Promise<void> {
  const blob = await captureThumbnail(pageId, elements, page);
  await saveThumbnail(pageId, new Uint8Array(await blob.arrayBuffer()));
  await useNotebookStore.getState().load();
}

/**
 * Capture the focused pane's thumbnail 2 s after its last element (or page layout) change. Pending
 * captures run immediately on dispose, so leaving the editor right after drawing still updates it.
 */
export function watchThumbnails(): () => void {
  interface Pending {
    timer: ReturnType<typeof setTimeout>;
    pageId: string;
    elements: Map<string, Element>;
    page: Page;
  }
  const pending = new Map<EditorStore, Pending>();
  /** Capture the recorded snapshot (not whatever the store holds now) and clear the timer. */
  const flush = (store: EditorStore) => {
    const p = pending.get(store);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(store);
    updateThumbnail(p.pageId, p.elements.values(), p.page).catch((err) => console.error("thumbnail capture failed", err));
  };
  const unsubs = ([0, 1] as const).map((i) => {
    const store = editorForPane(i);
    return store.subscribe((s, prev) => {
      // The store moved on to another page: capture the old one from its previous state now.
      const p = pending.get(store);
      if (p && s.pageId !== p.pageId) {
        if (prev.pageId === p.pageId && prev.page && prev.loadedPageId === p.pageId) {
          p.elements = prev.elements;
          p.page = prev.page;
        }
        flush(store);
        return;
      }
      const sameLoad = s.loadedPageId !== null && s.loadedPageId === prev.loadedPageId;
      const changed = s.elements !== prev.elements || (s.page !== prev.page && s.page?.id === prev.page?.id);
      if (!sameLoad || !changed || !s.page || !s.pageId || getFocusedEditor() !== store) return;
      if (p) clearTimeout(p.timer);
      pending.set(store, {
        timer: setTimeout(() => flush(store), THUMB_DEBOUNCE_MS),
        pageId: s.pageId,
        elements: s.elements,
        page: s.page,
      });
    });
  });
  return () => {
    unsubs.forEach((u) => u());
    for (const store of [...pending.keys()]) flush(store);
  };
}
