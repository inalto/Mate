// Pasting and dropping images onto a canvas pane. Paste: clipboard image items go to the asset
// store as raw bytes. Drop: Tauri reports dropped file paths (physical pixels), which Rust reads
// itself so the bytes never cross IPC twice. Each insert is one history entry. A dropped PDF is
// imported as a new page in the pane's section (pdf/import) and opened. Audio and video files
// (by MIME type on paste, by extension on drop) become media players; pasted SVG markup (clipboard
// text) is stored as an SVG image.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { showToast } from "../components/Toast";
import { insertAsset, insertFailed, insertImageFromPath, isImagePath } from "../images/insert";
import { saveAsset } from "../ipc/assets";
import { insertMediaFile, insertMediaFromPath, isMediaMime, isMediaPath } from "../media/insert";
import { importPdfFromPath, isPdfPath } from "../pdf/import";
import { navigateTo } from "../stores/navigation";
import { getFocusedEditor } from "../stores/focusedEditor";
import type { EditorStore } from "../stores/editor";
import { screenToWorld } from "./camera";

/** Image files carried by a clipboard / drag payload. */
export function imageFilesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  return files;
}

/** Audio / video files carried by a clipboard / drag payload. */
export function mediaFilesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" && isMediaMime(item.type)) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  return files;
}

/** True when `text` is SVG markup (`<svg`, or an XML prolog / comments / doctype before `<svg`). */
export function isSvgMarkup(text: string): boolean {
  const t = text.replace(/^\uFEFF/, "").trimStart();
  if (/^<svg[\s>/]/i.test(t)) return true;
  return /^<\?xml\b/i.test(t) && /^<\?xml[\s\S]*?<svg[\s>/]/i.test(t.slice(0, 4096)) && /<\/svg\s*>\s*$/i.test(t);
}

/** SVG markup in a clipboard payload's plain text, if that is all it holds. */
export function svgTextOf(data: DataTransfer | null): string | null {
  if (!data || typeof data.getData !== "function") return null;
  const text = data.getData("text/plain");
  return text && isSvgMarkup(text) ? text : null;
}

/** Store pasted SVG markup as an image asset and insert it into `store`'s page. */
export async function pasteSvgText(store: EditorStore, text: string): Promise<void> {
  try {
    const info = await saveAsset(new TextEncoder().encode(text), "image/svg+xml");
    await insertAsset(store, info);
  } catch {
    showToast(insertFailed());
  }
}

const isEditable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

/** Store pasted image `file` and insert it into `store`'s page. */
export async function pasteImageFile(store: EditorStore, file: File): Promise<void> {
  try {
    const info = await saveAsset(new Uint8Array(await file.arrayBuffer()), file.type);
    await insertAsset(store, info);
  } catch {
    showToast(insertFailed());
  }
}

/**
 * Wire paste and file drops for the pane shown in `host`. Paste acts only in the focused pane and
 * never while a text field or text editor has focus; neither acts while the pane presents. Returns a
 * detach function.
 */
export function attachDropPaste(host: HTMLElement, store: EditorStore): () => void {
  const onPaste = (e: ClipboardEvent) => {
    if (isEditable(e.target) || getFocusedEditor() !== store || store.getState().presenting) return;
    const files = imageFilesOf(e.clipboardData);
    const media = mediaFilesOf(e.clipboardData);
    const svg = files.length + media.length === 0 ? svgTextOf(e.clipboardData) : null;
    if (files.length + media.length === 0 && svg === null) return;
    e.preventDefault();
    for (const f of files) void pasteImageFile(store, f);
    for (const f of media) void insertMediaFile(store, f);
    if (svg !== null) void pasteSvgText(store, svg);
  };
  document.addEventListener("paste", onPaste);

  panes.add(host);
  const stopDrops = onFileDrop((paths, x, y) => {
    // Presenting: the page is read-only, and a drop on the pane is swallowed (no PDF import either).
    if (!inside(host, x, y) || store.getState().presenting) return;
    const rect = host.getBoundingClientRect();
    const at = screenToWorld(store.getState().camera, { x: x - rect.left, y: y - rect.top });
    paths.filter(isImagePath).forEach((path, i) => {
      void insertImageFromPath(store, path, { x: at.x + i * 24, y: at.y + i * 24 });
    });
    paths.filter(isMediaPath).forEach((path, i) => {
      void insertMediaFromPath(store, path, { x: at.x + i * 24, y: at.y + i * 24 });
    });
    importPdfs(paths, store.getState().page?.sectionId);
  });

  return () => {
    panes.delete(host);
    document.removeEventListener("paste", onPaste);
    stopDrops();
  };
}

/** Hosts of the canvas panes currently attached (a drop inside one is theirs). */
const panes = new Set<HTMLElement>();

function inside(host: HTMLElement, x: number, y: number): boolean {
  const r = host.getBoundingClientRect();
  return x >= r.left && y >= r.top && x <= r.left + r.width && y <= r.top + r.height;
}

/** Import dropped PDFs (default section when none is given) and open each new page. */
function importPdfs(paths: string[], sectionId?: string): void {
  for (const path of paths.filter(isPdfPath)) {
    void importPdfFromPath(path, sectionId).then((page) => page && navigateTo(`/edit/${page.id}`));
  }
}

/** Listen for file drops on the window; `cb` gets the paths and the CSS-pixel drop point. */
function onFileDrop(cb: (paths: string[], x: number, y: number) => void): () => void {
  let unlisten: (() => void) | null = null;
  let detached = false;
  try {
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type !== "drop") return;
        const dpr = window.devicePixelRatio || 1;
        cb(p.paths, p.position.x / dpr, p.position.y / dpr);
      })
      .then((fn) => (detached ? fn() : (unlisten = fn)))
      .catch(() => {});
  } catch {
    /* not running inside the Tauri shell */
  }
  return () => {
    detached = true;
    unlisten?.();
  };
}

/**
 * PDFs dropped anywhere outside a canvas pane (Home, Library, sidebar…) are imported into the
 * default section and opened. Returns a detach function.
 */
export function attachWindowPdfDrop(): () => void {
  return onFileDrop((paths, x, y) => {
    if ([...panes].some((h) => inside(h, x, y))) return;
    importPdfs(paths);
  });
}
