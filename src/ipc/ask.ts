import { invoke } from "@tauri-apps/api/core";

/** Longest question `tutor_ask` accepts (mirrors Rust `commands::ask::MAX_QUESTION_CHARS`). */
export const MAX_QUESTION_CHARS = 500;

/**
 * Ask the tutor about one recognised stroke group. Resolves with a short tutor-style answer;
 * rejects with a `RecognizeError` (`{kind, message}`, see src/ipc/recognize) when AI is off, the
 * key is rejected, the note hasn't been checked yet, etc.
 */
export const tutorAsk = (pageId: string, groupId: string, question: string): Promise<string> =>
  invoke("tutor_ask", { pageId, groupId, question });
