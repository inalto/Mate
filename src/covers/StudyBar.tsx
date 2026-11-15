// The study bar of one pane, docked at the pane's bottom edge while "Test me" runs: "n of total",
// Reveal while a cover is asked, Knew it and Missed once it shows, End test; at the end the score,
// Repeat missed and Done. It looks like the replay bar (the two never show at once) and owns its
// keys the same way: Space reveals on release unless the pointer went down meanwhile (the pan
// hold), → or 1 Knew it, ← or 2 Missed, Escape ends; only while its pane is focused and the key is
// aimed at the page, never while a dialog or menu is open or a box is being edited.
import { X } from "@phosphor-icons/react";
import { useEffect, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useStore, type StoreApi } from "zustand";
import { aimedAtPage, isTypingTarget } from "../keys/shortcuts";
import { formatElapsed } from "../speech/elapsed";
import { useChromeStore } from "../stores/chrome";
import type { EditorStore } from "../stores/editor";
import { getFocusedEditor } from "../stores/focusedEditor";
import type { RunState } from "./run";
import "../recording/recording.css";
import "./covers.css";

interface Props {
  store: EditorStore;
  run: StoreApi<RunState>;
}

/** Keys of the bar of `store`'s pane; only while that pane is focused and nothing else owns them. */
function useStudyKeys(store: EditorStore, run: StoreApi<RunState>, bar: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    let spaceDown = false;
    let pointerDown = false;
    /** The pointer went down while Space was held: a pan, not a reveal. */
    let panned = false;
    const free = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return false;
      if (!aimedAtPage(e.target, bar.current?.closest(".pane") ?? null)) return false;
      if (getFocusedEditor() !== store || useChromeStore.getState().modalDepth > 0) return false;
      const s = store.getState();
      return s.editingId === null && !s.presenting && run.getState().phase !== "idle";
    };
    const onKey = (e: KeyboardEvent) => {
      if (!free(e)) return;
      const r = run.getState();
      if (e.key === " " || e.code === "Space") {
        // Left to the pan hold; the reveal happens on release.
        if (!e.repeat) {
          spaceDown = true;
          panned = pointerDown;
        }
        return;
      }
      // With a selection, the arrows and Escape keep their editor meaning.
      const selected = store.getState().selection.size > 0;
      let act: (() => void) | null = null;
      if (r.phase === "revealed" && (e.key === "1" || (e.key === "ArrowRight" && !selected))) act = () => r.answer(true);
      else if (r.phase === "revealed" && (e.key === "2" || (e.key === "ArrowLeft" && !selected))) act = () => r.answer(false);
      else if (e.key === "Escape" && !selected) act = r.end;
      if (!act) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      act();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " && e.code !== "Space") return;
      const reveal = spaceDown && !panned;
      spaceDown = false;
      if (!reveal || !free(e) || run.getState().phase !== "asking") return;
      e.preventDefault(); // a focused bar button must not also activate on this release
      run.getState().reveal();
    };
    const onDown = () => {
      pointerDown = true;
      if (spaceDown) panned = true;
    };
    const onUp = () => {
      pointerDown = false;
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [store, run, bar]);
}

function TextButton({ label, primary, onClick }: { label: string; primary?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={primary ? "tb-btn study-primary" : "tb-btn"} onClick={onClick}>
      <span className="replay-label">{label}</span>
    </button>
  );
}

function Bar({ store, run }: Props) {
  const { t } = useTranslation();
  const phase = useStore(run, (s) => s.phase);
  const index = useStore(run, (s) => s.index);
  const total = useStore(run, (s) => s.queue.length);
  const answers = useStore(run, (s) => s.answers);
  const startedAt = useStore(run, (s) => s.startedAt);
  const endedAt = useStore(run, (s) => s.endedAt);
  const r = run.getState();
  const ref = useRef<HTMLDivElement>(null);
  useStudyKeys(store, run, ref);
  const known = answers.filter((a) => a.knew).length;
  const missed = answers.length - known;
  return (
    <div ref={ref} className="selection-bar replay-bar study-bar" role="toolbar" aria-label={t("covers.testMe")}>
      {phase === "done" ? (
        <>
          <span className="study-score">{t("covers.run.score", { known, total: answers.length, time: formatElapsed((endedAt ?? startedAt) - startedAt) })}</span>
          <div className="replay-controls">
            {missed > 0 && <TextButton label={t("covers.run.repeatMissed")} onClick={() => r.repeatMissed()} />}
            <TextButton label={t("covers.run.done")} primary onClick={() => r.end()} />
          </div>
        </>
      ) : (
        <>
          <span className="replay-time">{t("covers.run.progress", { n: index + 1, total })}</span>
          <div className="replay-controls">
            {phase === "asking" ? (
              <TextButton label={t("covers.run.reveal")} primary onClick={() => r.reveal()} />
            ) : (
              <>
                <TextButton label={t("covers.run.knew")} primary onClick={() => r.answer(true)} />
                <TextButton label={t("covers.run.missed")} onClick={() => r.answer(false)} />
              </>
            )}
            <button type="button" className="tb-btn" aria-label={t("covers.run.end")} title={t("covers.run.end")} onClick={() => r.end()}>
              <X size={18} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The study bar of `store`'s pane; nothing while no run is going or the pane presents. */
export default function StudyBar({ store, run }: Props) {
  const active = useStore(run, (s) => s.phase !== "idle");
  const presenting = store((s) => s.presenting !== null);
  return active && !presenting ? <Bar store={store} run={run} /> : null;
}
