import { CircleNotch, Microphone, MicrophoneSlash } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { answerConsent, formatElapsed, noteEditTarget, toggleDictation, useDictation } from "../speech/dictate";
import "../styles/speech.css";
import SpeechConsentDialog from "./speech/SpeechConsentDialog";

/** Toolbar button: press to dictate, press again to stop and turn the recording into text. */
export function DictateButton() {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const phase = useDictation((s) => s.phase);
  const startedAt = useDictation((s) => s.startedAt);
  const ask = useDictation((s) => s.askConsent);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [phase]);

  // Runs before the canvas's own capture listener ends the text edit, so the text box being
  // edited is still known when the button is pressed.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) noteEditTarget();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);

  const recording = phase === "recording";
  const busy = phase === "transcribing";
  const elapsed = recording && startedAt !== null ? formatElapsed(Math.max(now, startedAt) - startedAt) : "";
  const label = recording ? t("speech.stop") : busy ? t("speech.transcribing") : t("speech.dictate");
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={recording ? "tb-btn active dictate-recording" : "tb-btn"}
        aria-pressed={recording}
        aria-busy={busy || undefined}
        aria-label={label}
        title={recording ? t("speech.recording", { time: elapsed }) : label}
        disabled={busy}
        onClick={() => void toggleDictation()}
      >
        {busy ? (
          <CircleNotch size={18} className="dictate-spin" aria-hidden="true" />
        ) : recording ? (
          <MicrophoneSlash size={18} aria-hidden="true" />
        ) : (
          <Microphone size={18} aria-hidden="true" />
        )}
        {recording && (
          <span className="tb-size dictate-elapsed" aria-hidden="true">
            {elapsed}
          </span>
        )}
      </button>
      {ask && <SpeechConsentDialog provider={ask.provider} onAnswer={(allow) => void answerConsent(allow)} />}
    </>
  );
}

export default DictateButton;
