// Ink palettes, width slider scale and colour conversions shared by the toolbar menus.
export const PEN_PALETTE = ["#000000", "#C62828", "#E65100", "#C9A227", "#1B8E3E", "#1565C0", "#4527A0", "#AD1457"];
export const HIGHLIGHTER_PALETTE = ["#E9D5FF", "#FDE047", "#86EFAC", "#93C5FD", "#FCA5A5", "#D4A373"];
/** Screen px per world unit for width sliders. */
export const PX_PER_UNIT = 2.5;
const HEX = /^#?([0-9a-f]{6})$/i;

export const widthPx = (units: number) => Math.round(units * PX_PER_UNIT * 2) / 2;

export function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`.toUpperCase();
}

export function hueOf(hex: string): number {
  const m = HEX.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}
