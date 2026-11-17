import { PAGE_WIDTH } from "../model/constants";
import type { RulerLengthSnap, RulerUnits } from "../model/types";

/** 1080 page units are 210 mm in every page size and in canvas mode. */
export const UNITS_PER_MM = PAGE_WIDTH / 210;
export const UNITS_PER_INCH = UNITS_PER_MM * 25.4;
/** Closest two ticks may sit on screen. */
export const MIN_TICK_PX = 5;

export type RulerSystem = "metric" | "imperial";
/** `at` is in page units from zero; rank 2 carries a label. */
export interface Tick {
  at: number;
  rank: 0 | 1 | 2;
  label?: string;
}

interface Scale {
  /** Page units in one base unit (1 mm, or 1/16 in). */
  base: number;
  /** Allowed steps in base units, finest first. */
  steps: number[];
  /** Base units in a whole labelled unit (1 cm, 1 in) and in a half mark (5 mm, 1/2 in). */
  whole: number;
  half: number;
}

const SCALES: Record<RulerSystem, Scale> = {
  metric: { base: UNITS_PER_MM, steps: [1, 5, 10, 50, 100], whole: 10, half: 5 },
  imperial: { base: UNITS_PER_INCH / 16, steps: [1, 2, 4, 16, 32, 96, 192], whole: 16, half: 8 },
};

/** Step in base units: the finest allowed one at least MIN_TICK_PX apart on screen. */
function stepInBase(scale: Scale, zoom: number): number {
  for (const s of scale.steps) if (s * scale.base * zoom >= MIN_TICK_PX) return s;
  return scale.steps[scale.steps.length - 1];
}

/** Page units between ticks. */
export function tickStep(system: RulerSystem, zoom: number): number {
  const scale = SCALES[system];
  return stepInBase(scale, zoom) * scale.base;
}

/** Ticks whose position lies in [from, to] (page units from zero). */
export function ticks(system: RulerSystem, zoom: number, from: number, to: number): Tick[] {
  const scale = SCALES[system];
  const step = stepInBase(scale, zoom);
  const out: Tick[] = [];
  const first = Math.ceil(from / (step * scale.base) - 1e-9);
  const last = Math.floor(to / (step * scale.base) + 1e-9);
  for (let k = first; k <= last; k++) {
    const n = k * step; // base units from zero, an integer
    const m = Math.abs(n);
    const at = n * scale.base + 0; // + 0 turns -0 into 0
    if (m % scale.whole === 0) out.push({ at, rank: 2, label: String(m / scale.whole) });
    else if (m % scale.half === 0) out.push({ at, rank: 1 });
    else out.push({ at, rank: 0 });
  }
  return out;
}

/** The systems on edge +1 and edge -1. */
export function edgeSystems(units: RulerUnits): [RulerSystem, RulerSystem] {
  if (units === "both") return ["metric", "imperial"];
  return [units, units];
}

/** Length snap step in page units; 0 for "off". */
export function lengthSnapUnits(snap: RulerLengthSnap): number {
  switch (snap) {
    case "1mm":
      return UNITS_PER_MM;
    case "5mm":
      return 5 * UNITS_PER_MM;
    case "1cm":
      return 10 * UNITS_PER_MM;
    case "1/8in":
      return UNITS_PER_INCH / 8;
    case "1/4in":
      return UNITS_PER_INCH / 4;
    default:
      return 0;
  }
}

/** "12.5 cm" (metric and both) or "4.92 in" (imperial). */
export function formatLength(units: number, show: RulerUnits): string {
  if (show === "imperial") return `${(units / UNITS_PER_INCH).toFixed(2)} in`;
  const cm = Number((units / UNITS_PER_MM / 10).toFixed(1));
  return `${cm} cm`;
}
