import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Bookshelf } from "../model/types";
import { useNotebookStore } from "../stores/notebook";
import { useModal } from "./useModal";

const FOCUSABLE = "button:not([disabled])";

interface Props {
  /** Dialog heading, e.g. "Move Algebra to…". */
  title: string;
  /** Where the item is now (null: the root); shown as current and not offered. */
  currentId: string | null;
  /** Folders that may not be picked (a folder itself and its subfolders). */
  disabledIds?: ReadonlySet<string>;
  /** Moves the item; a rejection is shown in the dialog, which then stays open. */
  onPick: (folderId: string | null) => Promise<void>;
  onClose: () => void;
}

/** Folder picker: the root ("Unfiled") and the whole folder tree, depth first. */
export default function MoveToFolderDialog({ title, currentId, disabledIds, onPick, onClose }: Props) {
  useModal();
  const { t } = useTranslation();
  useNotebookStore((s) => s.tree); // subscribe: the rows follow tree changes
  const { childFolders } = useNotebookStore.getState();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Focus moves in on open, stays inside, and returns to the opener on close.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
      } else if (e.key === "Tab") {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
        e.preventDefault();
        if (items.length === 0) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1].focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, []);

  // Depth-first rows; `seen` keeps a corrupt cycle from looping.
  const rows: { folder: Bookshelf; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of childFolders(parentId)) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      rows.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 1);

  const pick = async (id: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await onPick(id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const option = (id: string | null, label: string, depth: number) => {
    const current = id === currentId;
    return (
      <button
        key={id ?? "root"}
        type="button"
        className="folder-option"
        style={{ paddingLeft: 12 + depth * 16 }}
        disabled={busy || current || (id !== null && disabledIds?.has(id))}
        aria-current={current ? "location" : undefined}
        onClick={() => void pick(id)}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="backdrop">
      <div ref={ref} className="card dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <div className="folder-options">
          {option(null, t("library.unfiled"), 0)}
          {rows.map((r) => option(r.folder.id, r.folder.title, r.depth))}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
