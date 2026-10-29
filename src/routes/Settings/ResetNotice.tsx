import { useEffect } from "react";
import { showToast } from "../../components/Toast";
import i18n from "../../i18n";
import { skippedLines, takeResetIncomplete } from "../../ipc/backup";

/**
 * Once per launch: tells the user when the previous "Reset local data" could not finish, and
 * which books were too large for its recovery zip.
 */
export default function ResetNotice() {
  useEffect(() => {
    takeResetIncomplete().then(
      (m) => {
        if (m?.error) {
          showToast(i18n.t("settings.resetIncomplete", { path: m.recoveryPath }), undefined, {
            persistent: true,
          });
        }
        if (m?.skipped?.length) showToast(skippedLines(m.skipped), undefined, { persistent: true });
      },
      () => {},
    );
  }, []);
  return null;
}
