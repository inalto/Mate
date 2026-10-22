// PDF import commands: storing a PDF from a path (size-checked and sniffed in Rust) and the
// file-association handshake (`take_pending_open_file` once at startup, then `incoming-file-open`).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AssetInfo } from "./assets";

/** Store the PDF at `path` in the asset store. Rejects with "PDF is larger than 50 MiB." when too big. */
export const readSharedPdf = (path: string): Promise<AssetInfo> => invoke<AssetInfo>("read_shared_pdf", { path });

/** The PDF the app was opened with (once), else null. */
export const takePendingOpenFile = (): Promise<string | null> => invoke<string | null>("take_pending_open_file");

/** Call `cb` with the path of each PDF opened while the app runs; resolves to an unlisten function. */
export const onIncomingFileOpen = (cb: (path: string) => void): Promise<() => void> =>
  listen<string>("incoming-file-open", (e) => cb(e.payload));
