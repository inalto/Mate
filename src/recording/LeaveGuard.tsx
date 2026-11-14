// "Stop recording?" before leaving the recording's notebook: the focused pane turning to a page of
// another notebook, closing the last tab that shows the notebook, or leaving the editor for another
// route (Settings excepted). Stay cancels; "Stop and leave" waits for the recording to be saved,
// then goes. Mounted by the editor.
import { useCallback, useContext, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { UNSAFE_DataRouterContext, useBlocker, type BlockerFunction } from "react-router";
import ConfirmDialog from "../components/ConfirmDialog";
import { setTabsGuard } from "../stores/tabs";
import { askToLeave, routeLeavesRecording, tabsLeaveRecording, useLeavePrompt } from "./leave";
import { useRecording } from "./session";

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
        void useRecording
          .getState()
          .stop()
          .catch(() => null)
          .then(() => answer(true));
      }}
    >
      {t("recording.leave.body")}
    </ConfirmDialog>
  );
}

/** Route changes away from the notebook wait for the answer (data routers only: the app's router). */
function RouteGuard() {
  const shouldBlock = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => routeLeavesRecording(currentLocation.pathname, nextLocation.pathname), []);
  const blocker = useBlocker(shouldBlock);
  const current = useRef(blocker);
  useEffect(() => {
    current.current = blocker;
  });
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    let live = true;
    askToLeave((leave) => {
      const b = current.current;
      if (!live || b.state !== "blocked") return;
      if (leave) b.proceed();
      else b.reset();
    });
    return () => {
      live = false;
    };
  }, [blocker.state]);
  return null;
}

export default function RecordingLeaveGuard() {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  useEffect(() => {
    setTabsGuard((prev, next, apply) => {
      if (!tabsLeaveRecording(prev, next)) return false;
      askToLeave((leave) => leave && apply());
      return true;
    });
    return () => {
      setTabsGuard(null);
      // Unmounted while asking: nobody is left to leave.
      useLeavePrompt.getState().answer?.(false);
      useLeavePrompt.setState({ answer: null });
    };
  }, []);
  return (
    <>
      {dataRouter && <RouteGuard />}
      <LeaveDialog />
    </>
  );
}
