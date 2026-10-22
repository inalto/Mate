// Rasterised appearance of boxed elements (text boxes, tables, code, graphs), keyed by element id
// and revision (`el.updatedAt`). DOM editors publish a bitmap after each edit; the canvas, exports
// and thumbnails draw it. A snapshot of an older revision is never drawn.
import type { Element } from "../model/types";

export type BoxBitmap = ImageBitmap | HTMLCanvasElement;

interface Entry {
  revision: string;
  bitmap: BoxBitmap;
}

const release = (b: BoxBitmap) => {
  if ("close" in b && typeof b.close === "function") b.close();
};

export class BoxSnapshotCache {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(id: string) => void>();

  /** Snapshot of `el` at its current revision, else null. */
  get(el: Pick<Element, "id" | "updatedAt">): BoxBitmap | null {
    const e = this.entries.get(el.id);
    return e && e.revision === el.updatedAt ? e.bitmap : null;
  }

  set(id: string, revision: string, bitmap: BoxBitmap): void {
    const old = this.entries.get(id);
    if (old && old.bitmap !== bitmap) release(old.bitmap);
    this.entries.set(id, { revision, bitmap });
    this.emit(id);
  }

  invalidate(id: string): void {
    const old = this.entries.get(id);
    if (!old) return;
    release(old.bitmap);
    this.entries.delete(id);
    this.emit(id);
  }

  clear(): void {
    for (const id of [...this.entries.keys()]) this.invalidate(id);
  }

  /** Called with the id whenever a snapshot is set or dropped; returns an unsubscribe function. */
  subscribe(fn: (id: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(id: string): void {
    for (const fn of this.listeners) fn(id);
  }
}

/** The app-wide snapshot cache (shared by both panes, exports and thumbnails). */
export const boxSnapshots = new BoxSnapshotCache();
