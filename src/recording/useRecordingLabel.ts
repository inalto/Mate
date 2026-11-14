// The name the record button and the pill show while recording.
import { useTranslation } from "react-i18next";
import { formatElapsed } from "../speech/elapsed";
import { useRecording } from "./session";

/** "Recording 1:05" / "Paused 1:05" / "Not recording 1:05" (interrupted): the active button's and the pill's name. */
export function useRecordingLabel(): string {
  const { t } = useTranslation();
  const phase = useRecording((s) => s.phase);
  const time = formatElapsed(useRecording((s) => s.elapsedMs));
  if (phase === "paused") return t("recording.paused", { time });
  if (phase === "interrupted") return t("recording.interrupted", { time });
  return t("recording.pill", { time });
}
