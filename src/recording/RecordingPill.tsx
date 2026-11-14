// The top bar's recording status: a red dot and the elapsed time while a recording runs (its press
// opens the same menu as the record button), and the banner for time lost while the app was in the
// background, which stays until dismissed.
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDismiss } from "../components/useDismiss";
import { formatElapsed } from "../speech/elapsed";
import { isLive } from "./controls";
import { RecordingMenu } from "./RecordingMenu";
import { useRecordingLabel } from "./useRecordingLabel";
import { useRecording } from "./session";
import "./recording.css";

export function RecordingPill() {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const phase = useRecording((s) => s.phase);
  const label = useRecordingLabel();
  const live = isLive(phase);
  useDismiss(ref, open && live, () => setOpen(false));
  if (phase === "idle") return null;
  return (
    <div ref={ref} className="menu-anchor">
      <button
        type="button"
        className={phase === "paused" ? "rec-pill paused" : "rec-pill"}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open && live}
        aria-busy={!live || undefined}
        disabled={!live}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="rec-dot" aria-hidden="true" />
        <span aria-hidden="true">{label}</span>
      </button>
      {open && live && <RecordingMenu onDone={() => setOpen(false)} />}
    </div>
  );
}

export function RecordingGapBanner() {
  const { t } = useTranslation();
  const lostMs = useRecording((s) => s.lostMs);
  if (lostMs === null) return null;
  return (
    <div className="rec-gap-banner" role="status">
      <span className="grow">{t("recording.gap", { time: formatElapsed(lostMs) })}</span>
      <button type="button" className="btn" onClick={() => useRecording.getState().dismissGap()}>
        {t("common.dismiss")}
      </button>
    </div>
  );
}
