// Practice answers: a handwritten group lying under a practice question's text box is checked
// against that question's expected answer.
import { contentOf } from "../model/content";
import type { Element } from "../model/types";
import { elementBounds, type Rect } from "../tools/spatialIndex";

/** Matches `PracticeContext` in src/ipc/recognize (plus the question's element id). */
export interface PracticeContext {
  question: string;
  expectedAnswer: string;
  elementId: string;
}

/** The hidden payload of a practice text box (`content.practice`). */
export interface PracticeContent {
  expectedAnswer: string;
  solutionLatex: string;
  questionType: string;
}

/** The practice payload of `el`, or null when it is not a practice question. */
export function practiceOf(el: Pick<Element, "type" | "content">): PracticeContent | null {
  if (el.type !== "text-box") return null;
  const p = contentOf<{ practice?: unknown }>(el).practice;
  if (!p || typeof p !== "object") return null;
  const q = p as Partial<PracticeContent>;
  if (typeof q.expectedAnswer !== "string") return null;
  return {
    expectedAnswer: q.expectedAnswer,
    solutionLatex: typeof q.solutionLatex === "string" ? q.solutionLatex : "",
    questionType: typeof q.questionType === "string" ? q.questionType : "",
  };
}

const HORIZONTAL_OVERLAP = 1; // at least this many page units shared

/**
 * The practice question a group at `regionBounds` answers: the practice text box nearest above it
 * (the group starts below the box's top and shares horizontal extent with it). Null when none.
 */
export function findPracticeContext(regionBounds: Rect, elements: Iterable<Element>): PracticeContext | null {
  let best: { el: Element; gap: number } | null = null;
  for (const el of elements) {
    if (el.deletedAt || !practiceOf(el)) continue;
    const b = elementBounds(el);
    const overlap = Math.min(b.x + b.width, regionBounds.x + regionBounds.width) - Math.max(b.x, regionBounds.x);
    if (overlap < HORIZONTAL_OVERLAP) continue;
    const gap = regionBounds.y - (b.y + b.height);
    if (gap < 0 && regionBounds.y < b.y + b.height / 2) continue; // not below the box
    const dist = Math.max(0, gap);
    if (!best || dist < best.gap) best = { el, gap: dist };
  }
  if (!best) return null;
  const p = practiceOf(best.el)!;
  const c = contentOf<{ rawContent?: string }>(best.el);
  return { question: typeof c.rawContent === "string" ? c.rawContent : "", expectedAnswer: p.expectedAnswer, elementId: best.el.id };
}
