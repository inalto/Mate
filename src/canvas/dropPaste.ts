// Pasting and dropping images onto a canvas pane. Paste: clipboard image items go to the asset
// store as raw bytes. Drop: Tauri reports dropped file paths (physical pixels), which Rust reads
// itself so the bytes never cross IPC twice. Each insert is one history entry. A dropped PDF is
// imported as a new page in the pane's section (pdf/import) and opened.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { showToast } from "../components/Toast";
import { INSERT_FAILED, insertAsset, insertImageFromPath, isImagePath } from "../images/insert";
import { saveAsset } from "../ipc/assets";
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

  panes.add(host);
  const stopDrops = onFileDrop((paths, x, y) => {
    if (!inside(host, x, y)) return;
    const rect = host.getBoundingClientRect();
    const at = screenToWorld(store.getState().camera, { x: x - rect.left, y: y - rect.top });
    paths.filter(isImagePath).forEach((path, i) => {
      void insertImageFromPath(store, path, { x: at.x + i * 24, y: at.y + i * 24 });
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
