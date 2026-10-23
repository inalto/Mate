import { useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog";
import { exportBackup, resetLocalData } from "../../../ipc/backup";
import { ButtonRow, SettingsSection } from "../rows";

const message = (err: unknown): string =>
  typeof err === "string" ? err : err instanceof Error ? err.message : "Something went wrong.";

export default function BackupSection() {
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
      if (path) setStatus(`Backup saved to ${path}`);
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
    <SettingsSection id="backup" title="Backup">
      <ButtonRow
        id="backup-download"
        label="Download backup"
        hint="One zip holding a .mate file per book. To restore, unzip it and import each .mate file."
        buttonLabel="Download backup"
        onClick={() => void download()}
        disabled={busy}
      />
      <ButtonRow
        id="backup-reset"
        label="Reset local data"
        hint="Deletes everything on this device and starts again from the welcome flow"
        buttonLabel="Reset local data"
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
          title="Reset local data?"
          confirmLabel="Reset"
          onConfirm={() => void reset()}
          onCancel={() => setConfirming(false)}
        >
          This deletes all books, pages and settings on this device. A backup zip is written first. API keys stored in the system keychain are kept.
        </ConfirmDialog>
      )}
    </SettingsSection>
  );
}
