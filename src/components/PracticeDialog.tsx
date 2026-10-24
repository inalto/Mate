// "Practice from this book": pick how many questions and of which kinds, preview what the AI
// wrote, then add them to a new page in the book.
import { useModal } from "./useModal";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../i18n";
import { useNavigate } from "react-router";
import {
  MAX_PRACTICE_QUESTIONS,
  QUESTION_TYPES,
  QUESTION_TYPE_LABEL_KEY,
  practiceGenerate,
  type PracticeQuestion,
  type QuestionType,
} from "../ipc/practice";
import type { Unit } from "../model/types";
import { placePractice } from "../practice/placePractice";
import { useNotebookStore } from "../stores/notebook";
import { showToast } from "./Toast";

const message = (err: unknown): string => errorMessage(err);

export default function PracticeDialog({ unit, onClose }: { unit: Unit; onClose(): void }) {
  useModal();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [count, setCount] = useState(5);
  const [types, setTypes] = useState<QuestionType[]>([...QUESTION_TYPES]);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState<"generating" | "adding" | null>(null);
  const [questions, setQuestions] = useState<PracticeQuestion[] | null>(null);

  const clamped = Math.min(MAX_PRACTICE_QUESTIONS, Math.max(1, Math.round(count) || 1));
  const toggle = (q: QuestionType) =>
    setTypes((cur) => (cur.includes(q) ? cur.filter((x) => x !== q) : [...cur, q]));

  const generate = async () => {
    setBusy("generating");
    try {
      setQuestions(await practiceGenerate(unit.id, clamped, types, custom));
    } catch (err) {
      showToast(message(err));
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!questions) return;
    const { sections } = useNotebookStore.getState().tree;
    const section = sections.filter((s) => s.unitId === unit.id).sort((a, b) => a.orderIndex - b.orderIndex)[0];
    if (!section) {
      showToast(t("practice.noSection"));
      return;
    }
    setBusy("adding");
    try {
      const { pageIds } = await placePractice(questions, { sectionId: section.id });
      onClose();
      if (pageIds[0]) navigate(`/edit/${pageIds[0]}`);
    } catch (err) {
      showToast(message(err));
      setBusy(null);
    }
  };

  return (
    <div className="backdrop">
      <div className="card dialog" role="dialog" aria-modal="true" aria-label={t("practice.title")}>
        <h2>{t("practice.title")}</h2>
        {questions === null ? (
          <>
            <label className="field">
              <span className="field-label">{t("practice.count")}</span>
              <input
                className="input"
                type="number"
                min={1}
                max={MAX_PRACTICE_QUESTIONS}
                value={count}
                disabled={busy !== null}
                aria-label={t("practice.count")}
                onChange={(e) => setCount(Number(e.target.value))}
                onBlur={() => setCount(clamped)}
              />
            </label>
            <div className="field" role="group" aria-label={t("practice.types.label")}>
              <span className="field-label">{t("practice.types.label")}</span>
              {QUESTION_TYPES.map((q) => (
                <label key={q}>
                  <input type="checkbox" checked={types.includes(q)} disabled={busy !== null} onChange={() => toggle(q)} />{" "}
                  {t(QUESTION_TYPE_LABEL_KEY[q])}
                </label>
              ))}
            </div>
            <label className="field">
              <span className="field-label">{t("practice.extra")}</span>
              <textarea
                className="input"
                rows={2}
                maxLength={500}
                value={custom}
                disabled={busy !== null}
                aria-label={t("practice.extraLabel")}
                placeholder={t("practice.extraPlaceholder")}
                onChange={(e) => setCustom(e.target.value)}
              />
            </label>
            <p className="field-hint">{t("practice.privacy")}</p>
            {busy === "generating" && <p role="status">{t("practice.writing")}</p>}
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null || types.length === 0}
                onClick={() => void generate()}
              >
                {busy === "generating" ? t("practice.generating") : t("practice.generate")}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="field-hint">{t("practice.ready", { count: questions.length })}</p>
            <ol className="practice-preview" aria-label={t("practice.questions")}>
              {questions.map((q, i) => (
                <li key={i}>
                  <div>{q.problemText}</div>
                  {q.problemLatex && <code>{q.problemLatex}</code>}
                  <div className="field-hint">{t(QUESTION_TYPE_LABEL_KEY[q.questionType])}</div>
                </li>
              ))}
            </ol>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setQuestions(null)} disabled={busy !== null}>{t("common.back")}</button>
              <button type="button" className="btn btn-primary" onClick={() => void add()} disabled={busy !== null}>
                {busy === "adding" ? t("practice.adding") : t("practice.add")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
