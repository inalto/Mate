import { afterEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ saveAsset: vi.fn(), saveAssetFromPath: vi.fn() }));
vi.mock("../../ipc/assets", () => ({ ...ipc, assetUrl: vi.fn(async () => null) }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("../../components/Toast", () => ({ showToast: toast }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { EditorStore } from "../../stores/editor";
import i18n from "../../i18n";
import { insertMediaFile, insertMediaFromPath, isMediaPath, MAX_MEDIA_BYTES, mediaKindOf, titleOf } from "../insert";

const fakeStore = () => {
  const addMedia = vi.fn(() => "new-id");
  return { store: { getState: () => ({ addMedia }) } as unknown as EditorStore, addMedia };
};

afterEach(() => vi.clearAllMocks());

describe("media insertion", () => {
  it("recognises the six media extensions", () => {
    for (const p of ["a.mp3", "B.M4A", "c.wav", "d.ogg", "C:\\x\\e.mp4", "/x/f.webm"]) expect(isMediaPath(p), p).toBe(true);
    for (const p of ["a.png", "a.pdf", "mp3", "dir.mp3/file"]) expect(isMediaPath(p), p).toBe(false);
  });

  it("picks the player kind by extension first, then by sniffed MIME", () => {
    expect(mediaKindOf("video/mp4", "talk.m4a")).toBe("audio");
    expect(mediaKindOf("video/mp4", "clip.mp4")).toBe("video");
    expect(mediaKindOf("audio/mpeg")).toBe("audio");
    expect(mediaKindOf("video/webm", "noext")).toBe("video");
    expect(mediaKindOf("image/png", "x.mp3")).toBeNull();
    expect(titleOf("C:\\Music\\Lecture 1.mp3")).toBe("Lecture 1");
  });

  it("insertMediaFromPath stores the file and adds a player titled after it", async () => {
    ipc.saveAssetFromPath.mockResolvedValue({ id: "a1", path: "p", mime: "audio/mpeg", bytes: 10 });
    const { store, addMedia } = fakeStore();
    expect(await insertMediaFromPath(store, "/m/Song.mp3", { x: 1, y: 2 })).toBe("new-id");
    expect(addMedia).toHaveBeenCalledWith("a1", "audio", undefined, { x: 1, y: 2 }, "Song");
  });

  it("a file over the cap shows the size toast", async () => {
    ipc.saveAssetFromPath.mockRejectedValue("asset is 300000000 bytes (max 268435456)");
    const { store, addMedia } = fakeStore();
    expect(await insertMediaFromPath(store, "/m/big.mp4")).toBeNull();
    expect(addMedia).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(i18n.t("media.tooLarge", { max: 256 }));

    const big = new File([new Uint8Array(1)], "big.mp4", { type: "video/mp4" });
    Object.defineProperty(big, "size", { value: MAX_MEDIA_BYTES + 1 });
    expect(await insertMediaFile(store, big)).toBeNull();
    expect(ipc.saveAsset).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it("content that is not media is refused with the insert-failed toast", async () => {
    ipc.saveAssetFromPath.mockResolvedValue({ id: "a2", path: "p", mime: "image/png", bytes: 10 });
    const { store, addMedia } = fakeStore();
    expect(await insertMediaFromPath(store, "/m/fake.mp3")).toBeNull();
    expect(addMedia).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(i18n.t("media.insertFailed"));
  });
});
