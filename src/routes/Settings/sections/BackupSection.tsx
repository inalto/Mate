import { useState } from "react";
import { useTranslation } from "react-i18next";
import ConfirmDialog from "../../../components/ConfirmDialog";
import { errorMessage as message } from "../../../i18n";
import { exportBackup, resetLocalData, skippedLines } from "../../../ipc/backup";
import { isMobile } from "../../../platform";
import { ButtonRow, SettingsSection } from "../rows";

export default function BackupSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const download = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await exportBackup();
      if (saved) {
        const { path } = saved;
        // Mobile: the zip went to the share sheet, its app-private path means nothing to the user.
        setStatus(isMobile() ? t("settings.backup.shared") : t("settings.backup.saved", { path }));
        // Books over the archive cap were left out: name them (the reason comes from Rust).
        if (saved.skipped.length > 0) setError(skippedLines(saved.skipped));
      }
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      await resetLocalData(); // desktop restarts; mobile shares the backup, then closes
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="backup" title={t("settings.nav.sections.backup")}>
      <ButtonRow
        id="backup-download"
        label={t("settings.backup.download.label")}
        hint={t("settings.backup.download.hint")}
        buttonLabel={t("settings.backup.download.label")}
        onClick={() => void download()}
        disabled={busy}
      />
      <ButtonRow
        id="backup-reset"
        label={t("settings.backup.reset.label")}
        hint={t("settings.backup.reset.hint")}
        buttonLabel={t("settings.backup.reset.label")}
        onClick={() => setConfirming(true)}
        disabled={busy}
        danger
      />
      <p className="form-error" role="alert" hidden={!error}>
        {error}
      </p>
      <p className="muted" role="status">
        {status}
      </p>
      {confirming && (
        <ConfirmDialog
          title={t("settings.backup.reset.confirmTitle")}
          confirmLabel={t("settings.backup.reset.confirm")}
          onConfirm={() => void reset()}
          onCancel={() => setConfirming(false)}
        >
          {t("settings.backup.reset.confirmBody")}
          {isMobile() && ` ${t("settings.backup.reset.mobileNote")}`}
        </ConfirmDialog>
      )}
    </SettingsSection>
  );
}
