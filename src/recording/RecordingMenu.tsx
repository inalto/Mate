// The menu the record button and the pill share while recording: Pause or Resume, and Stop.
import { useTranslation } from "react-i18next";
import { useRecording } from "./session";

/** Menu items; `onDone` closes the menu. `toolbar`: the dock popover's look, else the top bar's. */
export function RecordingMenu({ onDone, toolbar = false }: { onDone(): void; toolbar?: boolean }) {
  const { t } = useTranslation();
  const phase = useRecording((s) => s.phase);
  const paused = phase === "paused" || phase === "interrupted";
  const item = toolbar ? "tb-menu-item" : undefined;
  const run = (fn: () => unknown) => () => {
    onDone();
    void fn();
  };
  return (
    <div className={toolbar ? "tb-popover tb-menu" : "menu menu-right rec-menu"} role="menu" aria-label={t("recording.menu")}>
      <button type="button" role="menuitem" className={item} onClick={run(() => (paused ? useRecording.getState().resume() : useRecording.getState().pause()))}>
        {paused ? t("recording.resume") : t("recording.pause")}
      </button>
      <button type="button" role="menuitem" className={item} onClick={run(() => useRecording.getState().stop())}>
        {t("recording.stop")}
      </button>
    </div>
  );
}
