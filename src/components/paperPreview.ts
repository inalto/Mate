// Preview tile for the Paper picker: a small sheet drawn with the same generator as the canvas,
// thumbnails and exports, scaled to a 96×128 tile.
import { buildBackgroundPattern, type Dot, type Line } from "../canvas/background";
import type { BackgroundConfig } from "../model/types";
import type { ThemeName } from "../ink/types";

export const PREVIEW_WIDTH = 96;
export const PREVIEW_HEIGHT = 128;
/** World area shown in a tile: a 3:4 sheet at a zoom where the usual spacings stay legible. */
const SHEET_WIDTH = 360;
const SHEET_HEIGHT = 480;
const SCALE = PREVIEW_WIDTH / SHEET_WIDTH;

export interface PaperPreview {
  width: number;
  height: number;
  lines: Line[];
  dots: Dot[];
}

/** Lines and dots of `cfg` on a preview sheet, in tile pixels. */
export function paperPreview(cfg: BackgroundConfig, theme: ThemeName): PaperPreview {
  const sheet = { x: 0, y: 0, width: SHEET_WIDTH, height: SHEET_HEIGHT };
  const { lines, dots } = buildBackgroundPattern(cfg, sheet, { mode: "page", width: SHEET_WIDTH, height: SHEET_HEIGHT, count: 1 }, theme);
  return {
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    lines: lines.map((l) => ({
      ...l,
      x1: l.x1 * SCALE,
      y1: l.y1 * SCALE,
      x2: l.x2 * SCALE,
      y2: l.y2 * SCALE,
      width: Math.max(0.5, l.width * SCALE * 2),
    })),
    dots: dots.map((d) => ({ ...d, x: d.x * SCALE, y: d.y * SCALE, r: Math.max(0.6, d.r * SCALE) })),
  };
}
