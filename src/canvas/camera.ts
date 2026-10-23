// Camera maths (spec 03 §4): screen = world·z + (x, y). Pure; no DOM.
import {
  ASPECT_PRESET_HEIGHTS,
  PAGE_GAP,
  PAGE_MODE_BOTTOM_MARGIN,
  PAGE_MODE_SIDE_MARGIN,
  PAGE_MODE_TOP_MARGIN,
  PAGE_WIDTH,
} from "../model/constants";
import type { AspectPreset, Page } from "../model/types";

export interface Camera {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Sheet size and count for page mode (count only matters for the vertical bound). */
export interface SheetStack {
  width: number;
  height: number;
  count: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 10;
/** Horizontal room beyond the side margin in page mode (doc 01 §6). */
export const PAGE_MODE_SIDE_OVERSHOOT = 1080;

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function worldToScreen(c: Camera, p: Vec2): Vec2 {
  return { x: p.x * c.z + c.x, y: p.y * c.z + c.y };
}

export function screenToWorld(c: Camera, p: Vec2): Vec2 {
  return { x: (p.x - c.x) / c.z, y: (p.y - c.y) / c.z };
}

/** Zoom to `newZ` (clamped to 0.1..10) keeping the world point under `focusScreen` fixed. */
export function zoomAt(c: Camera, focusScreen: Vec2, newZ: number): Camera {
  const z = clampZoom(newZ);
  const w = screenToWorld(c, focusScreen);
  return { x: focusScreen.x - w.x * z, y: focusScreen.y - w.y * z, z };
}

export function panBy(c: Camera, dx: number, dy: number): Camera {
  return { x: c.x + dx, y: c.y + dy, z: c.z };
}

/** Ctrl+wheel zoom multiplier. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY / 100);
}

/** Sheet width/height for a page-mode page: stored size, else the default aspect preset (portrait). */
export function sheetSize(page: Page, defaultAspect: string = "a4"): { width: number; height: number } {
  const preset = (defaultAspect in ASPECT_PRESET_HEIGHTS ? defaultAspect : "a4") as AspectPreset;
  return {
    width: page.pageWidth ?? PAGE_WIDTH,
    height: page.pageHeight ?? ASPECT_PRESET_HEIGHTS[preset],
  };
}

/**
 * Sheet size for an aspect preset and orientation (settings.defaultPageAspectRatio /
 * defaultPageOrientation): the long side is the preset height, landscape swaps the sides
 * (a square stays square). Unknown presets fall back to A4.
 */
export function sheetSizeFor(aspect: string, orientation: string): { width: number; height: number } {
  const preset = (aspect in ASPECT_PRESET_HEIGHTS ? aspect : "a4") as AspectPreset;
  const long = ASPECT_PRESET_HEIGHTS[preset];
  const landscape = orientation === "landscape" && preset !== "square";
  return landscape ? { width: long, height: PAGE_WIDTH } : { width: PAGE_WIDTH, height: long };
}

/** Number of sheets: enough to hold content down to `contentBottom`, plus one blank sheet. */
export function sheetCountFor(contentBottom: number, sheetHeight: number): number {
  if (!(contentBottom > 0)) return 1;
  return Math.floor(contentBottom / (sheetHeight + PAGE_GAP)) + 2;
}

/** Bottom edge (world y) of the last sheet. */
export const stackBottom = (s: SheetStack): number =>
  s.count * (s.height + PAGE_GAP) - PAGE_GAP;

/** Clamp one axis so the visible world range [−off/z, (size−off)/z] stays within [min, max]. */
function clampAxis(off: number, z: number, size: number, min: number, max: number): number {
  const span = (max - min) * z;
  if (span <= size) return (size - span) / 2 - min * z; // content smaller than view: centre it
  return Math.min(-min * z, Math.max(size - max * z, off));
}

/**
 * Keep the camera in bounds. Canvas mode: cannot scroll above/left of the origin, unbounded
 * right/down. Page mode: x within −SIDE_MARGIN−SIDE_OVERSHOOT .. width+SIDE_MARGIN+SIDE_OVERSHOOT,
 * y within −TOP_MARGIN .. stackBottom+BOTTOM_MARGIN. `stack` defaults to one A4 sheet.
 */
export function clampCamera(c: Camera, page: Page, viewport: Viewport, stack?: SheetStack): Camera {
  const z = clampZoom(c.z);
  if (page.mode !== "page") {
    return { x: Math.min(c.x, 0), y: Math.min(c.y, 0), z };
  }
  const s = stack ?? { ...sheetSize(page), count: 1 };
  const side = PAGE_MODE_SIDE_MARGIN + PAGE_MODE_SIDE_OVERSHOOT;
  return {
    x: clampAxis(c.x, z, viewport.width, -side, s.width + side),
    y: clampAxis(c.y, z, viewport.height, -PAGE_MODE_TOP_MARGIN, stackBottom(s) + PAGE_MODE_BOTTOM_MARGIN),
    z,
  };
}

/** Starting camera: canvas mode at the origin; page mode with the first sheet centred at the top. */
export function initialCamera(page: Page, viewport: Viewport, stack?: SheetStack): Camera {
  if (page.mode !== "page") return { x: 0, y: 0, z: 1 };
  const s = stack ?? { ...sheetSize(page), count: 1 };
  const fit = viewport.width > 0 ? viewport.width / (s.width + 2 * PAGE_MODE_SIDE_MARGIN) : 1;
  const z = clampZoom(Math.min(1, fit));
  return { x: (viewport.width - s.width * z) / 2, y: PAGE_MODE_TOP_MARGIN * z, z };
}
