// A new media element (audio or video player): `points[0]` is the top-left anchor, `width/height`
// the box (as for images), `imageUrl` the asset id (so the asset GC and archives keep it).
import type { Rect } from "../canvas/background";
import type { MediaContent } from "../model/content";
import type { Element } from "../model/types";

export type MediaKind = MediaContent["kind"];

/** Default box (page units): a control strip for audio, 16:9 for video. */
export const MEDIA_DEFAULT_SIZE: Record<MediaKind, { width: number; height: number }> = {
  audio: { width: 320, height: 56 },
  video: { width: 480, height: 270 },
};

export function mediaElement(pageId: string, id: string, now: string, assetId: string, box: Rect, content: MediaContent): Element {
  return {
    id,
    pageId,
    type: "media",
    points: [{ x: box.x, y: box.y, pressure: 0.5, timestamp: 0 }],
    color: "#000000",
    width: box.width,
    height: box.height,
    isHighlighter: false,
    imageUrl: assetId,
    content: { ...content },
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}
