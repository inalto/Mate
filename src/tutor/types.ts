// Shared tutor types: segmented ink regions and the element change feed.
import type { Rect } from "../tools/spatialIndex";

export type RegionType = "math" | "text";

/** A group of stroke elements recognised together. */
export interface Region {
  /** Stable hash of the sorted element ids: the same membership yields the same id. */
  regionId: string;
  /** Always "math" for now; "text" detection comes later. */
  type: RegionType;
  /** Member element ids, sorted. */
  elementIds: string[];
  bounds: Rect;
  /** Bottom of the bounds. */
  baselineY: number;
}

/** One batch of element mutations (emitted by the editor store). */
export interface ElementsChange {
  added: string[];
  updated: string[];
  removed: string[];
}

export type FireReason = "settle" | "watchdog" | "early";
