// Dictation's own wording for the speech commands' structured errors (`speech.errors.<kind>`);
// kinds it does not word (billing, rate limits, models, addresses) use the tutor's sentences.
import i18n, { errorMessage } from "../i18n";
import { isRecognizeError, recognizeErrorText } from "../ipc/recognize";

const PLAIN = ["disabled", "auth", "noKey", "noAddress"] as const;
/** Kinds whose Rust sentence ends with a technical detail in brackets: "… (timed out)." */
const WITH_DETAIL = ["network", "rejected", "invalidResponse"] as const;
const DETAIL = /\(([^()]*)\)\.?$/;

const isOneOf = <T extends string>(list: readonly T[], kind: string): kind is T => (list as readonly string[]).includes(kind);

/** The sentence for an error from a speech command, in the interface language. */
export function speechErrorText(e: unknown): string {
  if (!isRecognizeError(e)) return errorMessage(e);
  if (isOneOf(PLAIN, e.kind)) return i18n.t(`speech.errors.${e.kind}`);
  if (isOneOf(WITH_DETAIL, e.kind)) {
    const detail = DETAIL.exec(e.message)?.[1] ?? e.message;
    return i18n.t(`speech.errors.${e.kind}`, { detail });
  }
  return recognizeErrorText(e);
}
