import type { ThemeName } from "./types";

/** Light-paper ink → dark-paper ink (spec 03 §4). Stored colours are always the light variant. */
const DARK_INK: Record<string, string> = {
  "#000000": "#FFFFFF",
  "#434343": "#D4D4D4",
  "#666666": "#A0A0A0",
  "#999999": "#737373",
  "#C62828": "#FF3B3B",
  "#E65100": "#FF9F40",
  "#C9A227": "#FFD84D",
  "#7FB800": "#C3FF00",
  "#1B8E3E": "#6DFF8B",
  "#00897B": "#00FFCC",
  "#0277BD": "#4FD1FF",
  "#039BE5": "#A8F0FF",
  "#1565C0": "#6AA9FF",
  "#4527A0": "#7B61FF",
  "#6A1B9A": "#B28CFF",
  "#AD1457": "#FF4DFF",
};

const HEX6 = /^#[0-9a-f]{6}$/i;

export function isDarkTheme(theme: ThemeName): boolean {
  return theme === "dark" || theme === "high-contrast";
}

/** Remap an ink colour for display. Identity for light/sepia; non-hex strings pass through. */
export function mapInkColor(hex: string, theme: ThemeName): string {
  if (!isDarkTheme(theme) || !HEX6.test(hex)) return hex;
  const key = hex.toUpperCase();
  const mapped = DARK_INK[key];
  if (mapped) return mapped;
  const r = parseInt(key.slice(1, 3), 16);
  const g = parseInt(key.slice(3, 5), 16);
  const b = parseInt(key.slice(5, 7), 16);
  if (r < 40 && g < 40 && b < 40) return "#FFFFFF";
  if (r > 215 && g > 215 && b > 215) return "#000000";
  return hex;
}
