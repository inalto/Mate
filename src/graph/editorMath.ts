// Pure maths of the graph editor: the view after a pinch.
import { zoomDomain, type GraphDomain } from "./data";

/**
 * The view after a two-finger gesture that started on `start`: the fingers were `d0` apart about
 * the box fraction (fx0, fy0) and are now `d1` apart about (fx1, fy1). The point under the fingers
 * stays under them.
 */
export function pinchDomain(start: GraphDomain, d0: number, d1: number, fx0: number, fy0: number, fx1: number, fy1: number): GraphDomain {
  if (!(d0 > 0) || !(d1 > 0)) return start;
  const ax = start.xMin + fx0 * (start.xMax - start.xMin);
  const ay = start.yMax - fy0 * (start.yMax - start.yMin);
  const z = zoomDomain(start, d0 / d1, ax, ay);
  const dx = (fx1 - fx0) * (z.xMax - z.xMin);
  const dy = (fy1 - fy0) * (z.yMax - z.yMin);
  return { xMin: z.xMin - dx, xMax: z.xMax - dx, yMin: z.yMin + dy, yMax: z.yMax + dy };
}
