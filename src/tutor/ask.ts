// "Ask" in the tutor card: a free question about one recognised group, answered by the provider
// in Rust (`tutor_ask`). Failures show a toast with the same sentences as checking errors.
import { showToast } from "../components/Toast";
import { MAX_QUESTION_CHARS, tutorAsk } from "../ipc/ask";
import i18n from "../i18n";
import { isRecognizeError, recognizeErrorText } from "../ipc/recognize";

export { MAX_QUESTION_CHARS };

export interface AskDeps {
  ask: typeof tutorAsk;
  toast: (message: string) => void;
}

const defaultDeps: AskDeps = { ask: tutorAsk, toast: (m) => showToast(m) };

/** The trimmed question, or null when it is empty or over 500 characters. */
export function cleanQuestion(q: string): string | null {
  const t = q.trim();
  return t.length === 0 || [...t].length > MAX_QUESTION_CHARS ? null : t;
}

/** The answer, or null after showing a toast when the question can't be answered. */
export async function askAboutGroup(pageId: string, groupId: string, question: string, deps: AskDeps = defaultDeps): Promise<string | null> {
  const q = cleanQuestion(question);
  if (q === null) {
    deps.toast(question.trim() ? i18n.t("tutor.ask.tooLong", { max: MAX_QUESTION_CHARS }) : i18n.t("tutor.ask.empty"));
    return null;
  }
  try {
    return await deps.ask(pageId, groupId, q);
  } catch (e) {
    deps.toast(isRecognizeError(e) ? recognizeErrorText(e) : i18n.t("tutor.ask.failed"));
    return null;
  }
}
