// Placement of a newly inserted image: natural size (1 image px = 1 page unit), scaled down to fit
// 80 % of the visible viewport when larger (aspect kept, never upscaled), centred on the viewport
// centre or on a drop point.
import type { Rect } from "../canvas/background";

export const FIT_FRACTION = 0.8;
/** Size assumed for images that report no intrinsic size (some SVGs). */
export const FALLBACK_SIZE = 256;

export function fitImage(
  natural: { width: number; height: number },
  viewport: Rect,
  at?: { x: number; y: number },
): Rect {
  const nw = natural.width > 0 ? natural.width : FALLBACK_SIZE;
  const nh = natural.height > 0 ? natural.height : FALLBACK_SIZE;
  const k = Math.min(1, (viewport.width * FIT_FRACTION) / nw, (viewport.height * FIT_FRACTION) / nh);
  const width = nw * k;
  const height = nh * k;
  const cx = at?.x ?? viewport.x + viewport.width / 2;
  const cy = at?.y ?? viewport.y + viewport.height / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}
