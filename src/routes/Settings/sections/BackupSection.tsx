import { Fragment, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ConfirmDialog from "../../../components/ConfirmDialog";
import { errorMessage as message } from "../../../i18n";
import {
  exportBackup,
  pickBackupFile,
  resetLocalData,
  restoreBackupFile,
  RESTORE_STOPPED,
  type BackupSaved,
  type RestoreReport,
} from "../../../ipc/backup";
import { isMobile } from "../../../platform";
import { useNotebookStore } from "../../../stores/notebook";
import { ButtonRow, SettingsSection } from "../rows";

export default function BackupSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Books left out of the backup just written: the user must acknowledge them.
  const [leftOut, setLeftOut] = useState<BackupSaved | null>(null);
  // The backup zip picked for restoring, waiting for confirmation; then what the restore added.
  const [toRestore, setToRestore] = useState<string | null>(null);
  const [restored, setRestored] = useState<RestoreReport | null>(null);
  const [restoringNow, setRestoringNow] = useState(false);
  // Set synchronously, so a second click before the re-render cannot start a second restore.
  const restoring = useRef(false);

  const pickRestore = async () => {
    if (restoring.current) return;
    restoring.current = true;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const path = await pickBackupFile(t("backup.restore.filter"));
      if (path) {
        setToRestore(path);
        return; // still busy until confirmed or cancelled
      }
    } catch (err) {
      setError(message(err));
    }
    restoring.current = false;
    setBusy(false);
  };

  const cancelRestore = () => {
    setToRestore(null);
    restoring.current = false;
    setBusy(false);
  };

  // The `notebook://changed` broadcast skips the window that sent it: reload this one's tree.
  const reloadTree = async () => {
    try {
      await useNotebookStore.getState().load();
    } catch (err) {
      console.error("restore: could not reload the notebook tree", err);
    }
  };

  const restore = async (path: string) => {
    setToRestore(null);
    setRestoringNow(true);
    try {
      const report = await restoreBackupFile(path);
      if (report.books.length > 0) await reloadTree();
      setRestored(report);
    } catch (err) {
      console.error("restore failed", err);
      // Every error comes before the first notebook is added, except a restore that died.
      const stopped = message(err).startsWith(RESTORE_STOPPED);
      setError(t(stopped ? "backup.restore.errorUnknown" : "backup.restore.error"));
      if (stopped) await reloadTree();
    } finally {
      restoring.current = false;
      setRestoringNow(false);
      setBusy(false);
    }
  };

  /** The lines of the restore result; each optional one only when it has something to say. */
  const restoredLines = (r: RestoreReport): string[] => [
    t("backup.restore.done", { count: r.books.length }),
    ...(r.failed.length > 0 ? [t("backup.restore.failed", { titles: r.failed.map((f) => f.name).join(", ") })] : []),
    ...(r.lostRecordings.length > 0
      ? [t("backup.restore.lostRecordings", { titles: r.lostRecordings.join(", ") })]
      : []),
    ...(r.rejectedAudio > 0 ? [t("backup.restore.rejectedAudio", { count: r.rejectedAudio })] : []),
  ];

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
        // Books over the archive cap are not in the backup: that blocks until acknowledged.
        if (saved.skippedBooks.length > 0) setLeftOut(saved);
        else if (saved.missingAudio.length > 0)
          setError(t("backup.missingAudio", { titles: saved.missingAudio.join(", ") }));
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
        id="backup-restore"
        label={t("backup.restore.label")}
        hint={t("backup.restore.hint")}
        buttonLabel={restoringNow ? t("backup.restore.busy") : t("backup.restore.label")}
        onClick={() => void pickRestore()}
        disabled={busy}
        busy={restoringNow}
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
      {leftOut && (
        <ConfirmDialog
          title={t("backup.skipped.title")}
          confirmLabel={t("common.close")}
          confirmOnly
          onConfirm={() => setLeftOut(null)}
          onCancel={() => setLeftOut(null)}
        >
          {t("backup.skipped.body", { titles: leftOut.skippedBooks.join(", ") })}
          {leftOut.missingAudio.length > 0 && (
            <>
              <br />
              {t("backup.missingAudio", { titles: leftOut.missingAudio.join(", ") })}
            </>
          )}
        </ConfirmDialog>
      )}
      {toRestore && (
        <ConfirmDialog
          title={t("backup.restore.title")}
          confirmLabel={t("backup.restore.confirm")}
          onConfirm={() => void restore(toRestore)}
          onCancel={cancelRestore}
        >
          {t("backup.restore.body")}
        </ConfirmDialog>
      )}
      {restored && (
        <ConfirmDialog
          title={
            restored.books.length === 0 && restored.failed.length > 0
              ? t("backup.restore.resultTitleNone")
              : t("backup.restore.resultTitle")
          }
          confirmLabel={t("common.close")}
          confirmOnly
          onConfirm={() => setRestored(null)}
          onCancel={() => setRestored(null)}
        >
          {restoredLines(restored).map((line, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              {line}
            </Fragment>
          ))}
        </ConfirmDialog>
      )}
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
