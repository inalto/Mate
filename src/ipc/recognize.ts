import { invoke } from "@tauri-apps/api/core";
import type { Verdict } from "../model/types";

/** One context line (Rust `commands::recognize::ContextLineDto`). */
export interface RecognizeContextLine {
  content: string;
  isNew: boolean;
}

export interface RecognizeRequest {
  pageId: string;
  strokeGroupId: string;
  /** PNG bytes, base64 without a data-URL prefix. */
  imagePngBase64: string;
  context: RecognizeContextLine[];
  difficulty?: "intermediate" | "advanced";
  practice?: { question: string; expectedAnswer: string };
}

export type RecognizeErrorKind = "disabled" | "auth" | "rateLimited" | "network" | "invalidResponse" | "rejected" | "internal";

/** What `recognize_group` rejects with; `message` is a sentence ready for the UI. */
export interface RecognizeError {
  kind: RecognizeErrorKind;
  message: string;
}

export const isRecognizeError = (e: unknown): e is RecognizeError =>
  typeof e === "object" && e !== null && typeof (e as RecognizeError).kind === "string" && typeof (e as RecognizeError).message === "string";

/** Checks one stroke group with the configured provider (the key stays in Rust). */
export const recognizeGroup = (req: RecognizeRequest): Promise<Verdict> => invoke("recognize_group", { req });
