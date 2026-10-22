// A new image element: `points[0]` is the top-left anchor, `imageUrl` the asset id.
import type { Rect } from "../canvas/background";
import type { Element } from "../model/types";

export function imageElement(pageId: string, id: string, now: string, assetId: string, box: Rect): Element {
  return {
    id,
    pageId,
    type: "image",
    points: [{ x: box.x, y: box.y, pressure: 0.5, timestamp: 0 }],
    color: "#000000",
    width: box.width,
    height: box.height,
    isHighlighter: false,
    imageUrl: assetId,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}
