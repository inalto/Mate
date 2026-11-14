// Pure time arithmetic between wall clock, audio position and canvas elements of a recording.
import type { Element } from "../model/types";
import type { RecordingContent, Segment, Span } from "./types";

/** How far before an element's start a tap on it seeks the audio. */
export const SEEK_LEAD_MS = 2000;

/** A stroke drawn over longer than this is treated as having no drawing time (bad timestamps). */
const MAX_STROKE_MS = 10 * 60_000;

const wallStartOf = (s: Span): number => Date.parse(s.wallStart);

export const totalMs = (rec: RecordingContent): number => rec.spans.reduce((sum, s) => sum + s.durationMs, 0);

/** Audio ms for a wall-clock ms; null before the first span or after the last. In a gap: end of the previous span, with inGap true. */
export function wallToAudio(spans: Span[], wallMs: number): { audioMs: number; inGap: boolean } | null {
  if (spans.length === 0 || wallMs < wallStartOf(spans[0])) return null;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    const start = wallStartOf(s);
    const end = start + s.durationMs;
    const last = i === spans.length - 1;
    if (wallMs < end || (last && wallMs === end)) return { audioMs: s.audioStartMs + (wallMs - start), inGap: false };
    if (!last && wallMs < wallStartOf(spans[i + 1])) return { audioMs: s.audioStartMs + s.durationMs, inGap: true };
  }
  return null;
}

/** Wall ms for an audio ms, clamped to the recording's first start and last end. */
export function audioToWall(spans: Span[], audioMs: number): number {
  if (spans.length === 0) return 0;
  const first = spans[0];
  if (audioMs <= first.audioStartMs) return wallStartOf(first);
  let s = first;
  for (const c of spans) if (c.audioStartMs <= audioMs) s = c;
  return wallStartOf(s) + Math.min(audioMs - s.audioStartMs, s.durationMs);
}

/** Wall time lost between consecutive spans (pauses), positioned at the audio ms where each occurs. */
export function gaps(spans: Span[]): { audioMs: number; lostMs: number }[] {
  const out: { audioMs: number; lostMs: number }[] = [];
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1];
    const lostMs = wallStartOf(spans[i]) - (wallStartOf(prev) + prev.durationMs);
    if (lostMs > 0) out.push({ audioMs: spans[i].audioStartMs, lostMs });
  }
  return out;
}

/** The segment holding audio ms and the offset into it; clamped to the first start and last end. */
export function segmentAt(segments: Segment[], audioMs: number): { index: number; offsetMs: number } {
  if (segments.length === 0) return { index: 0, offsetMs: 0 };
  let rest = Math.max(0, audioMs);
  for (let i = 0; i < segments.length; i++) {
    if (rest < segments[i].durationMs) return { index: i, offsetMs: rest };
    rest -= segments[i].durationMs;
  }
  const index = segments.length - 1;
  return { index, offsetMs: segments[index].durationMs };
}

/** Wall ms at which the element was started: createdAt − stroke duration (points' timestamp range) for strokes, createdAt otherwise. */
export function elementStartWall(el: Element): number {
  const created = Date.parse(el.createdAt);
  if (el.type !== "stroke" || el.points.length < 2) return created;
  for (let i = 1; i < el.points.length; i++) if (el.points[i].timestamp < el.points[i - 1].timestamp) return created;
  const dur = el.points[el.points.length - 1].timestamp - el.points[0].timestamp;
  return dur > MAX_STROKE_MS ? created : created - dur;
}

/** Ids of elements started during the recording and after `positionMs`. */
export function dimmedIds(elements: Iterable<Element>, rec: RecordingContent, positionMs: number): Set<string> {
  const out = new Set<string>();
  for (const el of elements) {
    const a = wallToAudio(rec.spans, elementStartWall(el));
    if (a && a.audioMs > positionMs) out.add(el.id);
  }
  return out;
}

/** Audio ms to seek to for a tap on `el`: start − lead, floored at 0; null when the element is outside the recording. */
export function seekTargetFor(el: Element, rec: RecordingContent): { audioMs: number; inGap: boolean } | null {
  const a = wallToAudio(rec.spans, elementStartWall(el));
  return a && { audioMs: Math.max(0, a.audioMs - SEEK_LEAD_MS), inGap: a.inGap };
}
