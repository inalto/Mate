// Puts generated practice questions on new notebook pages: one text box per question (the
// question, then its LaTeX), stacked top to bottom with room for a handwritten answer below each.
// A hidden `content.practice` carries the expected answer for the tutor.
import { PAGE_HEIGHT, PAGE_MODE_SIDE_MARGIN, PAGE_MODE_TOP_MARGIN, PAGE_WIDTH, LIMITS } from "../model/constants";
import type { TextBoxContent } from "../model/content";
import { showToast } from "../components/Toast";
import i18n from "../i18n";
import { esc } from "../export/svgUtil";
import { upsertElements } from "../ipc/elements";
import { MAX_PRACTICE_QUESTIONS, type PracticeQuestion } from "../ipc/practice";
import { renderLatex } from "../math/katex";
import type { Element, Page } from "../model/types";
import { defaultTextAttributes } from "../text/textBox";
import { sanitizeHtml } from "../text/sanitize";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";
import { sheetSizeFor } from "../canvas/camera";
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
  return i18n.t("practice.pageTitle", { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` });
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

/**
 * Element lists, one per page, for `questions` stacked top to bottom. A new page starts when the
 * next question and its answer room would cross `pageHeight` minus the bottom margin (or, in
 * theory, at the per-page element limit).
 */
export function layoutPractice(
  newPageId: () => string,
  questions: PracticeQuestion[],
  opts: { pageHeight?: number; now: string },
): { pageId: string; els: Element[] }[] {
  const perPage = LIMITS.MAX_ELEMENTS_PER_PAGE;
  const limit = (opts.pageHeight ?? PAGE_HEIGHT) - PAGE_MODE_TOP_MARGIN;
  const pages: { pageId: string; els: Element[] }[] = [];
  let y = PAGE_MODE_TOP_MARGIN;
  questions.forEach((q, i) => {
    const probe = practiceBox("", q, i + 1, y, opts.now);
    const need = (probe.boxHeight ?? 0) + ANSWER_ROOM;
    const cur = pages[pages.length - 1];
    if (!cur || cur.els.length >= perPage || (cur.els.length > 0 && y + need > limit)) {
      pages.push({ pageId: newPageId(), els: [] });
      y = PAGE_MODE_TOP_MARGIN;
    }
    const page = pages[pages.length - 1];
    page.els.push({ ...probe, pageId: page.pageId, points: [{ ...probe.points[0], y }] });
    y += need + QUESTION_GAP;
  });
  return pages;
}

export interface PlaceResult {
  pageIds: string[];
  placed: number;
}

export interface PlaceOptions {
  sectionId: string;
  /** Height of the new pages; defaults to the standard page height. */
  pageHeight?: number;
  now?: Date;
  /** When this editor has the new page loaded the boxes go in through it as ONE history entry. */
  editor?: EditorStore;
}

/**
 * Creates "Practice — <date>" in `sectionId` and puts the questions on it. At most 20 questions
 * are placed (extras are dropped with a toast). Pages fill by height: when the next question and
 * its answer room would pass the page bottom, it continues on "Practice — <date> (2)" and so on
 * (never past the 5000 element limit). All boxes of a page are added in one batch: one undo entry
 * when an editor holds the page, otherwise one persisted write. If anything fails, the pages
 * created so far are moved to the trash before the error is rethrown.
 */
export async function placePractice(questions: PracticeQuestion[], opts: PlaceOptions): Promise<PlaceResult> {
  let qs = questions;
  if (qs.length > MAX_PRACTICE_QUESTIONS) {
    qs = qs.slice(0, MAX_PRACTICE_QUESTIONS);
    showToast(i18n.t("practice.tooMany", { max: MAX_PRACTICE_QUESTIONS }));
  }
  if (qs.length === 0) return { pageIds: [], placed: 0 };
  const nowD = opts.now ?? new Date();
  const now = nowD.toISOString();
  const title = practicePageTitle(nowD);
  const { createPage, trash } = useNotebookStore.getState();

  // Paper pages get the default sheet (see notebook.createPage); canvas pages the standard height.
  const cfg = useSettingsStore.getState().settings;
  const pageHeight =
    opts.pageHeight ?? (cfg.defaultPageMode === "page" ? sheetSizeFor(cfg.defaultPageAspectRatio, cfg.defaultPageOrientation).height : undefined);
  const plan = layoutPractice(() => "pending", qs, { pageHeight, now });
  const created: Page[] = [];
  try {
    for (let i = 0; i < plan.length; i++) {
      const page = await createPage(opts.sectionId, i === 0 ? title : `${title} (${i + 1})`);
      created.push(page);
      for (const el of plan[i].els) el.pageId = page.id;
      const ed = opts.editor;
      if (ed && ed.getState().loadedPageId === page.id) {
        if (!ed.getState().addElements("Practice questions", plan[i].els)) throw new Error(i18n.t("practice.pageFull"));
      } else {
        await upsertElements(plan[i].els);
      }
    }
  } catch (err) {
    // Leave no empty "Practice" pages behind.
    for (const p of created) {
      try {
        await trash("page", p.id);
      } catch {
        /* best effort */
      }
    }
    throw err;
  }
  return { pageIds: created.map((p) => p.id), placed: qs.length };
}
