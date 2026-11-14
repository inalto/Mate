// Toolbar button: press to record the lecture on the focused page; while recording it shows the
// elapsed time and opens a small menu (Pause or Resume, Stop). Disabled while a dictation runs and
// while the recording starts or saves.
import { Record, Waveform } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import DockPopover from "../components/DockPopover";
import { useDismiss } from "../components/useDismiss";
import { useDictation } from "../speech/dictate";
import { formatElapsed } from "../speech/elapsed";
import { focusedPageId, useTabsStore } from "../stores/tabs";
import { isLive, startOnFocusedPage } from "./controls";
import { RecordingMenu } from "./RecordingMenu";
import { useRecordingLabel } from "./useRecordingLabel";
import { useRecording } from "./session";
import "./recording.css";

export default function RecordButton() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const phase = useRecording((s) => s.phase);
  const elapsedMs = useRecording((s) => s.elapsedMs);
  const dictating = useDictation((s) => s.phase !== "idle" || s.askConsent !== null);
  const hasPage = useTabsStore((s) => focusedPageId(s) !== null);
  const activeLabel = useRecordingLabel();
  const live = isLive(phase);
  useDismiss(ref, open && live, () => setOpen(false));

  const disabled = phase === "starting" || phase === "saving" || (phase === "idle" && (dictating || !hasPage));
  const label = live ? activeLabel : t("recording.start");
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={live ? "tb-btn active rec-btn rec-live" : "tb-btn rec-btn"}
        aria-label={label}
        title={phase === "idle" && dictating ? t("recording.dictationActive") : label}
        aria-haspopup={live ? "menu" : undefined}
        aria-expanded={live ? open : undefined}
        aria-busy={phase === "starting" || phase === "saving" || undefined}
        disabled={disabled}
        onClick={() => (live ? setOpen((o) => !o) : startOnFocusedPage())}
      >
        {live ? <Waveform size={18} aria-hidden="true" /> : <Record size={18} aria-hidden="true" />}
        {live && (
          <span className="tb-size rec-elapsed" aria-hidden="true">
            {formatElapsed(elapsedMs)}
          </span>
        )}
      </button>
      {open && live && (
        <DockPopover anchorRef={ref}>
          <RecordingMenu toolbar onDone={() => setOpen(false)} />
        </DockPopover>
      )}
    </div>
  );
}
