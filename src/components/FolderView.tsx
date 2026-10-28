import { Plus } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Unit } from "../model/types";
import { useNotebookStore } from "../stores/notebook";
import BookCard from "./BookCard";
import FolderCard from "./FolderCard";

/** Breadcrumb levels shown before the rest collapses into "…". */
const CRUMB_LEVELS = 3;

/**
 * The Library's Folders view, browsed like a file manager: a breadcrumb, the current folder's
 * subfolders, then its books. The root holds the top-level folders and the unfiled books.
 */
export default function FolderView({ query }: { query: string }) {
  const { t } = useTranslation();
  useNotebookStore((s) => s.tree); // subscribe: the selectors below read the same tree
  const store = useNotebookStore.getState();
  const [openId, setOpenId] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);

  // A folder that left the tree (trashed in another window, say) falls back to the root.
  const path = store.folderPath(openId);
  const current = path.length > 0 ? path[path.length - 1].id : null;
  const folders = store.childFolders(current);
  const needle = query.trim().toLowerCase();
  const books = store.unitsInFolder(current).filter((u: Unit) => u.title.toLowerCase().includes(needle));
  const shown = path.slice(-CRUMB_LEVELS);

  const createFolder = (title: string) => {
    void store.createBookshelf(title, current ?? undefined);
    setNewFolder(null);
  };

  return (
    <>
      <div className="screen-header folder-header">
        <nav className="breadcrumb" aria-label={t("library.breadcrumb")}>
          <ol>
            <li>
              {current === null ? (
                <span aria-current="page">{t("library.folders")}</span>
              ) : (
                <button type="button" className="crumb" onClick={() => setOpenId(null)}>
                  {t("library.folders")}
                </button>
              )}
            </li>
            {path.length > shown.length && (
              <li>
                <span className="crumb-sep" aria-hidden>›</span>
                <span>…</span>
              </li>
            )}
            {shown.map((f) => (
              <li key={f.id}>
                <span className="crumb-sep" aria-hidden>›</span>
                {f.id === current ? (
                  <span aria-current="page">{f.title}</span>
                ) : (
                  <button type="button" className="crumb" onClick={() => setOpenId(f.id)}>
                    {f.title}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </nav>
        {newFolder === null ? (
          <button type="button" className="btn" onClick={() => setNewFolder("")}>
            {t("library.newFolder")}
          </button>
        ) : (
          <input
            className="input"
            aria-label={t("library.newFolderName")}
            placeholder={t("library.folderName")}
            autoFocus
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onBlur={() => setNewFolder(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setNewFolder(null);
              if (e.key === "Enter" && newFolder.trim()) createFolder(newFolder.trim());
            }}
          />
        )}
      </div>

      {folders.length > 0 && (
        <div className="grid">
          {folders.map((f) => (
            <FolderCard key={f.id} folder={f} onOpen={() => setOpenId(f.id)} />
          ))}
        </div>
      )}
      {current === null && <h2 className="section-title">{t("library.unfiled")}</h2>}
      {current !== null && folders.length === 0 && books.length === 0 && needle === "" && (
        <p className="muted">{t("library.emptyFolder")}</p>
      )}
      <div className="grid">
        {books.map((u) => (
          <BookCard key={u.id} unit={u} />
        ))}
        <button
          type="button"
          className="new-tile"
          onClick={() => void store.createUnit(t("common.untitledBook"), current ?? undefined)}
        >
          <Plus size={28} />
          <span>{t("home.newBook")}</span>
        </button>
      </div>
    </>
  );
}
