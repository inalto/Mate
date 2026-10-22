import { useEffect, useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";
import { purgeTrashOlderThan } from "../ipc/notebook";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";

/** `0` means keep forever. */
const RETENTION: Array<{ days: number; label: string }> = [
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
  { days: 60, label: "60 days" },
  { days: 90, label: "90 days" },
  { days: 0, label: "Forever" },
];

export default function Trash() {
  const items = useNotebookStore((s) => s.trashItems);
  const retention = useSettingsStore((s) => s.settings.trashRetentionDays);
  const update = useSettingsStore((s) => s.update);
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const { trashRetentionDays } = useSettingsStore.getState().settings;
    void (async () => {
      if (trashRetentionDays > 0) await purgeTrashOlderThan(trashRetentionDays);
      await useNotebookStore.getState().loadTrash();
    })();
  }, []);

  const store = useNotebookStore.getState();
  const shown = [...items]
    .filter((i) => i.title.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));

  const emptyTrash = async () => {
    setConfirming(false);
    for (const item of items) await store.purge(item.kind, item.id);
  };

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>Trash</h1>
        <input
          className="input"
          type="search"
          placeholder="Search trash"
          aria-label="Search trash"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label>
          Keep deleted items for{" "}
          <select
            className="input"
            value={retention}
            onChange={(e) => void update({ trashRetentionDays: Number(e.target.value) })}
          >
            {RETENTION.map((r) => (
              <option key={r.days} value={r.days}>{r.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-danger"
          disabled={items.length === 0}
          onClick={() => setConfirming(true)}
        >
          Empty trash
        </button>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <h2>Trash is empty</h2>
          <p>Deleted pages, chapters, and notebooks will appear here for recovery.</p>
        </div>
      ) : (
        <div className="row-list">
          {shown.map((item) => (
            <div key={`${item.kind}:${item.id}`} className="card row">
              <div className="grow">
                <div>{item.title}</div>
                <div className="muted">
                  {item.kind} - deleted {new Date(item.deletedAt).toLocaleString()}
                </div>
              </div>
              <button type="button" className="btn" onClick={() => void store.restore(item.kind, item.id)}>
                Restore
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void store.purge(item.kind, item.id)}
              >
                Delete permanently
              </button>
            </div>
          ))}
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title="Empty trash?"
          confirmLabel="Delete permanently"
          onConfirm={() => void emptyTrash()}
          onCancel={() => setConfirming(false)}
        >
          This will permanently delete all items in the trash. This action cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  );
}
