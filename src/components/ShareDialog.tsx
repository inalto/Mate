// Share a book: save a .mate copy into a synced folder, or upload it to Nextcloud and copy a link.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import {
  detectSyncFolders,
  nextcloudShare,
  nextcloudStatus,
  pickFolder,
  saveArchiveTo,
  type NextcloudStatus,
  type SyncFolder,
} from "../ipc/share";
import type { Unit } from "../model/types";
import { useModal } from "./useModal";

const message = (err: unknown): string =>
  typeof err === "string" ? err : err instanceof Error ? err.message : "Something went wrong.";

const EXPIRY: [string, string][] = [
  ["never", "Never"],
  ["7", "After 7 days"],
  ["30", "After 30 days"],
];

export default function ShareDialog({ unit, onClose }: { unit: Unit; onClose(): void }) {
  useModal();
  const [folders, setFolders] = useState<SyncFolder[]>([]);
  const [nc, setNc] = useState<NextcloudStatus | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [expiry, setExpiry] = useState("never");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    detectSyncFolders().then(setFolders, () => setFolders([]));
    nextcloudStatus().then(setNc, () => setNc({ signedIn: false, server: "", user: "" }));
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const saveTo = (dir: string) =>
    run(async () => {
      setSaved(await saveArchiveTo(unit.id, dir));
    });

  const chooseFolder = () =>
    run(async () => {
      const dir = await pickFolder();
      if (dir) setSaved(await saveArchiveTo(unit.id, dir));
    });

  const upload = () =>
    run(async () => {
      setCopied(false);
      const res = await nextcloudShare(unit.id, expiry === "never" ? null : Number(expiry));
      setLink(res.url);
    });

  const copy = async () => {
    if (!link) return;
    try {
      await writeText(link);
      setCopied(true);
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <div className="backdrop">
      <div className="card dialog share-dialog" role="dialog" aria-modal="true" aria-label={`Share ${unit.title}`}>
        <h2>Share {unit.title}</h2>

        <section className="share-section" aria-label="Save a copy to a synced folder">
          <h3 className="field-subtitle">Save a copy to a synced folder</h3>
          {folders.length === 0 && <p className="field-hint">No synced folders found on this computer.</p>}
          <div className="share-folders">
            {folders.map((f) => (
              <button key={f.path} type="button" className="btn" disabled={busy} title={f.path} onClick={() => void saveTo(f.path)}>
                {f.label}
              </button>
            ))}
            <button type="button" className="btn" disabled={busy} onClick={() => void chooseFolder()}>
              Choose another folder…
            </button>
          </div>
          {saved && (
            <p className="field-hint" role="status">
              Saved to {saved}{" "}
              <button type="button" className="btn" onClick={() => void revealItemInDir(saved)}>
                Show in folder
              </button>
            </p>
          )}
        </section>

        <section className="share-section" aria-label="Nextcloud">
          <h3 className="field-subtitle">Nextcloud</h3>
          {nc && !nc.signedIn && (
            <p className="field-hint">Send a link to this book from your Nextcloud. Set up in Settings → Sharing.</p>
          )}
          {nc?.signedIn && (
            <>
              <p className="field-hint">Signed in as {nc.user} on {nc.server}</p>
              <label className="field">
                <span className="field-label">Link expires</span>
                <select className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={busy}>
                  {EXPIRY.map(([v, text]) => (
                    <option key={v} value={v}>{text}</option>
                  ))}
                </select>
              </label>
              <div>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void upload()}>
                  {busy ? "Working…" : "Upload and get link"}
                </button>
              </div>
              {link && (
                <div className="field">
                  <input className="input" readOnly aria-label="Share link" value={link} onFocus={(e) => e.currentTarget.select()} />
                  <button type="button" className="btn" onClick={() => void copy()}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        {error && <p role="alert" className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
