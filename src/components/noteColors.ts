// Sticky-note card colours: eight swatches, each with a light-paper and a dark-paper variant.
// A card stores the swatch id; `noteBackground` resolves it for the paint's theme.
import { isDarkTheme } from "../ink/theme";
import type { ThemeName } from "../ink/types";
import type { CardStyle } from "../model/content";

export interface NoteSwatch {
  id: string;
  light: string;
  dark: string;
}

export const NOTE_SWATCHES: readonly NoteSwatch[] = [
  { id: "yellow", light: "#FDE68A", dark: "#8A6D0B" },
  { id: "orange", light: "#FDBA74", dark: "#9A4A12" },
  { id: "pink", light: "#F9A8D4", dark: "#9D2A66" },
  { id: "green", light: "#A7F3D0", dark: "#1F7A52" },
  { id: "blue", light: "#93C5FD", dark: "#1F5AA6" },
  { id: "purple", light: "#C4B5FD", dark: "#5B3FB0" },
  { id: "grey", light: "#D4D4D8", dark: "#52525B" },
  { id: "white", light: "#FFFFFF", dark: "#3F3F46" },
];

export const DEFAULT_NOTE_COLOR = "yellow";

/** The swatch with this id, else undefined. */
export const swatchOf = (id: string): NoteSwatch | undefined => NOTE_SWATCHES.find((s) => s.id === id);

/** CSS colour of a card background: a swatch id resolves per theme (dark variant on every dark theme, high-contrast included); "#..." (or any other value) is used as stored. */
export function noteBackground(id: string, theme: ThemeName): string {
  const s = swatchOf(id);
  if (s) return isDarkTheme(theme) ? s.dark : s.light;
  return id;
}

/** Card style of a new sticky note: swatch `color` (default yellow; an unknown id reads as yellow), radius 8, soft shadow, no border. */
export const noteCard = (color: string = DEFAULT_NOTE_COLOR): CardStyle => ({
  background: (swatchOf(color) || color.startsWith("#")) ? color : DEFAULT_NOTE_COLOR,
  radius: 8,
  shadow: "soft",
  border: false,
});
