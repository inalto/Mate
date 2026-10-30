// Mind-map styles (pure, spec D3): what each node and edge is painted with, as plain objects so
// the renderer only draws. Colours are stored as light-paper variants and mapped per theme.
import { isDarkTheme, mapInkColor } from "../ink/theme";
import type { ThemeName } from "../ink/types";
import type { NodeBox } from "./layout";

export type MindmapStyle = 1 | 2 | 3 | 4;

export interface MindmapStyleDef {
  name: "outline" | "filled" | "minimal" | "soft";
  /** Root node shape: a pill (radius = half height) or a rounded rect with the style radius. */
  rootShape: "pill" | "rounded";
  /** Corner radius of non-root nodes. */
  radius: number;
  edgeWidth: number;
  edgeDash?: number[];
}

export const MINDMAP_STYLES: Record<MindmapStyle, MindmapStyleDef> = {
  1: { name: "outline", rootShape: "pill", radius: 8, edgeWidth: 2 },
  2: { name: "filled", rootShape: "rounded", radius: 8, edgeWidth: 3 },
  3: { name: "minimal", rootShape: "pill", radius: 0, edgeWidth: 1 },
  4: { name: "soft", rootShape: "pill", radius: 16, edgeWidth: 2, edgeDash: [6, 4] },
};

/** First-level branch colours (light-paper inks, cycled by branch index). */
export const BRANCH_PALETTE: readonly string[] = ["#C62828", "#E65100", "#1B8E3E", "#0277BD", "#4527A0", "#AD1457"];

/** Neutral ink of the root and of the minimal style's edges. */
const ROOT_INK = "#434343";
const EDGE_GREY = "#999999";

const SURFACE: Record<ThemeName, { paper: string; ink: string }> = {
  light: { paper: "#ffffff", ink: "#000000" },
  sepia: { paper: "#f7efdb", ink: "#5b4a33" },
  dark: { paper: "#18181b", ink: "#ffffff" },
  "high-contrast": { paper: "#000000", ink: "#ffffff" },
};
const surface = (theme: ThemeName) => SURFACE[theme] ?? SURFACE.light;

const HEX6 = /^#[0-9a-f]{6}$/i;

/** `a` mixed towards `b` by `t` (0 to 1); both `#rrggbb`. */
function mix(a: string, b: string, t: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  const out = [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export interface NodePaint {
  /** `"transparent"` for no fill. */
  fill: string;
  stroke: string;
  /** 0 for no outline. */
  strokeWidth: number;
  text: string;
  radius: number;
  dash?: number[];
  /** Minimal style: draw only a line under the box (in `stroke`, `strokeWidth`). */
  underline?: boolean;
}

export interface EdgePaint {
  stroke: string;
  strokeWidth: number;
  dash?: number[];
}

/** Light-paper colour of a branch: a valid `override`, else the palette (neutral for the root). */
export function branchColor(branch: number, override?: string): string {
  if (override && HEX6.test(override)) return override;
  if (branch < 0) return ROOT_INK;
  return BRANCH_PALETTE[branch % BRANCH_PALETTE.length];
}

const def = (style: MindmapStyle): MindmapStyleDef => MINDMAP_STYLES[style] ?? MINDMAP_STYLES[1];

export function nodePaint(
  style: MindmapStyle,
  box: Pick<NodeBox, "depth" | "branch" | "height">,
  theme: ThemeName,
  override?: string,
): NodePaint {
  const d = def(style);
  const { paper, ink } = surface(theme);
  const isRoot = box.depth === 0;
  const colour = mapInkColor(branchColor(box.branch, override), theme);
  const radius = isRoot ? (d.rootShape === "pill" ? box.height / 2 : d.radius) : d.radius;
  switch (d.name) {
    case "filled":
      return {
        fill: colour,
        stroke: colour,
        strokeWidth: 0,
        text: isDarkTheme(theme) ? "#000000" : "#ffffff",
        radius,
      };
    case "minimal":
      // Text only with an underline (the root too: it differs by its bold, larger text).
      return { fill: "transparent", stroke: colour, strokeWidth: 2, text: ink, radius, underline: true };
    case "soft":
      return { fill: mix(colour, paper, isDarkTheme(theme) ? 0.65 : 0.78), stroke: colour, strokeWidth: 0, text: ink, radius };
    default:
      return { fill: paper, stroke: colour, strokeWidth: 2, text: ink, radius };
  }
}

/** `#000000` or `#ffffff`, whichever reads better on `#rrggbb` `bg` (WCAG relative luminance). */
export function contrastText(bg: string): string {
  if (!HEX6.test(bg)) return "#ffffff";
  const lin = (i: number) => {
    const c = parseInt(bg.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(0) + 0.7152 * lin(1) + 0.0722 * lin(2);
  // Contrast against white (1.05 / (l + 0.05)) vs against black ((l + 0.05) / 0.05).
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? "#ffffff" : "#000000";
}

export function edgePaint(style: MindmapStyle, branch: number, theme: ThemeName, override?: string): EdgePaint {
  const d = def(style);
  if (d.name === "minimal") return { stroke: mapInkColor(EDGE_GREY, theme), strokeWidth: d.edgeWidth };
  const stroke = mapInkColor(branchColor(branch, override), theme);
  return d.edgeDash ? { stroke, strokeWidth: d.edgeWidth, dash: d.edgeDash.slice() } : { stroke, strokeWidth: d.edgeWidth };
}
