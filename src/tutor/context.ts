// Context for a check: the previously recognised lines nearest to the group being checked.
import type { Recognition } from "../model/types";
import type { Region } from "./types";

export const MAX_CONTEXT_LINES = 11;

/** One line of context sent with a check (Rust `ai::provider::ContextLine`). */
export interface ContextLine {
  content: string;
  /** True only for a line being checked now; context lines are always false. */
  isNew: boolean;
}

const contentOf = (r: Recognition): string => (r.latex.trim() || r.transcription?.text.trim() || "").replace(/\s+/g, " ");

/**
 * Up to 11 recognised lines nearest to `region` by baseline distance (ties: nearest horizontally),
 * returned top to bottom. The group's own (older) verdicts, overlapping groups, illegible and empty
 * lines are skipped.
 */
export function pickContext(region: Region, recognitions: readonly Recognition[], max = MAX_CONTEXT_LINES): ContextLine[] {
  const own = new Set(region.elementIds);
  const cx = region.bounds.x + region.bounds.width / 2;
  const candidates = recognitions
    .filter((r) => r.strokeGroupId !== region.regionId && !r.illegible && !r.elementIds.some((id) => own.has(id)))
    .map((r) => ({
      r,
      content: contentOf(r),
      baseline: r.bounds.y + r.bounds.height,
      dx: Math.abs(r.bounds.x + r.bounds.width / 2 - cx),
    }))
    .filter((c) => c.content !== "");
  candidates.sort((a, b) => Math.abs(a.baseline - region.baselineY) - Math.abs(b.baseline - region.baselineY) || a.dx - b.dx);
  return candidates
    .slice(0, Math.max(0, max))
    .sort((a, b) => a.baseline - b.baseline || a.r.bounds.x - b.r.bounds.x)
    .map((c) => ({ content: c.content, isNew: false }));
}
