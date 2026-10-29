import { useEffect } from "react";
import { showToast } from "../../components/Toast";
import i18n from "../../i18n";
import { takeResetIncomplete } from "../../ipc/backup";

/** Once per launch: tells the user when the previous "Reset local data" could not finish. */
export default function ResetNotice() {
  useEffect(() => {
    takeResetIncomplete().then(
      (m) => {
        if (m) {
          showToast(i18n.t("settings.resetIncomplete", { path: m.recoveryPath }), undefined, {
            persistent: true,
          });
        }
      },
      () => {},
    );
  }, []);
  return null;
}
