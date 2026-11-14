import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}`, invoke }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: { flushAll: vi.fn() } }));

import { assetUrl } from "../../ipc/assets";
import { beginRecording, closeRecording, type Manifest, saveManifest, unfinishedRecordings } from "../sink";

const manifest: Manifest = {
  recId: "rec-1",
  unitId: "u",
  pageId: "p",
  at: { x: 1, y: 2 },
  spans: [],
  segments: [],
  openIndex: 0,
  openSpanWallStart: null,
  mime: "audio/webm",
};

beforeEach(() => invoke.mockReset().mockResolvedValue(undefined));

describe("segment sink", () => {
  it("begin_sends_the_manifest", async () => {
    await beginRecording(manifest);
    expect(invoke).toHaveBeenCalledWith("recording_begin", { recId: "rec-1", manifest });
  });

  it("append_sends_raw_bytes_with_both_headers", async () => {
    const sink = await beginRecording(manifest);
    const bytes = new Uint8Array([1, 2, 3]);
    await sink.append(4, bytes);
    expect(invoke).toHaveBeenLastCalledWith("recording_append", bytes, {
      headers: { "x-rec-id": "rec-1", "x-rec-index": "4" },
    });
  });

  it("finish_remembers_the_asset_path_so_assetUrl_needs_no_second_call", async () => {
    const sink = await beginRecording(manifest);
    invoke.mockResolvedValueOnce({ id: "a1", path: "/data/a1.webm", mime: "video/webm", bytes: 3 });
    expect((await sink.finish(0))?.id).toBe("a1");
    expect(invoke).toHaveBeenLastCalledWith("recording_finish_segment", { recId: "rec-1", index: 0 });
    invoke.mockClear();
    expect(await assetUrl("a1")).toBe("asset:///data/a1.webm");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("finish_of_an_empty_segment_is_null", async () => {
    const sink = await beginRecording(manifest);
    invoke.mockResolvedValueOnce(null);
    expect(await sink.finish(1)).toBeNull();
  });

  it("manifest_close_and_recovery_use_their_commands", async () => {
    await saveManifest(manifest);
    expect(invoke).toHaveBeenLastCalledWith("recording_save_manifest", { recId: "rec-1", manifest });
    await closeRecording("rec-1");
    expect(invoke).toHaveBeenLastCalledWith("recording_close", { recId: "rec-1" });
    invoke.mockResolvedValueOnce([{ recId: "rec-1", manifest, parts: [0] }]);
    expect(await unfinishedRecordings()).toEqual([{ recId: "rec-1", manifest, parts: [0] }]);
  });
});
