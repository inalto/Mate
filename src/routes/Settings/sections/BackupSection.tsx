import { useState } from "react";
import { useTranslation } from "react-i18next";
import ConfirmDialog from "../../../components/ConfirmDialog";
import { errorMessage as message } from "../../../i18n";
import { exportBackup, resetLocalData } from "../../../ipc/backup";
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
      const path = await exportBackup();
      if (path) setStatus(t("settings.backup.saved", { path }));
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
      await resetLocalData(); // the app restarts on success
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
        </ConfirmDialog>
      )}
    </SettingsSection>
  );
}
