import type { Disc, Run } from "./types";

/**
 * Merge consecutive discs into near-constant-width polylines. A new run starts when r leaves
 * [rmin − tol, rmax + tol] with tol = max(0.05, 0.06·rmin, simplifyEps); width = rmin + rmax.
 * A new run begins at the previous run's last point so the stroke stays continuous.
 */
export function capsuleRuns(discs: Disc[], simplifyEps: number): Run[] {
  const runs: Run[] = [];
  if (discs.length === 0) return runs;

  let xy: number[] = [discs[0].x, discs[0].y];
  let rmin = discs[0].r;
  let rmax = discs[0].r;
  const flush = () => runs.push({ width: rmin + rmax, xy: Float64Array.from(xy) });

  for (let i = 1; i < discs.length; i++) {
    const { x, y, r } = discs[i];
    const tol = Math.max(0.05, 0.06 * rmin, simplifyEps);
    if (r < rmin - tol || r > rmax + tol) {
      flush();
      const prev = discs[i - 1];
      xy = [prev.x, prev.y, x, y];
      rmin = r;
      rmax = r;
    } else {
      xy.push(x, y);
      if (r < rmin) rmin = r;
      if (r > rmax) rmax = r;
    }
  }
  flush();
  return runs;
}
