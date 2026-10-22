// Asset store client. Binary data stays in Rust: bytes go in through `saveAsset` (pasted data) or
// `saveAssetFromPath` (picked/dropped files); elements persist only the asset id. The webview
// shows an asset through its `asset:` URL, resolved from the file path via an id→path cache.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { elementsQueue } from "./elementsQueue";

export interface AssetInfo {
  id: string;
  /** Absolute path of the stored file. */
  path: string;
  mime: string;
  bytes: number;
}

const paths = new Map<string, string>();

const remember = (info: AssetInfo): AssetInfo => {
  paths.set(info.id, info.path);
  return info;
};

/** Store `bytes` (sent as the raw request body); the type is sniffed in Rust. */
export const saveAsset = (bytes: Uint8Array, hint?: string): Promise<AssetInfo> =>
  invoke<AssetInfo>("save_asset", bytes, hint ? { headers: { "x-asset-kind-hint": hint } } : undefined).then(remember);

/** Store a file from disk (dialog pick or drop) without its bytes crossing IPC. */
export const saveAssetFromPath = (path: string): Promise<AssetInfo> =>
  invoke<AssetInfo>("save_asset_from_path", { path }).then(remember);

export const assetInfo = (id: string): Promise<AssetInfo | null> =>
  invoke<AssetInfo | null>("asset_info", { id }).then((i) => (i ? remember(i) : null));

export const deleteAsset = (id: string): Promise<boolean> => {
  paths.delete(id);
  return invoke<boolean>("delete_asset", { id });
};

/** Remove assets no element references; resolves to how many were removed. */
export const gcAssets = async (): Promise<number> => {
  await elementsQueue.flushAll(); // pending inserts must reach the database before references are read
  return invoke<number>("gc_assets");
};

/** The stored file's bytes. */
export const readAsset = async (id: string): Promise<Uint8Array> =>
  new Uint8Array(await invoke<ArrayBuffer>("read_asset", { id }));

/** `asset:` URL of a stored asset, or null when it does not exist. */
export async function assetUrl(id: string): Promise<string | null> {
  let path = paths.get(id);
  if (!path) path = (await assetInfo(id))?.path;
  return path ? convertFileSrc(path) : null;
}
