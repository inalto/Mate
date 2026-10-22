// The `.pdf` file association: the PDF the app was started with (once) and PDFs opened while it
// runs (`incoming-file-open`, macOS) are imported into the default section and opened.
import { onIncomingFileOpen, takePendingOpenFile } from "../ipc/pdf";
import { importPdfFromPath } from "./import";

/** Start handling opened PDFs; `open` shows the new page. Returns a detach function. */
export function installPdfOpenHandler(open: (pageId: string) => void): () => void {
  let detached = false;
  let unlisten: (() => void) | null = null;
  const handle = async (path: string) => {
    const page = await importPdfFromPath(path);
    if (page && !detached) open(page.id);
  };
  // Listen first: a file opened after the pending one was taken is emitted, never parked.
  void onIncomingFileOpen((path) => void handle(path))
    .then((fn) => (detached ? fn() : (unlisten = fn)))
    .catch(() => {})
    .then(() => (detached ? null : takePendingOpenFile()))
    .then((path) => (path ? handle(path) : undefined))
    .catch(() => {});
  return () => {
    detached = true;
    unlisten?.();
  };
}
