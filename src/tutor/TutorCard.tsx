// The tutor card for one stroke group, shown next to the ink (never over it as a replacement):
// what was read (LaTeX via KaTeX, or the transcribed text), then the reveal ladder hint → "Why?"
// (explanation) → "Next step", plus "Mark as correct", "Ask" (a free question) and, for an
// equation, "Check locally" (an offline second opinion from the Compute Engine). A group that
// couldn't be checked shows the reason and "Try again". Rendered in screen space inside the pane's
// overlay clip, positioned from the group's page-unit bounds and clamped to the viewport.
import { useModal } from "../components/useModal";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { worldToScreen } from "../canvas/camera";
import { localCheck, localCheckMessage, looksLikeEquation } from "../math/cas";
import { renderLatex } from "../math/katex";
import type { EditorStore } from "../stores/editor";
import { groupState, noteDismissDown, useTutorUi, type PaneIndex } from "../stores/tutor";
import { MAX_QUESTION_CHARS } from "./ask";
import { useTutorViews } from "./useTutor";
import "../styles/tutor.css";

/** Card width and margins (screen px). */
const CARD_W = 300;
const GAP = 8;
const MARGIN = 8;
/** A group missing from the view this long after opening (erased, re-grouped) closes the card. */
export const MISSING_GRACE_MS = 600;

function Latex({ latex }: { latex: string }) {
  const html = useMemo(() => renderLatex(latex).html, [latex]);
  // KaTeX output (trust: false), not user HTML.
  return <div className="tutor-card-latex" dangerouslySetInnerHTML={{ __html: html }} />;
}

export default function TutorCard({ store, pane }: { store: EditorStore; pane: PaneIndex }) {
  const { t } = useTranslation();
  const card = useTutorUi((s) => (s.card?.pane === pane ? s.card : null));
  const view = useTutorViews((s) => s.views[pane]);
  const camera = store((s) => s.camera);
  const viewport = store((s) => s.viewport);
  const ui = useTutorUi.getState;
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [height, setHeight] = useState(0);
  /** The local check's message, for the card opening (`key`) and LaTeX it was run on. */
  const [local, setLocal] = useState<{ key: string; text: string | null } | null>(null);
  const open = card !== null && view.pageId === card.pageId;
  useModal(open);
  const g = open ? groupState(view, card.groupId) : null;
  const bounds = g?.bounds ?? card?.anchor;
  const rec = g?.recognition;

  // Esc or a press outside closes the card; that press does nothing else on the canvas.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        noteDismissDown();
        ui().closeCard();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") ui().closeCard();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ui]);

  // The page changed under the card, or its group is gone (after a short grace: a gesture's dot
  // being removed re-groups the ink for a moment): close it.
  const missing = !g?.bounds;
  useEffect(() => {
    if (!card) return;
    if (view.pageId !== card.pageId) {
      ui().closeCard();
      return;
    }
    if (!missing) return;
    const left = card.openedAt + MISSING_GRACE_MS - Date.now();
    if (left <= 0) {
      ui().closeCard();
      return;
    }
    const timer = setTimeout(() => {
      const c = ui().card;
      if (c?.seq === card.seq && !groupState(useTutorViews.getState().views[pane], c.groupId).bounds) ui().closeCard();
    }, left);
    return () => clearTimeout(timer);
  }, [card, view.pageId, missing, ui, pane]);

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
  }, [card, rec, unchecked, inFlight, local]);

  if (!open || !card || !g || !bounds) return null;
  const b = bounds;

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
    ? t("tutor.status.checking")
    : g.unchecked
      ? g.unchecked.reason
      : !rec
        ? t("tutor.status.unchecked")
        : rec.illegible
          ? t("tutor.status.illegible")
          : rec.correct === true
            ? rec.userOverride
              ? t("tutor.status.markedCorrect")
              : t("tutor.status.correct")
            : rec.correct === false
              ? t("tutor.status.wrong")
              : t("tutor.status.unfinished");
  const canAsk = !!rec && !g.inFlight;
  const checkable = !!rec && !rec.illegible && looksLikeEquation(rec.latex);
  const localKey = `${card.seq}:${rec?.latex ?? ""}`;
  const localShown = local?.key === localKey ? local : null;
  const runLocalCheck = () => {
    if (!rec) return;
    const key = localKey;
    setLocal({ key, text: null });
    void localCheck(rec.latex).then(
      (r) => setLocal((cur) => (cur?.key === key ? { key, text: localCheckMessage(r) } : cur)),
      () => setLocal((cur) => (cur?.key === key ? { key, text: t("math.check.undecided", { reason: t("math.check.reasons.failed") }) } : cur)),
    );
  };
  const tooLong = [...card.question].length > MAX_QUESTION_CHARS;
  const canSubmit = canAsk && !card.busy && !tooLong && card.question.trim() !== "";

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
          {t("tutor.title")}
        </h2>
        <button type="button" className="btn btn-ghost tutor-card-close" aria-label={t("common.close")} onClick={() => ui().closeCard()}>
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
          {t("tutor.tryAgain")}
        </button>
      ) : null}

      {showHint ? (
        <section aria-label={t("tutor.hint")}>
          <p className="tutor-card-hint">{rec!.hint}</p>
        </section>
      ) : null}
      {rec?.explanation && card.step >= 1 ? (
        <section aria-label={t("tutor.why")}>
          <p>{rec.explanation}</p>
        </section>
      ) : null}
      {rec?.nextSteps && card.step >= 2 ? (
        <section aria-label={t("tutor.nextStep")}>
          <p>{rec.nextSteps}</p>
        </section>
      ) : null}

      <div className="tutor-card-actions">
        {rec?.explanation && card.step < 1 ? (
          <button type="button" className="btn" onClick={() => ui().revealWhy()}>
            {t("tutor.whyButton")}
          </button>
        ) : null}
        {rec?.nextSteps && card.step >= (rec.explanation ? 1 : 0) && card.step < 2 ? (
          <button type="button" className="btn" onClick={() => ui().revealNext()}>
            {t("tutor.nextStep")}
          </button>
        ) : null}
        {rec && rec.correct !== true && !rec.illegible ? (
          <button type="button" className="btn" onClick={() => void ui().markCorrect()}>
            {t("tutor.markCorrect")}
          </button>
        ) : null}
        {!card.asking ? (
          <button type="button" className="btn" onClick={() => ui().openAsk()}>
            {t("tutor.ask.button")}
          </button>
        ) : null}
        {checkable ? (
          <button type="button" className="btn" disabled={localShown?.text === null} onClick={runLocalCheck}>
            {t("tutor.checkLocally")}
          </button>
        ) : null}
      </div>

      {localShown ? (
        <p className="tutor-card-local muted" role="status" aria-live="polite">
          {localShown.text ?? t("tutor.checkingLocally")}
        </p>
      ) : null}

      {card.asking ? (
        <form
          className="tutor-card-ask"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) void ui().submitAsk();
          }}
        >
          <label htmlFor={`${titleId}-q`}>{t("tutor.ask.label")}</label>
          <textarea
            id={`${titleId}-q`}
            className="input"
            rows={3}
            autoFocus
            value={card.question}
            placeholder={t("tutor.ask.placeholder")}
            onChange={(e) => ui().setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (canSubmit) void ui().submitAsk();
              }
            }}
          />
          {tooLong ? <p className="tutor-card-error">{t("tutor.ask.tooLong", { max: MAX_QUESTION_CHARS })}</p> : null}
          {!canAsk ? <p className="muted">{g.inFlight ? t("tutor.ask.checkingFirst") : t("tutor.ask.needsCheck")}</p> : null}
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {card.busy ? t("tutor.ask.asking") : t("tutor.ask.button")}
          </button>
        </form>
      ) : null}

      {card.answer ? (
        <section aria-label={t("tutor.ask.answer")} className="tutor-card-answer" aria-live="polite">
          <p>{card.answer}</p>
        </section>
      ) : null}
    </div>
  );
}
