import { invoke } from "@tauri-apps/api/core";
import type { LearningEvent, Recognition, RecognitionInput, SearchHit, UpsertOutcome } from "../model/types";

/** Start / end markers of a matched term in `SearchHit.snippet` (Rust `storage::SNIPPET_OPEN/CLOSE`). */
export const SNIPPET_OPEN = "\u0002";
export const SNIPPET_CLOSE = "\u0003";

export const getRecognitions = (pageId: string): Promise<Recognition[]> =>
  invoke("get_recognitions", { pageId });

/**
 * Inserts or replaces the verdict of `(pageId, strokeGroupId)`; `code`/`kind` are computed in Rust.
 *
 * Contract: set `capturedAt = Date.now()` when the group's ink is captured, and make sure the
 * group's element writes were flushed before (the write-behind queue flushes within 150 ms). The
 * store answers `"stale"` and writes nothing when, at write time, any member element is missing,
 * erased, on another page or had its ink changed after `capturedAt`, or when a recognition of the
 * same or overlapping ink with a later `capturedAt` is already stored. Drop stale results quietly;
 * the next settle re-requests. Rejects only on invalid input (no elements, `capturedAt <= 0`).
 */
export const upsertRecognition = (rec: RecognitionInput): Promise<UpsertOutcome> =>
  invoke("upsert_recognition", { rec });

/** "Mark as correct" (or wrong): the user's call wins over the tutor's. */
export const setUserOverride = (pageId: string, strokeGroupId: string, correct: boolean): Promise<void> =>
  invoke("set_user_override", { pageId, strokeGroupId, correct });

/** Full-text search over recognised handwriting; odd input never errors, it just finds nothing. */
export const searchRecognition = (query: string, limit = 20): Promise<SearchHit[]> =>
  invoke("search_recognition", { query, limit });

export const recordLearningEvent = (ev: LearningEvent): Promise<void> => invoke("record_learning_event", { ev });

/** Splits a snippet into plain-text runs, flagging the matched ones (render them highlighted). */
export const snippetParts = (snippet: string): { text: string; match: boolean }[] => {
  const parts: { text: string; match: boolean }[] = [];
  let match = false;
  let text = "";
  for (const ch of snippet) {
    if (ch === SNIPPET_OPEN || ch === SNIPPET_CLOSE) {
      if (text) parts.push({ text, match });
      text = "";
      match = ch === SNIPPET_OPEN;
    } else {
      text += ch;
    }
  }
  if (text) parts.push({ text, match });
  return parts;
};
