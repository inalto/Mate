import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { useEffect, useState } from "react";

/** Write `<app_data_dir>/thumbnails/<pageId>.webp` and bump the page's thumbnail version. */
export const saveThumbnail = (pageId: string, bytes: Uint8Array): Promise<string> =>
  invoke("save_thumbnail", { pageId, bytes: Array.from(bytes) });

let thumbDir: Promise<string> | null = null;
let resolvedDir: string | null = null;

/** Resolve the thumbnails directory once; `thumbnailUrl` works after this settles. */
export function initThumbnails(): Promise<void> {
  thumbDir ??= appDataDir().then((d) => join(d, "thumbnails")).then((d) => (resolvedDir = d));
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
