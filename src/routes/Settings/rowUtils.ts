/** Trailing quiet period before a slider/colour drag is written to settings. */
export const ROW_WRITE_DEBOUNCE_MS = 250;

/** `<input type="color">` only takes #rrggbb; anything else (e.g. "transparent") shows `fallback`. */
export const hexOr = (c: string, fallback: string): string =>
  /^#[0-9a-f]{6}$/i.test(c) ? c : fallback;
