// Shared types for the ink geometry module (no React here).
import type { StrokeOptions } from "perfect-freehand";
import type { Element, PenStyle, Point, Theme } from "../model/types";

export type { Element, PenStyle, Point, StrokeOptions };

/** App theme name; `dark` and `high-contrast` are the dark-ish themes. */
export type ThemeName = Theme;

/** Raw pointer sample before normalisation. */
export interface RawPoint {
  x: number;
  y: number;
  pressure?: number;
  timestamp: number;
  tiltX?: number;
  tiltY?: number;
}

/** A streamlined stroke sample: centre plus radius, in world units. */
export interface Disc {
  x: number;
  y: number;
  r: number;
}

/** A near-constant-width polyline: `xy` is interleaved `[x0, y0, x1, y1, …]`, `width` = rmin + rmax. */
export interface Run {
  width: number;
  xy: Float64Array;
}

/** perfect-freehand options plus Mate-specific render flags. */
export type PenRenderParams = StrokeOptions & {
  resampleTolerance?: number;
  /** true → outline-fill path (fountain-pen, highlighter); false → capsule runs (pen, pencil). */
  outline: boolean;
};
