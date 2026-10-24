import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ConfirmDialog from "../components/ConfirmDialog";
import { purgeTrashOlderThan } from "../ipc/notebook";
import { collectAssets, useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";

/** `0` means keep forever. */
const RETENTION_DAYS = [7, 14, 30, 60, 90, 0];

export default function Trash() {
  const { t } = useTranslation();
  const items = useNotebookStore((s) => s.trashItems);
  const retention = useSettingsStore((s) => s.settings.trashRetentionDays);
  const update = useSettingsStore((s) => s.update);
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);

  const settingsLoaded = useSettingsStore((s) => s.loaded);

  useEffect(() => {
    // Never prune with a setting that has not been loaded from disk yet.
    if (!settingsLoaded) return;
    void (async () => {
      if (retention > 0 && (await purgeTrashOlderThan(retention)) > 0) await collectAssets();
      await useNotebookStore.getState().loadTrash();
    })();
  }, [settingsLoaded, retention]);

  const store = useNotebookStore.getState();
  const shown = [...items]
    .filter((i) => i.title.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));

  const emptyTrash = async () => {
    setConfirming(false);
    await store.emptyTrash();
  };

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>{t("nav.trash")}</h1>
        <input
          className="input"
          type="search"
          placeholder={t("trash.search")}
          aria-label={t("trash.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label>
          {t("settings.trash.keepFor")}{" "}
          <select
            className="input"
            value={retention}
            onChange={(e) => void update({ trashRetentionDays: Number(e.target.value) })}
          >
            {RETENTION_DAYS.map((d) => (
              <option key={d} value={d}>
                {d === 0 ? t("settings.trash.forever") : t("settings.trash.days", { count: d })}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-danger"
          disabled={items.length === 0}
          onClick={() => setConfirming(true)}
        >
          {t("trash.empty")}
        </button>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <h2>{t("trash.isEmpty")}</h2>
          <p>{t("trash.emptyHint")}</p>
        </div>
      ) : (
        <div className="row-list">
          {shown.map((item) => (
            <div key={`${item.kind}:${item.id}`} className="card row">
              <div className="grow">
                <div>{item.title}</div>
                <div className="muted">
                  {t("trash.deleted", { kind: t(`trash.kinds.${item.kind}`), date: new Date(item.deletedAt).toLocaleString() })}
                </div>
              </div>
              <button type="button" className="btn" onClick={() => void store.restore(item.kind, item.id)}>
                {t("trash.restore")}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void store.purge(item.kind, item.id)}
              >
                {t("trash.deletePermanently")}
              </button>
            </div>
          ))}
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={t("trash.confirmTitle")}
          confirmLabel={t("trash.deletePermanently")}
          onConfirm={() => void emptyTrash()}
          onCancel={() => setConfirming(false)}
        >
          {t("trash.confirmBody")}
        </ConfirmDialog>
      )}
    </div>
  );
}
