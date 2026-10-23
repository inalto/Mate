import { invoke } from "@tauri-apps/api/core";

export const QUESTION_TYPES = ["multiple-choice", "multi-select", "true-false", "fill-in-blank", "short-answer"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  "multiple-choice": "Multiple choice",
  "multi-select": "Multi-select",
  "true-false": "True / false",
  "fill-in-blank": "Fill in the blank",
  "short-answer": "Short answer",
};

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
  invoke("practice_generate", { unitId, count, types, customPrompt: customPrompt?.trim() || null });
