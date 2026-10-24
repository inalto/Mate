import type { TKey } from "../i18n";
import { invokeAi } from "./aiCall";

export const QUESTION_TYPES = ["multiple-choice", "multi-select", "true-false", "fill-in-blank", "short-answer"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** Catalogue key of each question type's name. */
export const QUESTION_TYPE_LABEL_KEY = {
  "multiple-choice": "practice.types.multipleChoice",
  "multi-select": "practice.types.multiSelect",
  "true-false": "practice.types.trueFalse",
  "fill-in-blank": "practice.types.fillInBlank",
  "short-answer": "practice.types.shortAnswer",
} as const satisfies Record<QuestionType, TKey>;

/** Most questions one request (and one practice page) may hold. */
export const MAX_PRACTICE_QUESTIONS = 20;

/** Rust `ai::practice::PracticeQuestion`. */
export interface PracticeQuestion {
  problemText: string;
  problemLatex: string;
  questionType: QuestionType;
  expectedAnswer: string;
  solutionLatex: string;
}

/**
 * Questions made from the recognised text of the whole book. Needs AI consent and a key: rejects
 * with a readable message otherwise (or when nothing in the book has been recognised yet).
 */
export const practiceGenerate = (
  unitId: string,
  count: number,
  types: QuestionType[],
  customPrompt?: string,
): Promise<PracticeQuestion[]> =>
  invokeAi("practice_generate", { unitId, count, types, customPrompt: customPrompt?.trim() || null });
