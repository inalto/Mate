// "Practice from this book": pick how many questions and of which kinds, preview what the AI
// wrote, then add them to a new page in the book.
import { useModal } from "./useModal";
import { useState } from "react";
import { useNavigate } from "react-router";
import {
  MAX_PRACTICE_QUESTIONS,
  QUESTION_TYPES,
  QUESTION_TYPE_LABEL,
  practiceGenerate,
  type PracticeQuestion,
  type QuestionType,
} from "../ipc/practice";
import type { Unit } from "../model/types";
import { placePractice } from "../practice/placePractice";
import { useNotebookStore } from "../stores/notebook";
import { showToast } from "./Toast";

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export default function PracticeDialog({ unit, onClose }: { unit: Unit; onClose(): void }) {
  useModal();
  const navigate = useNavigate();
  const [count, setCount] = useState(5);
  const [types, setTypes] = useState<QuestionType[]>([...QUESTION_TYPES]);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState<"generating" | "adding" | null>(null);
  const [questions, setQuestions] = useState<PracticeQuestion[] | null>(null);

  const clamped = Math.min(MAX_PRACTICE_QUESTIONS, Math.max(1, Math.round(count) || 1));
  const toggle = (t: QuestionType) =>
    setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

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
      showToast("This book has no section to put the questions in.");
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
      <div className="card dialog" role="dialog" aria-modal="true" aria-label="Practice from this book">
        <h2>Practice from this book</h2>
        {questions === null ? (
          <>
            <label className="field">
              <span className="field-label">Number of questions</span>
              <input
                className="input"
                type="number"
                min={1}
                max={MAX_PRACTICE_QUESTIONS}
                value={count}
                disabled={busy !== null}
                aria-label="Number of questions"
                onChange={(e) => setCount(Number(e.target.value))}
                onBlur={() => setCount(clamped)}
              />
            </label>
            <div className="field" role="group" aria-label="Question types">
              <span className="field-label">Question types</span>
              {QUESTION_TYPES.map((t) => (
                <label key={t}>
                  <input type="checkbox" checked={types.includes(t)} disabled={busy !== null} onChange={() => toggle(t)} />{" "}
                  {QUESTION_TYPE_LABEL[t]}
                </label>
              ))}
            </div>
            <label className="field">
              <span className="field-label">Anything else? (optional)</span>
              <textarea
                className="input"
                rows={2}
                maxLength={500}
                value={custom}
                disabled={busy !== null}
                aria-label="Extra instructions"
                placeholder="For example: focus on integration by parts"
                onChange={(e) => setCustom(e.target.value)}
              />
            </label>
            <p className="field-hint">Questions come from what the tutor has read in this book. The text is sent to your AI provider.</p>
            {busy === "generating" && <p role="status">Writing questions…</p>}
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null || types.length === 0}
                onClick={() => void generate()}
              >
                {busy === "generating" ? "Generating…" : "Generate"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="field-hint">{questions.length} {questions.length === 1 ? "question" : "questions"} ready.</p>
            <ol className="practice-preview" aria-label="Questions">
              {questions.map((q, i) => (
                <li key={i}>
                  <div>{q.problemText}</div>
                  {q.problemLatex && <code>{q.problemLatex}</code>}
                  <div className="field-hint">{QUESTION_TYPE_LABEL[q.questionType]}</div>
                </li>
              ))}
            </ol>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setQuestions(null)} disabled={busy !== null}>Back</button>
              <button type="button" className="btn btn-primary" onClick={() => void add()} disabled={busy !== null}>
                {busy === "adding" ? "Adding…" : "Add to a new page"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
