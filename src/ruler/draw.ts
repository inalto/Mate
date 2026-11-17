// The ruler painter (pure apart from the context it draws on). Everything is drawn in one frame
// aligned with the ruler: u runs along `rulerDir` in screen px from the zero mark, v across it, with
// edge +1 (the left-hand normal, "up" at angle 0) at v = −55 and edge −1 at v = +55.
import { worldToScreen, type Camera, type Viewport } from "../canvas/camera";
import type { RulerUnits } from "../model/types";
import { RULER_WIDTH_PX, rulerDir, visibleSpan, type RulerPose } from "./pose";
import { UNITS_PER_INCH, UNITS_PER_MM, edgeSystems, ticks, type RulerSystem } from "./scale";

export interface RulerColors {
  body: string;
  edge: string;
  ink: string;
}

const HALF = RULER_WIDTH_PX / 2;
/** The body runs this far past the pane at both ends, so its ends never show. */
const BODY_OVERRUN_PX = 200;
/** Ticks are listed a little past the pane, so none pops in at the border. */
const TICK_PAD_PX = 20;
const TICK_LENGTH_PX: Record<0 | 1 | 2, number> = { 0: 8, 1: 13, 2: 20 };
const LABEL_GAP_PX = 3;
const LABEL_FONT = "11px sans-serif";
const ZERO_WIDTH_PX = 2;
/** Closest two labels may sit on screen; zoomed out, only every 2nd, 5th, 10th… whole unit is labelled. */
const MIN_LABEL_PX = 28;
const LABEL_STRIDES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

/** Whole units (cm or in) between labels at this zoom. */
function labelStride(system: RulerSystem, zoom: number): number {
  const wholePx = (system === "metric" ? 10 * UNITS_PER_MM : UNITS_PER_INCH) * zoom;
  for (const s of LABEL_STRIDES) if (s * wholePx >= MIN_LABEL_PX) return s;
  return LABEL_STRIDES[LABEL_STRIDES.length - 1];
}

/** Labels would read upside down when the ruler points leftwards: angle in (90, 270]. */
const pointsLeft = (angle: number): boolean => {
  const a = ((angle % 360) + 360) % 360;
  return a > 90 && a <= 270;
};

export function drawRuler(
  ctx: CanvasRenderingContext2D,
  pose: RulerPose,
  camera: Camera,
  viewport: Viewport,
  units: RulerUnits,
  colors: RulerColors,
  dpr: number,
): void {
  if (!visibleSpan(pose, camera, viewport)) return;
  const z = camera.z;
  const origin = worldToScreen(camera, pose);
  const d = rulerDir(pose);
  // Along-range of the whole pane: project its corners onto the ruler's direction.
  let lo = Infinity;
  let hi = -Infinity;
  for (const [cx, cy] of [
    [0, 0],
    [viewport.width, 0],
    [0, viewport.height],
    [viewport.width, viewport.height],
  ]) {
    const t = (cx - origin.x) * d.x + (cy - origin.y) * d.y;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(origin.x, origin.y);
  // Screen y grows downwards: a counter-clockwise angle as seen is a negative canvas rotation.
  ctx.rotate((-pose.angle * Math.PI) / 180);

  // Body and its two long edges.
  ctx.fillStyle = colors.body;
  ctx.fillRect(lo - BODY_OVERRUN_PX, -HALF, hi - lo + 2 * BODY_OVERRUN_PX, RULER_WIDTH_PX);
  ctx.strokeStyle = colors.edge;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const v of [-HALF + 0.5, HALF - 0.5]) {
    ctx.moveTo(lo - BODY_OVERRUN_PX, v);
    ctx.lineTo(hi + BODY_OVERRUN_PX, v);
  }
  ctx.stroke();

  // Ticks: one path per edge, from the edge inwards.
  const from = (lo - TICK_PAD_PX) / z;
  const to = (hi + TICK_PAD_PX) / z;
  const systems = edgeSystems(units);
  const edges: { side: 1 | -1; system: RulerSystem }[] = [
    { side: 1, system: systems[0] },
    { side: -1, system: systems[1] },
  ];
  const labels: { u: number; v: number; text: string }[] = [];
  ctx.strokeStyle = colors.ink;
  ctx.lineWidth = 1;
  for (const { side, system } of edges) {
    // Edge +1 lies at v = −HALF; inwards is +v. Edge −1 mirrors it.
    const edgeV = -side * HALF;
    const inward = side;
    const stride = labelStride(system, z);
    ctx.beginPath();
    for (const tick of ticks(system, z, from, to)) {
      const u = tick.at * z;
      const len = TICK_LENGTH_PX[tick.rank];
      ctx.moveTo(u, edgeV);
      ctx.lineTo(u, edgeV + inward * len);
      if (tick.label !== undefined && Number(tick.label) % stride === 0) labels.push({ u, v: edgeV + inward * (TICK_LENGTH_PX[2] + LABEL_GAP_PX), text: tick.label });
    }
    ctx.stroke();
  }

  // The zero mark, across the whole width.
  ctx.lineWidth = ZERO_WIDTH_PX;
  ctx.beginPath();
  ctx.moveTo(0, -HALF);
  ctx.lineTo(0, HALF);
  ctx.stroke();

  // Labels, turned half a turn when the ruler points leftwards so they never read upside down.
  const flip = pointsLeft(pose.angle) ? -1 : 1;
  if (flip < 0) ctx.rotate(Math.PI);
  ctx.fillStyle = colors.ink;
  ctx.font = LABEL_FONT;
  ctx.textAlign = "center";
  for (const l of labels) {
    const u = flip * l.u;
    const v = flip * l.v;
    // Each label grows from just inside its long tick towards the centre line.
    ctx.textBaseline = v < 0 ? "top" : "bottom";
    ctx.fillText(l.text, u, v);
  }

  ctx.restore();
}
