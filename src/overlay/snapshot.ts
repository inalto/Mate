// Bridge from DOM editors to the canvas: an editor publishes a bitmap of its rendered content for
// the element's current revision; the canvas, exports and thumbnails then draw that bitmap.
import type { Element } from "../model/types";
import { boxSnapshots, type BoxBitmap } from "../renderers/boxSnapshot";

/** Publish `bitmap` as the appearance of `el` at its current revision (`el.updatedAt`). */
export function publishBoxSnapshot(el: Pick<Element, "id" | "updatedAt">, bitmap: BoxBitmap): void {
  boxSnapshots.set(el.id, el.updatedAt, bitmap);
}

/** Drop the snapshot of element `id` (e.g. its editor failed to render); the placeholder returns. */
export function dropBoxSnapshot(id: string): void {
  boxSnapshots.invalidate(id);
}
