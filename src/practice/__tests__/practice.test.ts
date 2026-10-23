import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element, Page } from "../../model/types";

const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {}),
  pending: () => 0,
  failed: () => 0,
}));
const ipc = vi.hoisted(() => ({ upsertElements: vi.fn(async (_els: Element[]) => {}), loadElements: vi.fn(async () => [] as Element[]) }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ipc);
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));

import { LIMITS, PAGE_HEIGHT, PAGE_MODE_TOP_MARGIN } from "../../model/constants";
import { contentOf, type TextBoxContent } from "../../model/content";
import { useToastStore } from "../../components/Toast";
import type { PracticeQuestion } from "../../ipc/practice";
import { createEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { findPracticeContext, practiceOf } from "../practiceContext";
import { ANSWER_ROOM, QUESTION_GAP, placePractice, practicePageTitle } from "../placePractice";

const q = (i: number): PracticeQuestion => ({
  problemText: `Differentiate x^${i}`,
  problemLatex: `\frac{d}{dx}x^{${i}}`,
  questionType: "short-answer",
  expectedAnswer: `${i}x^{${i - 1}}`,
  solutionLatex: `${i}x^{${i - 1}}`,
});
const questions = (n: number) => Array.from({ length: n }, (_, i) => q(i + 2));

const createPage = vi.fn(async (sectionId: string, title: string): Promise<Page> => ({
  id: `pg-${createPage.mock.calls.length}`,
  sectionId,
  title,
  isExpanded: true,
  isFavourite: false,
  depth: 0,
  mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex: 0,
  createdAt: "",
  updatedAt: "",
  version: 0,
}));

const trash = vi.fn(async (_k: string, _id: string) => {});

beforeEach(() => {
  vi.clearAllMocks();
  createPage.mockClear();
  useToastStore.getState().dismiss();
  useNotebookStore.setState({ createPage, trash } as never);
});

describe("practice placement", () => {
  it("practice_page_is_one_entry", async () => {
    const store = createEditorStore();
    // The new page is loaded in the editor; the boxes go in as one batch.
    const s = () => store.getState();
    useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [], sections: [], pages: [] } });
    await s().loadPage("pg-1");
    const before = s().elements.size;
    const result = await placePractice(questions(3), { sectionId: "sec", editor: store, now: new Date(2026, 9, 23) });
    expect(result.pageIds).toEqual(["pg-1"]);
    expect(s().elements.size).toBe(before + 3);
    expect(queue.enqueueUpsert).toHaveBeenCalledTimes(3);
    expect(ipc.upsertElements).not.toHaveBeenCalled();
    // one undo removes every box, one redo brings them all back
    expect(s().canUndo).toBe(true);
    s().undo();
    expect(s().elements.size).toBe(0);
    expect(s().canUndo).toBe(false);
    s().redo();
    expect(s().elements.size).toBe(3);
    expect(createPage.mock.calls[0][1]).toBe("Practice — 2026-10-23");
    expect(practicePageTitle(new Date(2026, 0, 5))).toBe("Practice — 2026-01-05");
  });

  it("practice_limits_20", async () => {
    const r = await placePractice(questions(25), { sectionId: "sec" });
    expect(r.placed).toBe(20);
    expect(useToastStore.getState().message).toMatch(/up to 20 questions/);
    expect(ipc.upsertElements.mock.calls.flat(2)).toHaveLength(20);
    const els = ipc.upsertElements.mock.calls[0][0];
    expect(els.length).toBeLessThanOrEqual(LIMITS.MAX_ELEMENTS_PER_PAGE);
    // stacked top to bottom with room for an answer beneath each
    const ys = els.map((e) => e.points[0].y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    for (let i = 1; i < els.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThan((els[i - 1].boxHeight ?? 0) + 200);
    // hidden practice payload, visible question text and latex
    const p = practiceOf(els[0])!;
    expect(p.expectedAnswer).toBe("2x^{1}");
    expect(contentOf<TextBoxContent>(els[0]).rawContent).toContain("1. Differentiate x^2");
    expect(contentOf<TextBoxContent>(els[0]).contentHtml).toContain("katex");
  });

  it("splits across further pages when a page cannot hold them all", async () => {
    // A page height that holds exactly three questions with their answer room.
    await placePractice(questions(1), { sectionId: "sec" });
    const h = ipc.upsertElements.mock.calls[0][0][0].boxHeight ?? 0;
    createPage.mockClear();
    ipc.upsertElements.mockClear();
    const pageHeight = 2 * PAGE_MODE_TOP_MARGIN + 3 * (h + ANSWER_ROOM + QUESTION_GAP);
    const r = await placePractice(questions(7), { sectionId: "sec", pageHeight });
    expect(r.pageIds).toHaveLength(3);
    expect(createPage.mock.calls.map((c) => c[1])).toEqual([
      expect.stringMatching(/^Practice — \d{4}-\d\d-\d\d$/),
      expect.stringMatching(/\(2\)$/),
      expect.stringMatching(/\(3\)$/),
    ]);
    expect(ipc.upsertElements.mock.calls.map((c) => c[0].length)).toEqual([3, 3, 1]);
    // numbering continues across pages
    expect(contentOf<TextBoxContent>((ipc.upsertElements.mock.calls[1][0])[0]).rawContent).toContain("4. ");
  });
});

describe("practice context", () => {

  it("answer_under_question_gets_practice_context", async () => {
    await placePractice(questions(3), { sectionId: "sec" });
    const els = ipc.upsertElements.mock.calls[0][0];
    const [a, b, c] = els;
    const under = (e: Element, dy: number) => ({ x: e.points[0].x + 40, y: e.points[0].y + (e.boxHeight ?? 0) + dy, width: 200, height: 60 });
    const ctx = findPracticeContext(under(a, 30), els)!;
    expect(ctx.elementId).toBe(a.id);
    expect(ctx.expectedAnswer).toBe("2x^{1}");
    expect(ctx.question).toContain("Differentiate x^2");
    // writing beneath the second question goes with the second, not the first
    expect(findPracticeContext(under(b, 30), els)!.elementId).toBe(b.id);
    // late in the answer room of question 2, still question 2 (question 3 is below)
    expect(findPracticeContext(under(b, 150), els)!.elementId).toBe(b.id);
    expect(findPracticeContext(under(c, 10), els)!.elementId).toBe(c.id);
    // above the first question, beside it, or with no practice boxes: none
    expect(findPracticeContext({ x: 100, y: 0, width: 50, height: 20 }, els)).toBeNull();
    expect(findPracticeContext({ x: 5000, y: 700, width: 50, height: 20 }, els)).toBeNull();
    expect(findPracticeContext(under(a, 30), [])).toBeNull();
    expect(findPracticeContext(under(a, 30), els.map((e) => ({ ...e, content: {} })))).toBeNull();
  });
});

describe("practice pagination and cleanup", () => {
  it("practice_paginates_by_page_height", async () => {
    const r = await placePractice(questions(20), { sectionId: "sec" });
    expect(r.pageIds.length).toBeGreaterThanOrEqual(5);
    expect(r.placed).toBe(20);
    const calls = ipc.upsertElements.mock.calls.map((c) => c[0]);
    expect(calls.flat()).toHaveLength(20);
    for (const els of calls) {
      for (const e of els) expect(e.points[0].y + (e.boxHeight ?? 0)).toBeLessThanOrEqual(PAGE_HEIGHT);
    }
    expect(createPage.mock.calls[1][1]).toMatch(/\(2\)$/);
    // a taller page holds more per page
    ipc.upsertElements.mockClear();
    const tall = await placePractice(questions(20), { sectionId: "sec", pageHeight: PAGE_HEIGHT * 3 });
    expect(tall.pageIds.length).toBeLessThan(r.pageIds.length);
  });

  it("practice_cleans_up_pages_on_failure", async () => {
    ipc.upsertElements.mockResolvedValueOnce().mockRejectedValueOnce(new Error("disk full"));
    await expect(placePractice(questions(20), { sectionId: "sec" })).rejects.toThrow("disk full");
    expect(createPage).toHaveBeenCalledTimes(2);
    expect(trash.mock.calls).toEqual([["page", "pg-1"], ["page", "pg-2"]]);
  });
});
