// Share a book: save a .mate copy into a synced folder, or upload it to Nextcloud and copy a link.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage as message, type TKey } from "../i18n";
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
import { navigateTo } from "../stores/navigation";
import { useModal } from "./useModal";

const EXPIRY: [string, TKey][] = [
  ["never", "share.expiry.never"],
  ["7", "share.expiry.week"],
  ["30", "share.expiry.month"],
];

export default function ShareDialog({ unit, onClose }: { unit: Unit; onClose(): void }) {
  useModal();
  const { t } = useTranslation();
  /** Detected folders; null while the search runs. */
  const [folders, setFolders] = useState<SyncFolder[] | null>(null);
  const [nc, setNc] = useState<NextcloudStatus | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [expiry, setExpiry] = useState("30");
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
      <div className="card dialog share-dialog" role="dialog" aria-modal="true" aria-label={t("share.title", { title: unit.title })}>
        <h2>{t("share.title", { title: unit.title })}</h2>

        <section className="share-section" aria-label={t("share.folderTitle")}>
          <h3 className="field-subtitle">{t("share.folderTitle")}</h3>
          {folders === null && (
            <p className="field-hint" role="status">
              {t("share.lookingForFolders")}
            </p>
          )}
          {folders?.length === 0 && <p className="field-hint">{t("share.noFolders")}</p>}
          <div className="share-folders">
            {folders?.map((f) => (
              <button key={f.path} type="button" className="btn" disabled={busy} title={f.path} onClick={() => void saveTo(f.path)}>
                {f.label}
              </button>
            ))}
            <button type="button" className="btn" disabled={busy} onClick={() => void chooseFolder()}>
              {t("share.chooseFolder")}
            </button>
          </div>
          {saved && (
            <p className="field-hint" role="status">
              {t("share.savedTo", { path: saved })}{" "}
              <button type="button" className="btn" onClick={() => void revealItemInDir(saved)}>
                {t("share.showInFolder")}
              </button>
            </p>
          )}
        </section>

        <section className="share-section" aria-label={t("settings.sharing.nextcloud.label")}>
          <h3 className="field-subtitle">{t("settings.sharing.nextcloud.label")}</h3>
          {nc && !nc.signedIn && (
            <p className="field-hint">
              {t("share.nextcloudHint")}{" "}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onClose();
                  navigateTo("/settings#sharing");
                }}
              >
                {t("share.setUpInSettings")}
              </button>
            </p>
          )}
          {nc?.signedIn && (
            <>
              <p className="field-hint">{t("settings.sharing.nextcloud.signedIn", { user: nc.user, server: nc.server })}</p>
              <p className="field-hint">{t("share.publicLink")}</p>
              <label className="field">
                <span className="field-label">{t("share.expires")}</span>
                <select className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={busy}>
                  {EXPIRY.map(([v, text]) => (
                    <option key={v} value={v}>{t(text)}</option>
                  ))}
                </select>
              </label>
              <div>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void upload()}>
                  {busy ? t("share.working") : t("share.upload")}
                </button>
              </div>
              {link && (
                <div className="field">
                  <input className="input" readOnly aria-label={t("share.link")} value={link} onFocus={(e) => e.currentTarget.select()} />
                  <button type="button" className="btn" onClick={() => void copy()}>
                    {copied ? t("common.copied") : t("common.copy")}
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        {error && <p role="alert" className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
