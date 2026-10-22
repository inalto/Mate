// Small SVG string helpers shared by the page export and the element renderers.

/** Number with at most two decimals. */
export const n = (v: number): string => String(Math.round(v * 100) / 100);

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const circle = (x: number, y: number, r: number, fill: string): string =>
  `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${fill}"/>`;

/** Collects path commands as SVG `d` data. */
export class PathData {
  d = "";
  moveTo(x: number, y: number) {
    this.d += `M${n(x)} ${n(y)}`;
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    this.d += `Q${n(cx)} ${n(cy)} ${n(x)} ${n(y)}`;
  }
  closePath() {
    this.d += "Z";
  }
}
