// Toolbar button for the recall covers of the focused page: a count badge, and a menu to reveal,
// cover or remove them all, see the last test's score, and start a test. Absent when the page has
// no live cover. While a test is asking, the actions that would end or give it away are disabled.
import { Eye, EyeClosed, EyeSlash, GraduationCap, Trash } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createStore, useStore, type StoreApi } from "zustand";
import ConfirmDialog from "../components/ConfirmDialog";
import DockPopover from "../components/DockPopover";
import { useDismiss } from "../components/useDismiss";
import { recallPageStats } from "../ipc/recall";
import type { RecallRun } from "../model/types";
import { useFocusedEditor } from "../stores/focusedEditor";
import { isLocked } from "../model/content";
import { coversOf } from "./cover";
import { runOf } from "./panes";
import { isActive, type RunState } from "./run";
import "./covers.css";

/** Stand-in run for an editor that is no pane's: never asking. */
const NO_RUN = createStore<Pick<RunState, "phase">>(() => ({ phase: "idle" }));

interface Props {
  /** Starts a test run on the page's covers (default: the focused pane's run). */
  onTest?: () => void;
}

export default function CoversMenu({ onTest }: Props) {
  const { t, i18n } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // undefined: not known yet (or the lookup failed); null: never tested.
  const [last, setLast] = useState<RecallRun | null | undefined>(undefined);
  const elements = ed((s) => s.elements);
  const pageId = ed((s) => s.pageId);
  const covers = useMemo(() => coversOf(elements.values()), [elements]);
  const count = covers.length;
  // Locked covers stay when the rest are removed, so the dialog counts only the others.
  const locked = covers.filter(isLocked).length;
  const removable = count - locked;
  const run = runOf(ed);
  // Reveal all would show every answer, Cover all and Remove all would pull the test from under it.
  const testing = useStore((run ?? NO_RUN) as StoreApi<Pick<RunState, "phase">>, isActive);
  useDismiss(ref, open, () => setOpen(false));

  // The score changes after every run, so it is read again each time the menu opens.
  useEffect(() => {
    if (!open || !pageId) return;
    let stale = false;
    recallPageStats(pageId).then(
      (stats) => {
        if (!stale) setLast(stats.last);
      },
      (err) => console.error("reading the last test failed", err),
    );
    return () => {
      stale = true;
    };
  }, [open, pageId]);

  if (count === 0) return null;
  const pick = (run: () => void) => () => {
    run();
    setOpen(false);
  };
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className="tb-btn covers-btn"
        aria-label={t("covers.menu")}
        title={t("covers.menu")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setLast(undefined); // the old score is dropped until the new one arrives
          setOpen((o) => !o);
        }}
      >
        <EyeSlash size={18} aria-hidden="true" />
        <span className="covers-count" aria-hidden="true">
          {count}
        </span>
      </button>
      {open && (
        <DockPopover anchorRef={ref}>
          <div className="tb-popover tb-menu" role="menu">
            <button type="button" role="menuitem" className="tb-menu-item" disabled={testing} onClick={pick(() => ed.getState().revealAll())}>
              <Eye size={16} aria-hidden="true" /> {t("covers.revealAll")}
            </button>
            <button type="button" role="menuitem" className="tb-menu-item" disabled={testing} onClick={pick(() => ed.getState().coverAll())}>
              <EyeClosed size={16} aria-hidden="true" /> {t("covers.coverAll")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="tb-menu-item"
              disabled={removable === 0 || testing}
              onClick={() => {
                setOpen(false);
                setConfirming(true);
              }}
            >
              <Trash size={16} aria-hidden="true" /> {t("covers.removeAll")}
            </button>
            {last !== undefined && (
              <div className="covers-last">
                {last ? t("covers.lastTest", { known: last.known, total: last.total, date: new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short" }).format(new Date(last.at)) }) : t("covers.notTested")}
              </div>
            )}
            <button type="button" role="menuitem" className="tb-menu-item" disabled={testing} onClick={pick(() => (onTest ? onTest() : run?.getState().start()))}>
              <GraduationCap size={16} aria-hidden="true" /> {t("covers.testMe")}
            </button>
          </div>
        </DockPopover>
      )}
      {confirming && (
        <ConfirmDialog
          title={t("covers.removeConfirmTitle")}
          confirmLabel={t("covers.removeAll")}
          onConfirm={() => {
            ed.getState().removeAllCovers();
            setConfirming(false);
          }}
          onCancel={() => setConfirming(false)}
        >
          {t("covers.removeConfirmBody", { count: removable })}
          {locked > 0 && <> {t("covers.removeLockedStay", { count: locked })}</>}
        </ConfirmDialog>
      )}
    </div>
  );
}
