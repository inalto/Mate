// Opens the scan screen. One request at a time lives in this store; the dialog is mounted once in
// Shell and renders while a request is set. The dialog stores nothing itself: it hands the result
// to `onDone`, so the caller saves the asset only when the user actually inserts.
import { create, type StoreApi, type UseBoundStore } from "zustand";

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
