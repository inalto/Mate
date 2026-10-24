import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";
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

/** The verdict plus the provider and model that produced it (Rust `RecognizeResult`). */
export type RecognizeResult = Verdict & { provider: string; model: string };

export type RecognizeErrorKind =
  | "disabled"
  | "badAddress"
  | "noKey"
  | "noAddress"
  | "cannotListModels"
  | "unreachable"
  | "auth"
  | "billing"
  | "unknownModel"
  | "rateLimited"
  | "network"
  | "invalidResponse"
  | "refused"
  | "truncated"
  | "rejected"
  | "internal";

/**
 * What `recognize_group` and the AI setup commands (Rust `AiSetupError`) reject with; `message`
 * is the English sentence, `detail` (setup errors only) what the sentence names: a provider label,
 * or a label and address.
 */
export interface RecognizeError {
  kind: RecognizeErrorKind;
  message: string;
  detail?: string;
}

export const isRecognizeError = (e: unknown): e is RecognizeError =>
  typeof e === "object" && e !== null && typeof (e as RecognizeError).kind === "string" && typeof (e as RecognizeError).message === "string";

/** Kinds whose Rust sentence ends with a technical detail in brackets: "… (timed out)." */
const WITH_DETAIL: ReadonlySet<string> = new Set(["network", "invalidResponse", "rejected"]);
/** Kinds whose detail comes in its own field. */
const WITH_DETAIL_FIELD: ReadonlySet<string> = new Set(["cannotListModels", "unreachable"]);
const DETAIL = /\(([^()]*)\)\.?$/;

/**
 * The sentence to show for a structured AI error, in the interface language (`errors.ai.<kind>`).
 * The technical detail Rust puts in brackets is kept; an internal error is shown as Rust wrote it.
 */
export function recognizeErrorText(e: RecognizeError): string {
  if (e.kind === "internal" || !i18n.exists(`errors.ai.${e.kind}`)) return e.message;
  const kind = e.kind as Exclude<RecognizeErrorKind, "internal">;
  if (WITH_DETAIL_FIELD.has(kind)) return e.detail ? i18n.t(`errors.ai.${kind}`, { detail: e.detail }) : e.message;
  if (!WITH_DETAIL.has(kind)) return i18n.t(`errors.ai.${kind}`);
  const detail = DETAIL.exec(e.message)?.[1];
  return detail ? i18n.t(`errors.ai.${kind}`, { detail }) : e.message;
}

/** Checks one stroke group with the configured provider (the key stays in Rust). */
export const recognizeGroup = (req: RecognizeRequest): Promise<RecognizeResult> => invoke("recognize_group", { req });
