// Box frame geometry (pure): handle resizing and the CSS box of an element in the overlay layer.
import type { Rect } from "../tools/spatialIndex";

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
/** Smallest box side (page units) a resize can produce. */
export const MIN_BOX = 8;

/** `r` with the edges named by `handle` moved by (dx, dy); `keepAspect` preserves width/height. */
export function resizeBox(r: Rect, handle: Handle, dx: number, dy: number, keepAspect: boolean, min = MIN_BOX): Rect {
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  let x0 = r.x + (west ? dx : 0);
  let x1 = r.x + r.width + (east ? dx : 0);
  let y0 = r.y + (north ? dy : 0);
  let y1 = r.y + r.height + (south ? dy : 0);
  if (x1 - x0 < min) {
    if (west) x0 = x1 - min;
    else x1 = x0 + min;
  }
  if (y1 - y0 < min) {
    if (north) y0 = y1 - min;
    else y1 = y0 + min;
  }
  let w = x1 - x0;
  let h = y1 - y0;
  if (!keepAspect || r.width <= 0 || r.height <= 0) return { x: x0, y: y0, width: w, height: h };
  const horiz = west || east;
  const vert = north || south;
  if (horiz && !vert) h = (w * r.height) / r.width;
  else if (vert && !horiz) w = (h * r.width) / r.height;
  else {
    const k = Math.max(w / r.width, h / r.height);
    w = r.width * k;
    h = r.height * k;
  }
  return { x: west ? x1 - w : x0, y: north ? y1 - h : y0, width: w, height: h };
}

export const boxStyle = (r: Rect, rotation: number) => ({
  left: `${r.x}px`,
  top: `${r.y}px`,
  width: `${r.width}px`,
  height: `${r.height}px`,
  transform: rotation ? `rotate(${rotation}rad)` : undefined,
});
