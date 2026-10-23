import { useEffect } from "react";
import { showToast } from "../../components/Toast";
import { takeResetIncomplete } from "../../ipc/backup";

/** Once per launch: tells the user when the previous "Reset local data" could not finish. */
export default function ResetNotice() {
  useEffect(() => {
    takeResetIncomplete().then(
      (m) => {
        if (m) {
          showToast(`Local data could not be fully reset. Your backup is at ${m.recoveryPath}.`, undefined, {
            persistent: true,
          });
        }
      },
      () => {},
    );
  }, []);
  return null;
}
