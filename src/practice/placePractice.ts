// Puts generated practice questions on new notebook pages: one text box per question (the
// question, then its LaTeX), stacked top to bottom with room for a handwritten answer below each.
// A hidden `content.practice` carries the expected answer for the tutor.
import { PAGE_MODE_SIDE_MARGIN, PAGE_MODE_TOP_MARGIN, PAGE_WIDTH, LIMITS } from "../model/constants";
import type { TextBoxContent } from "../model/content";
import { showToast } from "../components/Toast";
import { esc } from "../export/svgUtil";
import { upsertElements } from "../ipc/elements";
import { MAX_PRACTICE_QUESTIONS, type PracticeQuestion } from "../ipc/practice";
import { renderLatex } from "../math/katex";
import type { Element, Page } from "../model/types";
import { defaultTextAttributes } from "../text/textBox";
import { sanitizeHtml } from "../text/sanitize";
import { useNotebookStore } from "../stores/notebook";
import type { EditorStore } from "../stores/editor";

export const QUESTION_GAP = 24;
/** Blank space (page units) left under each question for the handwritten answer. */
export const ANSWER_ROOM = 220;
const FONT_SIZE = 26;
const LINE = FONT_SIZE * 1.4;
/** Rough average glyph width as a fraction of the font size, for sizing the box. */
const GLYPH = 0.55;
const LATEX_HEIGHT = FONT_SIZE * 2.6;

export const practicePageTitle = (d: Date = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `Practice — ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const boxWidth = PAGE_WIDTH - 2 * PAGE_MODE_SIDE_MARGIN;

function estimateHeight(text: string, hasLatex: boolean): number {
  const perLine = Math.max(1, Math.floor(boxWidth / (FONT_SIZE * GLYPH)));
  const lines = text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  return Math.ceil(lines * LINE + (hasLatex ? LATEX_HEIGHT : 0) + 8);
}

/** The text box for question `n` (1-based) with its top-left at (`x`, `y`). */
export function practiceBox(pageId: string, q: PracticeQuestion, n: number, y: number, now: string): Element {
  const attrs = defaultTextAttributes();
  const text = `${n}. ${q.problemText.trim()}`.trim();
  const latex = q.problemLatex.trim();
  const rendered = latex ? renderLatex(latex).html : "";
  const html = sanitizeHtml(`<p>${esc(text)}</p>${rendered ? `<div>${rendered}</div>` : ""}`);
  const content: TextBoxContent & { practice: Record<string, string> } = {
    contentHtml: html,
    rawContent: latex ? `${text}\n${latex}` : text,
    textAttributes: attrs,
    practice: { expectedAnswer: q.expectedAnswer, solutionLatex: q.solutionLatex, questionType: q.questionType },
  };
  return {
    id: crypto.randomUUID(),
    pageId,
    type: "text-box",
    points: [{ x: PAGE_MODE_SIDE_MARGIN, y, pressure: 0.5, timestamp: 0 }],
    color: attrs.color,
    width: 1,
    isHighlighter: false,
    boxWidth,
    boxHeight: estimateHeight(text, latex !== ""),
    content,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

/** Element lists, one per page, for `questions` stacked top to bottom (`perPage` boxes at most). */
export function layoutPractice(pageIds: () => string, questions: PracticeQuestion[], perPage: number, now: string): { pageId: string; els: Element[] }[] {
  const pages: { pageId: string; els: Element[] }[] = [];
  let y = PAGE_MODE_TOP_MARGIN;
  questions.forEach((q, i) => {
    if (i % perPage === 0) {
      pages.push({ pageId: pageIds(), els: [] });
      y = PAGE_MODE_TOP_MARGIN;
    }
    const page = pages[pages.length - 1];
    const box = practiceBox(page.pageId, q, i + 1, y, now);
    page.els.push(box);
    y += (box.boxHeight ?? 0) + ANSWER_ROOM + QUESTION_GAP;
  });
  return pages;
}

export interface PlaceResult {
  pageIds: string[];
  placed: number;
}

export interface PlaceOptions {
  sectionId: string;
  /** Boxes per page; defaults to the page element limit (and is never above it). */
  perPage?: number;
  now?: Date;
  /** When this editor has the new page loaded the boxes go in through it as ONE history entry. */
  editor?: EditorStore;
}

/**
 * Creates "Practice — <date>" in `sectionId` and puts the questions on it. At most 20 questions
 * are placed (extras are dropped with a toast). One box per question means a page never nears the
 * 5000 element limit, but should `perPage` be smaller the rest continue on further pages,
 * "Practice — <date> (2)" and so on, never past the limit. All boxes of a page are added in one
 * batch: one undo entry when an editor holds the page, otherwise one persisted write.
 */
export async function placePractice(questions: PracticeQuestion[], opts: PlaceOptions): Promise<PlaceResult> {
  let qs = questions;
  if (qs.length > MAX_PRACTICE_QUESTIONS) {
    qs = qs.slice(0, MAX_PRACTICE_QUESTIONS);
    showToast(`A practice page holds up to ${MAX_PRACTICE_QUESTIONS} questions; the rest were left out.`);
  }
  if (qs.length === 0) return { pageIds: [], placed: 0 };
  const perPage = Math.max(1, Math.min(opts.perPage ?? LIMITS.MAX_ELEMENTS_PER_PAGE, LIMITS.MAX_ELEMENTS_PER_PAGE));
  const nowD = opts.now ?? new Date();
  const now = nowD.toISOString();
  const title = practicePageTitle(nowD);
  const { createPage } = useNotebookStore.getState();

  const chunks = Math.ceil(qs.length / perPage);
  const pages: Page[] = [];
  for (let i = 0; i < chunks; i++) {
    pages.push(await createPage(opts.sectionId, i === 0 ? title : `${title} (${i + 1})`));
  }
  let next = 0;
  const laid = layoutPractice(() => pages[next++].id, qs, perPage, now);
  for (const { pageId, els } of laid) {
    const ed = opts.editor;
    if (ed && ed.getState().loadedPageId === pageId) {
      if (!ed.getState().addElements("Practice questions", els)) throw new Error("This page is full.");
    } else {
      await upsertElements(els);
    }
  }
  return { pageIds: pages.map((p) => p.id), placed: qs.length };
}
