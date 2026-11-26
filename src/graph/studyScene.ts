// What a function's study draws on its plot (pure), in graph coordinates: dots at the zeros, the
// y-intercept, the extrema and inflection points (the last two labelled with their coordinates),
// dashed asymptotes, the derivative's curve, and the region between the curve and the x axis over
// the chosen interval. Only the items switched on in `expression.study` are computed; the analysis
// runs within the plot's time budget and reports when it was cut short.
import type { GraphDomain, GraphStudy } from "./data";
import { formatPoint } from "./format";
import { derivative } from "./numeric";
import { runsOf, samplePieces, type PiecewiseFn } from "./pieces";
import { sampleCurve, type Point2 } from "./sample";
import { studyFunction } from "./study";

export interface StudyMarker extends Point2 {
  filled: boolean;
  label?: string;
}

export interface StudyOverlay {
  markers: StudyMarker[];
  /** Asymptotes, as segments across the window. */
  guides: { a: Point2; b: Point2 }[];
  /** Regions between the curve and the x axis (closed polygons). */
  fills: Point2[][];
  /** Branches of the derivative's curve. */
  derivative: Point2[][];
  /** True when the analysis ran out of time. */
  partial: boolean;
}

export const hasStudyItems = (s: GraphStudy | undefined): boolean => !!s && Object.keys(s).length > 0;

/** The study items of `fn` switched on in `study`, over the window `d`. Never throws. */
export function studyOverlay(fn: PiecewiseFn, study: GraphStudy, d: GraphDomain, budgetMs: number): StudyOverlay {
  const out: StudyOverlay = { markers: [], guides: [], fills: [], derivative: [], partial: false };
  const span = d.xMax - d.xMin;
  const yRange = d.yMax - d.yMin;
  const needsStudy = study.zeros || study.intercept || study.extrema || study.inflections || study.asymptotes;
  if (needsStudy) {
    const depth = study.inflections ? 2 : study.extrema ? 1 : 0;
    const r = studyFunction(fn, d, { yRange, budgetMs, depth });
    out.partial = r.partial;
    if (study.zeros) for (const x of r.zeros) out.markers.push({ x, y: 0, filled: true });
    if (study.intercept && r.intercept !== null && d.xMin <= 0 && d.xMax >= 0) out.markers.push({ x: 0, y: r.intercept, filled: true });
    if (study.extrema) for (const p of [...r.maxima, ...r.minima]) out.markers.push({ ...p, filled: true, label: formatPoint(p.x, p.y) });
    if (study.inflections) for (const p of r.inflections) out.markers.push({ ...p, filled: false, label: formatPoint(p.x, p.y) });
    if (study.asymptotes) {
      for (const a of r.vertical) out.guides.push({ a: { x: a.x, y: d.yMin }, b: { x: a.x, y: d.yMax } });
      const lines = new Set<string>();
      for (const b of [r.atMinusInfinity, r.atPlusInfinity]) {
        const line = b.kind === "limit" ? { m: 0, q: b.value } : b.kind === "oblique" ? { m: b.m, q: b.q } : null;
        if (!line || lines.has(`${line.m}|${line.q}`)) continue;
        lines.add(`${line.m}|${line.q}`);
        out.guides.push({ a: { x: d.xMin, y: line.m * d.xMin + line.q }, b: { x: d.xMax, y: line.m * d.xMax + line.q } });
      }
    }
  }
  if (study.derivative) {
    const h = span * 1e-6;
    for (const run of runsOf(fn, d.xMin, d.xMax)) out.derivative.push(...sampleCurve(derivative(fn.pieces[run.piece].f, h), run.a, run.b, { yRange, xRange: span }));
  }
  if (study.area) {
    const from = Math.max(study.area.from, d.xMin);
    const to = Math.min(study.area.to, d.xMax);
    if (to > from) {
      for (const branch of samplePieces(fn, runsOf(fn, from, to), from, to, { yRange, initial: 128, max: 1024 })) {
        if (branch.length < 2) continue;
        out.fills.push([{ x: branch[0].x, y: 0 }, ...branch, { x: branch[branch.length - 1].x, y: 0 }]);
      }
    }
  }
  return out;
}
