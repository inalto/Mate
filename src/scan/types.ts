// Shared types of the photo-scan maths. Pure data so every function in src/scan can be tested
// without a canvas; the browser-facing I/O lives in pixels.ts.

export interface Point {
  x: number;
  y: number;
}

/** Corners in the order [topLeft, topRight, bottomRight, bottomLeft], in source-image pixels. */
export type Quad = [Point, Point, Point, Point];

/** RGBA, 4 bytes per pixel, row-major. */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** 3x3 matrix, row-major. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export type ScanMode = "colour" | "grey" | "bw";
