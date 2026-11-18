// Opens the scan screen. One request at a time lives in this store; the dialog is mounted once in
// Shell and renders while a request is set. The dialog stores nothing itself: it hands the result
// to `onDone`, so the caller saves the asset only when the user actually inserts. The helpers below
// are the sources: a new scan inserted on the page, a file picked from the palette, and Straighten
// on an image already there.
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { showToast } from "../components/Toast";
import { insertAsset } from "../images/insert";
import { loadImage } from "../images/load";
import i18n from "../i18n";
import { assetInfo, saveAsset } from "../ipc/assets";
import { contentOf, isLocked, isPdfPlacement, type ImageContent } from "../model/content";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { getFocusedEditor } from "../stores/focusedEditor";

export interface ScanResult {
  blob: Blob;
  width: number;
  height: number;
}

export interface ScanRequest {
  /** The photo, or "webcam" to capture a frame first. */
  source: Blob | CanvasImageSource | "webcam";
  /** Called once with the rectified image; the dialog closes when it resolves, stays open if it throws. */
  onDone: (r: ScanResult) => Promise<void> | void;
}

interface ScanState {
  request: ScanRequest | null;
  open(r: ScanRequest): void;
  close(): void;
}

export const useScanStore: UseBoundStore<StoreApi<ScanState>> = create<ScanState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export const openScan = (r: ScanRequest): void => useScanStore.getState().open(r);

const scanFailed = (): string => i18n.t("scan.failed");

/** Scan `source` and insert the result into `store`'s page (default: the focused pane) as a new image. */
export function scanToPage(source: Blob | CanvasImageSource | "webcam", store: EditorStore = getFocusedEditor()): void {
  openScan({
    source,
    onDone: async (r) => {
      const info = await saveAsset(new Uint8Array(await r.blob.arrayBuffer()), r.blob.type);
      // insertAsset has already toasted; throwing keeps the screen open for another try.
      if ((await insertAsset(store, info)) === null) throw new Error("insert failed");
    },
  });
}

/** Palette entry: pick an image file (never the camera) and scan it. */
export function scanFromFilePicker(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.hidden = true;
  const done = () => input.remove();
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    done();
    if (file) scanToPage(file);
  });
  input.addEventListener("cancel", done);
  document.body.appendChild(input); // some webviews ignore a click on a detached input
  input.click();
}

/**
 * What can be decided without reading the asset: an unlocked image that is not a PDF page placement.
 * An SVG is refused later, by `straightenImage` (the type is only known from the asset).
 */
export function canStraighten(el: Element): boolean {
  return el.type === "image" && !!el.imageUrl && !isLocked(el) && !isPdfPlacement(el);
}

/**
 * Straighten the image `elementId` of `store`: scan its whole stored photo and replace the asset,
 * keeping the centre, width and rotation, taking the new aspect and dropping any crop. One history
 * entry "Scan", so undo brings the old photo back.
 */
export async function straightenImage(store: EditorStore, elementId: string): Promise<void> {
  const el = store.getState().elements.get(elementId);
  if (!el || !canStraighten(el) || !el.imageUrl) return;
  const id = el.imageUrl;
  try {
    if ((await assetInfo(id))?.mime === "image/svg+xml") throw new Error("svg");
    const image = await loadImage(id);
    if (!image) throw new Error("undecodable");
    openScan({
      source: image,
      onDone: async (r) => {
        const info = await saveAsset(new Uint8Array(await r.blob.arrayBuffer()), r.blob.type);
        const cur = store.getState().elements.get(elementId);
        if (!cur || cur.type !== "image") return; // deleted meanwhile; the asset is left to the garbage collection
        const width = cur.width ?? 0;
        const height = (width * r.height) / r.width;
        const a = cur.points[0] ?? { x: 0, y: 0 };
        const cx = a.x + width / 2;
        const cy = a.y + (cur.height ?? 0) / 2;
        const content: ImageContent = { ...contentOf<ImageContent>(cur) };
        delete content.cropTop;
        delete content.cropBottom;
        delete content.cropLeft;
        delete content.cropRight;
        store.getState().updateElements(
          [{ ...cur, imageUrl: info.id, height, points: [{ x: cx - width / 2, y: cy - height / 2 }, ...cur.points.slice(1)], content }],
          "Scan",
        );
      },
    });
  } catch {
    showToast(scanFailed());
  }
}
