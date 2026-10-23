// The tutor card for one stroke group, shown next to the ink (never over it as a replacement):
// what was read (LaTeX via KaTeX, or the transcribed text), then the reveal ladder hint → "Why?"
// (explanation) → "Next step", plus "Mark as correct" and "Ask" (a free question). A group that
// couldn't be checked shows the reason and "Try again". Rendered in screen space inside the pane's
// overlay clip, positioned from the group's page-unit bounds and clamped to the viewport.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { worldToScreen } from "../canvas/camera";
import { useDismiss } from "../components/useDismiss";
import { renderLatex } from "../math/katex";
import type { EditorStore } from "../stores/editor";
import { groupState, useTutorUi, type PaneIndex } from "../stores/tutor";
import { MAX_QUESTION_CHARS } from "./ask";
import { useTutorViews } from "./useTutor";
import "../styles/tutor.css";

/** Card width and margins (screen px). */
const CARD_W = 300;
const GAP = 8;
const MARGIN = 8;

function Latex({ latex }: { latex: string }) {
  const html = useMemo(() => renderLatex(latex).html, [latex]);
  // KaTeX output (trust: false), not user HTML.
  return <div className="tutor-card-latex" dangerouslySetInnerHTML={{ __html: html }} />;
}

export default function TutorCard({ store, pane }: { store: EditorStore; pane: PaneIndex }) {
  const card = useTutorUi((s) => (s.card?.pane === pane ? s.card : null));
  const view = useTutorViews((s) => s.views[pane]);
  const camera = store((s) => s.camera);
  const viewport = store((s) => s.viewport);
  const ui = useTutorUi.getState;
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [height, setHeight] = useState(0);
  const open = card !== null && view.pageId === card.pageId;
  const g = open ? groupState(view, card.groupId) : null;
  const rec = g?.recognition;

  useDismiss(ref, open, () => ui().closeCard());

  // The page changed under the card, or its group is gone: close it.
  useEffect(() => {
    if (card && (view.pageId !== card.pageId || !g?.bounds)) ui().closeCard();
  }, [card, view.pageId, g?.bounds, ui]);

  // Focus moves into the card when it opens and returns where it was when it closes.
  const seq = card?.seq;
  const asking = card?.asking ?? false;
  useEffect(() => {
    if (seq === undefined) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const target = el?.querySelector<HTMLElement>(asking ? "textarea" : "button, textarea") ?? el;
    target?.focus();
    return () => {
      if (prev && prev.isConnected && typeof prev.focus === "function") prev.focus();
    };
    // Only on (re)open; later `asking` changes are handled by the textarea's autoFocus.
  }, [seq]); // eslint-disable-line react-hooks/exhaustive-deps

  const showHint = !!rec?.hint && rec.correct !== true;
  useEffect(() => {
    if (open && showHint) ui().noteHintShown();
  }, [open, showHint, seq, ui]);

  // Measure the card whenever its content changes (for clamping it inside the pane).
  const unchecked = g?.unchecked;
  const inFlight = g?.inFlight;
  useLayoutEffect(() => {
    if (ref.current) setHeight(ref.current.offsetHeight);
  }, [card, rec, unchecked, inFlight]);

  if (!open || !card || !g?.bounds) return null;
  const b = g.bounds;

  // Below the group, left-aligned with it; above when there is no room; always inside the pane.
  const below = worldToScreen(camera, { x: b.x, y: b.y + b.height });
  const above = worldToScreen(camera, { x: b.x, y: b.y });
  let top = below.y + GAP;
  if (height > 0 && top + height > viewport.height - MARGIN && above.y - GAP - height >= MARGIN) top = above.y - GAP - height;
  top = Math.max(MARGIN, Math.min(top, viewport.height - MARGIN - height));
  const width = Math.min(CARD_W, Math.max(160, viewport.width - 2 * MARGIN));
  const left = Math.max(MARGIN, Math.min(below.x, viewport.width - MARGIN - width));

  const transcription = rec?.transcription?.text?.trim();
  const status = g.inFlight
    ? "Checking this note…"
    : g.unchecked
      ? g.unchecked.reason
      : !rec
        ? "This note hasn't been checked yet."
        : rec.illegible
          ? "This note couldn't be read."
          : rec.correct === true
            ? rec.userOverride
              ? "You marked this as correct."
              : "This looks right."
            : rec.correct === false
              ? "Something here needs another look."
              : "This looks unfinished.";
  const canAsk = !!rec && !g.inFlight;
  const tooLong = [...card.question].length > MAX_QUESTION_CHARS;

  return (
    <div
      ref={ref}
      className="tutor-card card"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="tutor-card"
      style={{ left, top, width }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="tutor-card-head">
        <h2 id={titleId} className="tutor-card-title">
          Tutor
        </h2>
        <button type="button" className="btn btn-ghost tutor-card-close" aria-label="Close" onClick={() => ui().closeCard()}>
          ×
        </button>
      </div>

      {rec && !rec.illegible && rec.latex.trim() ? <Latex latex={rec.latex} /> : null}
      {rec && !rec.illegible && !rec.latex.trim() && transcription ? (
        <p className={rec.transcription?.kind === "code" ? "tutor-card-code" : "tutor-card-text"}>{transcription}</p>
      ) : null}

      <p className="tutor-card-status muted" role="status">
        {status}
      </p>

      {g.unchecked && !g.inFlight ? (
        <button type="button" className="btn" onClick={() => ui().retry()}>
          Try again
        </button>
      ) : null}

      {showHint ? (
        <section aria-label="Hint">
          <p className="tutor-card-hint">{rec!.hint}</p>
        </section>
      ) : null}
      {rec?.explanation && card.step >= 1 ? (
        <section aria-label="Why">
          <p>{rec.explanation}</p>
        </section>
      ) : null}
      {rec?.nextSteps && card.step >= 2 ? (
        <section aria-label="Next step">
          <p>{rec.nextSteps}</p>
        </section>
      ) : null}

      <div className="tutor-card-actions">
        {rec?.explanation && card.step < 1 ? (
          <button type="button" className="btn" onClick={() => ui().revealWhy()}>
            Why?
          </button>
        ) : null}
        {rec?.nextSteps && card.step >= (rec.explanation ? 1 : 0) && card.step < 2 ? (
          <button type="button" className="btn" onClick={() => ui().revealNext()}>
            Next step
          </button>
        ) : null}
        {rec && rec.correct !== true && !rec.illegible ? (
          <button type="button" className="btn" onClick={() => void ui().markCorrect()}>
            Mark as correct
          </button>
        ) : null}
        {!card.asking ? (
          <button type="button" className="btn" onClick={() => ui().openAsk()}>
            Ask
          </button>
        ) : null}
      </div>

      {card.asking ? (
        <form
          className="tutor-card-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void ui().submitAsk();
          }}
        >
          <label htmlFor={`${titleId}-q`}>Your question</label>
          <textarea
            id={`${titleId}-q`}
            className="input"
            rows={3}
            autoFocus
            value={card.question}
            placeholder="What would you like to know about this line?"
            onChange={(e) => ui().setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void ui().submitAsk();
              }
            }}
          />
          {tooLong ? <p className="tutor-card-error">Keep the question under {MAX_QUESTION_CHARS} characters.</p> : null}
          {!canAsk ? <p className="muted">{g.inFlight ? "Checking this note first…" : "This note needs to be checked before you can ask about it."}</p> : null}
          <button type="submit" className="btn btn-primary" disabled={!canAsk || card.busy || tooLong || card.question.trim() === ""}>
            {card.busy ? "Asking…" : "Ask"}
          </button>
        </form>
      ) : null}

      {card.answer ? (
        <section aria-label="Answer" className="tutor-card-answer" aria-live="polite">
          <p>{card.answer}</p>
        </section>
      ) : null}
    </div>
  );
}
