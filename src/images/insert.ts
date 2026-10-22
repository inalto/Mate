// Inserting images into the focused page: from the file dialog, a stored asset, or a dropped path.
// Bytes stay in Rust (`save_asset_from_path`); this module only decodes for the natural size.
import { open } from "@tauri-apps/plugin-dialog";
import type { Vec2 } from "../canvas/camera";
import { showToast } from "../components/Toast";
import { saveAssetFromPath, type AssetInfo } from "../ipc/assets";
import type { EditorStore } from "../stores/editor";
import { getFocusedEditor } from "../stores/focusedEditor";
import { loadImage, naturalSize } from "./load";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "svg"] as const;

export const isImagePath = (path: string): boolean => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
};

export const INSERT_FAILED = "Could not insert that image.";

/** Add stored asset `info` to `store`'s page (one history entry); the new element's id, or null. */
export async function insertAsset(store: EditorStore, info: AssetInfo, at?: Vec2): Promise<string | null> {
  if (!info.mime.startsWith("image/")) return null;
  const img = await loadImage(info.id);
  if (!img) {
    showToast(INSERT_FAILED);
    return null;
  }
  return store.getState().addImage(info.id, naturalSize(img), at);
}

/** Store the file at `path` and insert it; failures show a toast. */
export async function insertImageFromPath(store: EditorStore, path: string, at?: Vec2): Promise<string | null> {
  try {
    return await insertAsset(store, await saveAssetFromPath(path), at);
  } catch {
    showToast(INSERT_FAILED);
    return null;
  }
}

/** Toolbar "Insert image": pick a file and insert it into the focused page. */
export async function pickAndInsertImage(): Promise<void> {
  const picked = await open({
    multiple: false,
    filters: [{ name: "Images", extensions: [...IMAGE_EXTENSIONS] }],
  });
  if (typeof picked !== "string") return;
  await insertImageFromPath(getFocusedEditor(), picked);
}
