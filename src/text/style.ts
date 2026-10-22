// Text-box typography shared by the DOM editor, the bitmap snapshot and SVG export: font stacks,
// line height, defaults and the CSS of a box's content (one source, so all three look the same).
import type { TextAttributes } from "../model/content";

export type FontKey = "sans" | "serif" | "mono" | "hand" | "script";

export const FONT_STACKS: Record<FontKey, string> = {
  sans: '"IBM Plex Sans", system-ui, "Segoe UI", sans-serif',
  serif: '"STIX Two Text", Georgia, serif',
  mono: '"JetBrains Mono", Consolas, monospace',
  hand: '"Patrick Hand", "Comic Sans MS", cursive',
  script: 'Caveat, "Segoe Script", cursive',
};

export const FONT_LABELS: Record<FontKey, string> = {
  sans: "Sans",
  serif: "Serif",
  mono: "Mono",
  hand: "Hand",
  script: "Script",
};

export const FONT_KEYS = Object.keys(FONT_STACKS) as FontKey[];

/** Line height as a multiple of the font size. */
export const LINE_HEIGHT = 1.5;
/** Width (page units) of a new text box. */
export const DEFAULT_BOX_WIDTH = 320;
/** Font sizes (page units) the size −/+ buttons step through. */
export const FONT_SIZES = [12, 14, 16, 18, 21.77, 24, 28, 32, 40, 48, 64, 80];

/** Font stack for a family key; unknown keys (or raw stacks) fall back to the sans stack. */
export const fontStack = (family: string): string => FONT_STACKS[family as FontKey] ?? FONT_STACKS.sans;

/** Next size in FONT_SIZES above (dir 1) or below (dir -1) `size`, clamped to the list. */
export function stepFontSize(size: number, dir: 1 | -1): number {
  if (dir > 0) return FONT_SIZES.find((s) => s > size + 0.01) ?? FONT_SIZES[FONT_SIZES.length - 1];
  return [...FONT_SIZES].reverse().find((s) => s < size - 0.01) ?? FONT_SIZES[0];
}

/** Box-level CSS declarations (page units as px) for `attrs`; `color` overrides the stored colour. */
export function boxCss(attrs: TextAttributes, color = attrs.color): Record<string, string> {
  return {
    "font-family": fontStack(attrs.fontFamily),
    "font-size": `${attrs.fontSize}px`,
    "line-height": String(LINE_HEIGHT),
    color,
    "text-align": attrs.align,
  };
}

export const cssText = (decls: Record<string, string>): string =>
  Object.entries(decls)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");

/** Class of a text box's content root (editor and snapshot). */
export const CONTENT_CLASS = "tb-content";

/** Rules for the content inside a box (margins of blocks, lists, headings). */
export const CONTENT_CSS = `
.${CONTENT_CLASS} { box-sizing: border-box; width: 100%; margin: 0; padding: 0; overflow-wrap: break-word; word-break: break-word; white-space: pre-wrap; outline: none; }
.${CONTENT_CLASS} p, .${CONTENT_CLASS} h1, .${CONTENT_CLASS} h2, .${CONTENT_CLASS} h3 { margin: 0; }
.${CONTENT_CLASS} h1 { font-size: 1.6em; font-weight: 600; }
.${CONTENT_CLASS} h2 { font-size: 1.35em; font-weight: 600; }
.${CONTENT_CLASS} h3 { font-size: 1.15em; font-weight: 600; }
.${CONTENT_CLASS} ul, .${CONTENT_CLASS} ol { margin: 0; padding-left: 1.4em; }
.${CONTENT_CLASS} li { margin: 0; }
`.trim();
