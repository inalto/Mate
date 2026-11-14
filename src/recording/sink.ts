// Streams recording segments to disk through Rust as they grow, so a crash loses at most the last chunk.
import { invoke } from "@tauri-apps/api/core";
import { type AssetInfo, remember } from "../ipc/assets";
import type { Segment, Span } from "./types";

/** Where a running recording's audio goes. */
export interface SegmentSink {
  append(index: number, bytes: Uint8Array): Promise<void>;
  /** Move the finished segment into the asset store; null when it holds no audio. */
  finish(index: number): Promise<AssetInfo | null>;
}

/** Everything needed to resume or salvage a recording after a crash. */
export interface Manifest {
  recId: string;
  unitId: string;
  pageId: string;
  at: { x: number; y: number };
  spans: Span[];
  segments: Segment[];
  openIndex: number;
  openSpanWallStart: string | null;
  mime: string;
}

/** Create the recording's work folder with its first manifest. */
export const beginRecording = async (m: Manifest): Promise<SegmentSink> => {
  await invoke("recording_begin", { recId: m.recId, manifest: m });
  return {
    append: (index, bytes) =>
      invoke<void>("recording_append", bytes, { headers: { "x-rec-id": m.recId, "x-rec-index": String(index) } }),
    finish: async (index) => {
      const info = await invoke<AssetInfo | null>("recording_finish_segment", { recId: m.recId, index });
      return info ? remember(info) : null;
    },
  };
};

export const saveManifest = (m: Manifest): Promise<void> =>
  invoke<void>("recording_save_manifest", { recId: m.recId, manifest: m });

/** Remove the work folder once the marker element is saved. */
export const closeRecording = (recId: string): Promise<void> => invoke<void>("recording_close", { recId });

/** Recordings a crash left behind, oldest first, with the indexes of their non-empty parts. */
export const unfinishedRecordings = (): Promise<{ recId: string; manifest: Manifest; parts: number[] }[]> =>
  invoke("recording_unfinished");
