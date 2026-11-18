// Drag-to-reorder maths for the sidebar's page rows (pure; the row component does the pointer work).

/** Mouse movement (px) that picks a row up. */
export const MOUSE_DRAG_PX = 4;
/** How long a finger or pen must rest on a row before it is picked up (ms). */
export const TOUCH_HOLD_MS = 350;
/** Movement (px) during the hold that means "scrolling", not "picking up". */
export const TOUCH_HOLD_SLOP_PX = 8;

/** Insertion slot (0..n) for a pointer at `y`: before the first row whose middle is below it. */
export function slotAt(rows: readonly { top: number; height: number }[], y: number): number {
  const k = rows.findIndex((r) => y < r.top + r.height / 2);
  return k < 0 ? rows.length : k;
}

/** Final index of the row taken from `from` and dropped into insertion slot `slot`. */
export const dropIndex = (from: number, slot: number): number => (from < slot ? slot - 1 : slot);
