// Pasting and dropping images onto a canvas pane. Paste: clipboard image items go to the asset
// store as raw bytes. Drop: Tauri reports dropped file paths (physical pixels), which Rust reads
// itself so the bytes never cross IPC twice. Each insert is one history entry.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { showToast } from "../components/Toast";
import { INSERT_FAILED, insertAsset, insertImageFromPath, isImagePath } from "../images/insert";
import { saveAsset } from "../ipc/assets";
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

const isEditable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

/** Store pasted image `file` and insert it into `store`'s page. */
export async function pasteImageFile(store: EditorStore, file: File): Promise<void> {
  try {
    const info = await saveAsset(new Uint8Array(await file.arrayBuffer()), file.type);
    await insertAsset(store, info);
  } catch {
    showToast(INSERT_FAILED);
  }
}

/**
 * Wire paste and file drops for the pane shown in `host`. Paste acts only in the focused pane and
 * never while a text field or text editor has focus. Returns a detach function.
 */
export function attachDropPaste(host: HTMLElement, store: EditorStore): () => void {
  const onPaste = (e: ClipboardEvent) => {
    if (isEditable(e.target) || getFocusedEditor() !== store) return;
    const files = imageFilesOf(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) void pasteImageFile(store, f);
  };
  document.addEventListener("paste", onPaste);

  let unlisten: (() => void) | null = null;
  let detached = false;
  try {
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type !== "drop") return;
        const rect = host.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const sx = p.position.x / dpr - rect.left;
        const sy = p.position.y / dpr - rect.top;
        if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) return;
        const at = screenToWorld(store.getState().camera, { x: sx, y: sy });
        p.paths.filter(isImagePath).forEach((path, i) => {
          void insertImageFromPath(store, path, { x: at.x + i * 24, y: at.y + i * 24 });
        });
      })
      .then((fn) => (detached ? fn() : (unlisten = fn)))
      .catch(() => {});
  } catch {
    /* not running inside the Tauri shell */
  }

  return () => {
    detached = true;
    document.removeEventListener("paste", onPaste);
    unlisten?.();
  };
}
