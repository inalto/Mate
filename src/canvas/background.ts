// Page backgrounds (doc 01 §6, spec 03 §4): pure pattern generation for a world-space clip,
// plus a small painter used by the static layer.
import { PAGE_BORDER_RADIUS, PAGE_GAP } from "../model/constants";
import type { BackgroundConfig, PageMode } from "../model/types";
import { isDarkTheme } from "../ink/theme";
import type { ThemeName } from "../ink/types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  major: boolean;
}

export interface Dot {
  x: number;
  y: number;
  r: number;
  color: string;
}

export interface BackgroundPage {
  mode: PageMode;
  width: number;
  height: number;
  /** Page mode: number of stacked sheets (default: unbounded downward). */
  count?: number;
}

export const DEFAULT_RULE_INSET_X = 96;
const MAX_LINES_PER_AXIS = 400;
const MAX_DOTS = 40_000;
const SIN60 = Math.sin(Math.PI / 3);
const COT60 = 1 / Math.tan(Math.PI / 3);

function colors(theme: ThemeName, cfg: BackgroundConfig) {
  const dark = isDarkTheme(theme);
  const rule = cfg.gridColor ?? (dark ? "#2a2a2e" : "#e5e5e5");
  return {
    rule,
    major: cfg.gridColor ?? (dark ? "#3a3a40" : "#d4d4d4"),
    margin: dark ? "rgba(253,92,81,.25)" : "#ffcccc",
    dot: cfg.gridColor ?? (dark ? "#3a3a40" : "#c8c8c8"),
  };
}

/** Indices k with origin + k·step inside [lo, hi]. */
function range(lo: number, hi: number, origin: number, step: number): [number, number] {
  return [Math.ceil((lo - origin) / step), Math.floor((hi - origin) / step)];
}

/** Emit the pattern for one region (the clip ∩ a sheet, or the clip in canvas mode). `sheet` is the
 * whole sheet in page mode (templates place rules at fractions of it), null in canvas mode. On a
 * sheet no ruled line is drawn on the sheet's top edge. */
function emitRegion(
  cfg: BackgroundConfig,
  r: Rect,
  originX: number,
  originY: number,
  c: ReturnType<typeof colors>,
  out: { lines: Line[]; dots: Dot[] },
  sheet: Rect | null,
): void {
  const right = r.x + r.width;
  const bottom = r.y + r.height;
  const ox = originX + (cfg.offsetX ?? 0);
  let step = cfg.spacing > 0 ? cfg.spacing : 40;
  const tooDense = (s: number) => Math.max(r.width, r.height) / s > MAX_LINES_PER_AXIS;
  const hLine = (y: number, color: string, width: number, major: boolean) =>
    out.lines.push({ x1: r.x, y1: y, x2: right, y2: y, color, width, major });
  const vLine = (x: number, color: string, width: number, major: boolean, y1 = r.y, y2 = bottom) =>
    out.lines.push({ x1: x, y1, x2: x, y2, color, width, major });
  /** Horizontal rules every `s` from `originY` (none on a sheet's top edge). */
  const ruledBody = (s: number) => {
    const [k0, k1] = range(r.y, bottom, originY, s);
    for (let k = sheet ? Math.max(k0, 1) : k0; k <= k1; k++) hLine(originY + k * s, c.rule, 1, false);
  };
  /** Horizontal line inside the region only. */
  const hLineIn = (y: number, color: string, width: number, major: boolean) => {
    if (y >= r.y && y <= bottom) hLine(y, color, width, major);
  };

  switch (cfg.type) {
    case "ruled":
    case "ruled-no-margin": {
      while (tooDense(step)) step *= 2;
      ruledBody(step);
      if (cfg.type === "ruled") {
        const mx = originX + (cfg.ruleInsetX ?? DEFAULT_RULE_INSET_X);
        if (mx >= r.x && mx <= right) vLine(mx, c.margin, 1, false);
      }
      return;
    }
    case "grid":
    case "grid-uniform": {
      const majorEvery = cfg.type === "grid" ? 5 : 0;
      let mult = 1;
      while (tooDense(step * mult)) mult *= majorEvery || 2;
      const s = step * mult;
      const isMajor = (k: number) => majorEvery > 0 && (k * mult) % majorEvery === 0;
      const [y0, y1] = range(r.y, bottom, originY, s);
      for (let k = y0; k <= y1; k++) {
        const m = isMajor(k);
        hLine(originY + k * s, m ? c.major : c.rule, m ? 1.5 : 1, m);
      }
      const [x0, x1] = range(r.x, right, ox, s);
      for (let k = x0; k <= x1; k++) {
        const m = isMajor(k);
        vLine(ox + k * s, m ? c.major : c.rule, m ? 1.5 : 1, m);
      }
      return;
    }
    case "dot-grid": {
      const rad = cfg.dotRadius > 0 ? cfg.dotRadius : 1.5;
      while ((r.width / step) * (r.height / step) > MAX_DOTS) step *= 2;
      const [y0, y1] = range(r.y, bottom, originY, step);
      const [x0, x1] = range(r.x, right, ox, step);
      for (let j = y0; j <= y1; j++) {
        for (let i = x0; i <= x1; i++) {
          out.dots.push({ x: ox + i * step, y: originY + j * step, r: rad, color: c.dot });
        }
      }
      return;
    }
    case "isometric": {
      // Equilateral triangles of side s: horizontals every s·sin60, plus the 60° and 120° families.
      const diagonalsPerFamily = (s: number) => (r.width + r.height * COT60) / s;
      while (tooDense(step * SIN60) || diagonalsPerFamily(step) > MAX_LINES_PER_AXIS) step *= 2;
      const h = step * SIN60;
      const [k0, k1] = range(r.y, bottom, originY, h);
      for (let k = sheet ? Math.max(k0, 1) : k0; k <= k1; k++) hLine(originY + k * h, c.rule, 1, false);
      for (const m of [COT60, -COT60]) {
        // Lines x = ox + k·s + (y − originY)·m, clipped to the region.
        const atTop = (r.y - originY) * m;
        const atBottom = (bottom - originY) * m;
        const [j0, j1] = range(r.x - Math.max(atTop, atBottom), right - Math.min(atTop, atBottom), ox, step);
        for (let j = j0; j <= j1; j++) {
          const cx = ox + j * step;
          const ya = originY + (r.x - cx) / m;
          const yb = originY + (right - cx) / m;
          const y1 = Math.max(r.y, Math.min(ya, yb));
          const y2 = Math.min(bottom, Math.max(ya, yb));
          if (y2 - y1 <= 1e-9) continue;
          const xAt = (y: number) => Math.min(right, Math.max(r.x, cx + (y - originY) * m));
          out.lines.push({ x1: xAt(y1), y1, x2: xAt(y2), y2, color: c.rule, width: 1, major: false });
        }
      }
      return;
    }
    case "hex": {
      // Triangular lattice: rows every s·sin60, odd rows shifted by s/2.
      const rad = cfg.dotRadius > 0 ? cfg.dotRadius : 1.5;
      while ((r.width / step + 1) * (r.height / (step * SIN60) + 1) > MAX_DOTS) step *= 2;
      const h = step * SIN60;
      const [y0, y1] = range(r.y, bottom, originY, h);
      for (let j = y0; j <= y1; j++) {
        const shift = ((j % 2) + 2) % 2 === 1 ? step / 2 : 0;
        const [x0, x1] = range(r.x, right, ox + shift, step);
        for (let i = x0; i <= x1; i++) {
          out.dots.push({ x: ox + shift + i * step, y: originY + j * h, r: rad, color: c.dot });
        }
      }
      return;
    }
    case "cornell": {
      // Ruled body, cue column rule, and (on a sheet) the summary band at 80 % of the height.
      while (tooDense(step)) step *= 2;
      ruledBody(step);
      const cueX = sheet ? sheet.x + 0.3 * sheet.width : originX + (cfg.ruleInsetX ?? DEFAULT_RULE_INSET_X * 3);
      const summaryY = sheet ? sheet.y + 0.8 * sheet.height : Infinity;
      const cueBottom = Math.min(bottom, summaryY);
      if (cueX >= r.x && cueX <= right && cueBottom > r.y) vLine(cueX, c.major, 1.5, true, r.y, cueBottom);
      if (sheet) hLineIn(summaryY, c.major, 1.5, true);
      return;
    }
    case "handwriting": {
      // Groups of cap (minor), mid (thin) and base (major) lines spanning s, with s/2 between groups.
      // On a sheet only whole groups that fit below its top edge are drawn.
      while ((2 * Math.max(r.width, r.height)) / step > MAX_LINES_PER_AXIS) step *= 2;
      const pitch = step * 1.5;
      const [g0, g1] = range(r.y - step, bottom, originY + step / 2, pitch);
      for (let g = g0; g <= g1; g++) {
        const cap = originY + step / 2 + g * pitch;
        if (sheet && !wholeOnSheet(sheet, cap, cap + step)) continue;
        hLineIn(cap, c.rule, 1, false);
        hLineIn(cap + step / 2, c.rule, 0.5, false);
        hLineIn(cap + step, c.major, 1.5, true);
      }
      return;
    }
    case "columns": {
      // Ruled body plus major rules at the thirds of the sheet (every 12·s on the canvas).
      while (tooDense(step)) step *= 2;
      ruledBody(step);
      if (sheet) {
        for (const f of [1 / 3, 2 / 3]) {
          const x = sheet.x + f * sheet.width;
          if (x >= r.x && x <= right) vLine(x, c.major, 1.5, true);
        }
      } else {
        const every = step * 12;
        const [x0, x1] = range(r.x, right, ox, every);
        for (let k = x0; k <= x1; k++) vLine(ox + k * every, c.major, 1.5, true);
      }
      return;
    }
    case "music": {
      // Staves of five lines s/4 apart (stave height s), one stave every 2.5·s, centred in its band.
      while ((2 * Math.max(r.width, r.height)) / step > MAX_LINES_PER_AXIS) step *= 2;
      const pitch = step * 2.5;
      const first = originY + (pitch - step) / 2;
      const [k0, k1] = range(r.y - step, bottom, first, pitch);
      for (let k = k0; k <= k1; k++) {
        const top = first + k * pitch;
        if (sheet && !wholeOnSheet(sheet, top, top + step)) continue;
        for (let i = 0; i < 5; i++) hLineIn(top + (i * step) / 4, c.major, 1, false);
      }
      return;
    }
    default:
      return; // blank, custom (image backgrounds are not drawn in phase 1)
  }
}

/** A band [top, bottom] lies strictly below the sheet's top edge and within its bottom edge. */
function wholeOnSheet(sheet: Rect, top: number, bottom: number): boolean {
  return top > sheet.y && bottom <= sheet.y + sheet.height;
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const bt = Math.min(a.y + a.height, b.y + b.height);
  return r > x && bt > y ? { x, y, width: r - x, height: bt - y } : null;
}

/** Visible sheet indices for a clip in page mode. */
export function visibleSheets(clip: Rect, page: BackgroundPage): number[] {
  const stride = page.height + PAGE_GAP;
  const first = Math.max(0, Math.floor(clip.y / stride));
  let last = Math.floor((clip.y + clip.height) / stride);
  if (page.count !== undefined) last = Math.min(last, page.count - 1);
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

/**
 * Background pattern for a world-space `clip`. Canvas mode tiles the whole clip; page mode clamps
 * lines and dots to each visible sheet (the pattern restarts at each sheet's top edge).
 */
export function buildBackgroundPattern(
  cfg: BackgroundConfig,
  clip: Rect,
  page: BackgroundPage,
  theme: ThemeName,
): { lines: Line[]; dots: Dot[] } {
  const out = { lines: [] as Line[], dots: [] as Dot[] };
  if (cfg.type === "blank" || cfg.type === "custom") return out;
  const c = colors(theme, cfg);
  if (page.mode !== "page") {
    emitRegion(cfg, clip, 0, 0, c, out, null);
    return out;
  }
  const stride = page.height + PAGE_GAP;
  for (const i of visibleSheets(clip, page)) {
    const top = i * stride;
    const sheet = { x: 0, y: top, width: page.width, height: page.height };
    const r = intersect(clip, sheet);
    if (r) emitRegion(cfg, r, 0, top, c, out, sheet);
  }
  return out;
}

export interface SurfaceColors {
  /** Paper colour (canvas mode background, sheet fill). */
  paper: string;
  /** Area around the sheets in page mode. */
  desk: string;
}

/** Paint the paper/sheets and the pattern for `clip`. `ctx` already has the world transform. */
export function paintBackground(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  cfg: BackgroundConfig,
  clip: Rect,
  page: BackgroundPage,
  theme: ThemeName,
  surface: SurfaceColors,
): void {
  ctx.save();
  if (page.mode === "page") {
    ctx.fillStyle = surface.desk;
    ctx.fillRect(clip.x, clip.y, clip.width, clip.height);
    ctx.fillStyle = surface.paper;
    const stride = page.height + PAGE_GAP;
    for (const i of visibleSheets(clip, page)) {
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(0, i * stride, page.width, page.height, PAGE_BORDER_RADIUS);
      } else {
        ctx.rect(0, i * stride, page.width, page.height);
      }
      ctx.fill();
    }
  } else {
    ctx.fillStyle = surface.paper;
    ctx.fillRect(clip.x, clip.y, clip.width, clip.height);
  }
  const { lines, dots } = buildBackgroundPattern(cfg, clip, page, theme);
  for (const l of lines) {
    ctx.strokeStyle = l.color;
    ctx.lineWidth = l.width;
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }
  for (const d of dots) {
    ctx.fillStyle = d.color;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Colour of the presentation backdrop (desk and paper outside the frame shown). */
export const PRESENT_BACKDROP = "#000000";

/**
 * Presentation backdrop: paint `clip` black except the frame rect `hole` (rounded by `radius`), over
 * the background and under the elements, so the frame's own fill and every element stay visible.
 * `ctx` already has the world transform.
 */
export function presentBackdrop(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  clip: Rect,
  hole: Rect,
  radius = 0,
  color = PRESENT_BACKDROP,
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.rect(clip.x, clip.y, clip.width, clip.height);
  if (radius > 0 && typeof ctx.roundRect === "function") ctx.roundRect(hole.x, hole.y, hole.width, hole.height, radius);
  else ctx.rect(hole.x, hole.y, hole.width, hole.height);
  ctx.fill("evenodd");
  ctx.restore();
}
