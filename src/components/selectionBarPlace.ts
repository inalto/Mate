// Where the selection bar goes (pane px): centred above the selection, below it when there is no
// room above, never over the selection's rotate knob or move handle, and always whole inside the
// pane, however the selection sits or scrolls.
export const BAR_GAP = 12;
export const BAR_HEIGHT = 44;
/** Space kept free at the pane's edges. */
export const BAR_EDGE = 8;
/** Width assumed until the bar is measured. */
const BAR_WIDTH = 440;

export interface BarPlace {
  /** Horizontal centre of the bar (it is translated by −50%). */
  left: number;
  top: number;
}

/** How far past the selection's top and bottom its handles reach (screen px; `barClearance`). */
export interface BarClearance {
  above: number;
  below: number;
}

/** Space kept between the bar and a handle it clears. */
const HANDLE_GAP = 4;

/**
 * `sel` is the selection's box on screen, `view` the pane, `bar` the bar's measured size (0 when
 * not measured yet), `clear` how far the rotate knob and the move handle reach past the selection:
 * the bar keeps clear of them, so they stay usable. A bar wider than the pane is centred (CSS
 * wraps it to the pane's width).
 */
export function placeSelectionBar(
  sel: { x: number; y: number; width: number; height: number },
  view: { width: number; height: number },
  bar: { width: number; height: number } = { width: 0, height: 0 },
  clear: BarClearance = { above: 0, below: 0 },
): BarPlace {
  const bw = bar.width > 0 ? bar.width : BAR_WIDTH;
  const bh = bar.height > 0 ? bar.height : BAR_HEIGHT;
  const half = Math.min(bw / 2 + BAR_EDGE, view.width / 2);
  const left = Math.max(half, Math.min(view.width - half, sel.x + sel.width / 2));
  const gap = (reach: number) => (reach > 0 ? Math.max(BAR_GAP, reach + HANDLE_GAP) : BAR_GAP);
  let top = sel.y - gap(clear.above) - bh;
  if (top < BAR_EDGE) top = sel.y + sel.height + gap(clear.below);
  // A selection taller than the pane, or scrolled out of it: the bar stays at the nearest edge.
  top = Math.max(BAR_EDGE, Math.min(top, view.height - bh - BAR_GAP));
  return { left, top };
}
