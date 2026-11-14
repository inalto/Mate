// "Stop recording?" before a tab change leaves no tab showing the notebook being recorded (another
// notebook in its only tab, its last tab closed). Stay cancels; "Stop and leave" waits for the
// recording to be saved, then does the change on the tabs as they are by then; a failed save stays.
// Mounted once by the Shell, so it guards every route (and URL-driven opens on a fresh editor).
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import ConfirmDialog from "../components/ConfirmDialog";
import { showToast } from "../components/Toast";
import i18n from "../i18n";
import { setTabsGuard } from "../stores/tabs";
import { askToLeave, tabsLeaveRecording, useLeavePrompt } from "./leave";
import { lastStopFailed, useRecording } from "./session";

function LeaveDialog() {
  const { t } = useTranslation();
  const answer = useLeavePrompt((s) => s.answer);
  if (!answer) return null;
  const done = (leave: boolean) => {
    useLeavePrompt.setState({ answer: null });
    answer(leave);
  };
  return (
    <ConfirmDialog
      title={t("recording.leave.title")}
      confirmLabel={t("recording.leave.stop")}
      cancelLabel={t("recording.leave.stay")}
      onCancel={() => done(false)}
      onConfirm={() => {
        useLeavePrompt.setState({ answer: null });
        useRecording
          .getState()
          .stop()
          // A failed save has toasted already (and kept the recording's folder): stay.
          .then(() => answer(!lastStopFailed()))
          .catch((err: unknown) => {
            console.error("stopping the recording failed", err);
            showToast(i18n.t("errors.generic"));
            answer(false);
          });
      }}
    >
      {t("recording.leave.body")}
    </ConfirmDialog>
  );
}

export default function RecordingLeaveGuard() {
  useEffect(() => {
    setTabsGuard((prev, next, retry) => {
      if (!tabsLeaveRecording(prev, next)) return false;
      askToLeave((leave) => leave && retry());
      return true;
    });
    return () => {
      setTabsGuard(null);
      // Unmounted while asking: nobody is left to leave.
      useLeavePrompt.getState().answer?.(false);
      useLeavePrompt.setState({ answer: null });
    };
  }, []);
  return <LeaveDialog />;
}
