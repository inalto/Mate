// Inserting audio and video into the focused page: from the file dialog, a dropped path or a pasted
// file. Bytes stay in Rust where possible (`save_asset_from_path`); Rust sniffs the content and
// enforces the size cap, this module only picks the player kind and the default box.
import { open } from "@tauri-apps/plugin-dialog";
import type { Vec2 } from "../canvas/camera";
import { showToast } from "../components/Toast";
import i18n from "../i18n";
import { saveAsset, saveAssetFromPath, type AssetInfo } from "../ipc/assets";
import type { EditorStore } from "../stores/editor";
import { getFocusedEditor } from "../stores/focusedEditor";
import type { MediaKind } from "./element";

export const MEDIA_EXTENSIONS = ["mp3", "m4a", "wav", "ogg", "mp4", "webm"] as const;
/** Largest media file accepted (mirrors `assets::MAX_MEDIA_BYTES`). */
export const MAX_MEDIA_BYTES = 256 * 1024 * 1024;

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "ogg"]);

const extOf = (path: string): string => {
  const name = path.split(/[\\/]/).pop() ?? "";
  return name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";
};

export const isMediaPath = (path: string): boolean => (MEDIA_EXTENSIONS as readonly string[]).includes(extOf(path));

/** True for an audio or video MIME type. */
export const isMediaMime = (mime: string): boolean => mime.startsWith("audio/") || mime.startsWith("video/");

/**
 * Player kind for a stored asset: the file extension wins when known (an `.m4a` may sniff as
 * `video/mp4`, both being ISO BMFF), else the sniffed MIME type; null when it is not media.
 */
export function mediaKindOf(mime: string, name?: string): MediaKind | null {
  if (!isMediaMime(mime)) return null;
  const ext = name ? extOf(name) : "";
  if (ext && isMediaPath(name ?? "")) return AUDIO_EXTENSIONS.has(ext) ? "audio" : "video";
  return mime.startsWith("audio/") ? "audio" : "video";
}

/** File name without folders and extension (the player's title). */
export const titleOf = (path: string): string => (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "");

export const mediaInsertFailed = (): string => i18n.t("media.insertFailed");
export const mediaTooLarge = (): string => i18n.t("media.tooLarge", { max: MAX_MEDIA_BYTES / (1024 * 1024) });

/** Rust's size refusal ("asset is N bytes (max M)"). */
const isTooLarge = (err: unknown): boolean => /\(max \d+\)/.test(String(err));

const failed = (err: unknown): null => {
  showToast(isTooLarge(err) ? mediaTooLarge() : mediaInsertFailed());
  return null;
};

/** Add stored media asset `info` to `store`'s page (one history entry); the new element's id, or null. */
export function insertMediaAsset(store: EditorStore, info: AssetInfo, at?: Vec2, name?: string): string | null {
  const kind = mediaKindOf(info.mime, name);
  if (!kind) return failed(null);
  return store.getState().addMedia(info.id, kind, undefined, at, name ? titleOf(name) || undefined : undefined);
}

/** Store the file at `path` and insert it; failures (too large, not media) show a toast. */
export async function insertMediaFromPath(store: EditorStore, path: string, at?: Vec2): Promise<string | null> {
  try {
    return insertMediaAsset(store, await saveAssetFromPath(path), at, path);
  } catch (err) {
    return failed(err);
  }
}

/** Store a pasted / dropped media `file` (checked against the cap first) and insert it. */
export async function insertMediaFile(store: EditorStore, file: File, at?: Vec2): Promise<string | null> {
  if (file.size > MAX_MEDIA_BYTES) {
    showToast(mediaTooLarge());
    return null;
  }
  try {
    const info = await saveAsset(new Uint8Array(await file.arrayBuffer()), file.type);
    return insertMediaAsset(store, info, at, file.name);
  } catch (err) {
    return failed(err);
  }
}

/** Toolbar "Insert media": pick an audio or video file and insert it into the focused page. */
export async function pickAndInsertMedia(): Promise<void> {
  const picked = await open({
    multiple: false,
    filters: [{ name: i18n.t("media.filter"), extensions: [...MEDIA_EXTENSIONS] }],
  });
  if (typeof picked !== "string") return;
  await insertMediaFromPath(getFocusedEditor(), picked);
}
