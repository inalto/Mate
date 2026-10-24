import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export interface ThumbnailSaved {
  path: string;
  /** The page's thumbnail version after the bump. */
  version: number;
}

/** Write `<app_data_dir>/thumbnails/<pageId>.webp` and bump the page's thumbnail version. */
export const saveThumbnail = (pageId: string, bytes: Uint8Array): Promise<ThumbnailSaved> =>
  invoke("save_thumbnail", { pageId, bytes: Array.from(bytes) });

let thumbDir: Promise<string> | null = null;
let resolvedDir: string | null = null;

/** Resolve the thumbnails directory once (Rust knows the data dir in use); `thumbnailUrl` works after this settles. */
export function initThumbnails(): Promise<void> {
  thumbDir ??= invoke<string>("thumbnails_dir").then((d) => (resolvedDir = d));
  return thumbDir.then(() => undefined);
}

/** True once `thumbnailUrl` can produce URLs (never, outside the Tauri shell). */
export function useThumbnailsReady(): boolean {
  const [ready, setReady] = useState(resolvedDir !== null);
  useEffect(() => {
    if (ready) return;
    let live = true;
    initThumbnails().then(() => live && setReady(true), () => {});
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
}

/** `asset:` URL of a page thumbnail; `version` is a cache-buster. Empty until `initThumbnails` resolves. */
export function thumbnailUrl(pageId: string, version: number): string {
  if (resolvedDir === null) return "";
  const sep = resolvedDir.includes("\\") ? "\\" : "/";
  return `${convertFileSrc(`${resolvedDir}${sep}${pageId}.webp`)}?v=${version}`;
}
