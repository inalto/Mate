import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Bookshelf, Unit } from "../model/types";
import { useNotebookStore } from "../stores/notebook";
import BookCard from "./BookCard";

export default function ShelfSection({ shelf, units }: { shelf: Bookshelf | null; units: Unit[] }) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(shelf?.title ?? "");

  const commit = async () => {
    setRenaming(false);
    const title = draft.trim();
    if (shelf && title && title !== shelf.title) {
      await useNotebookStore.getState().rename("bookshelf", shelf.id, title);
    } else {
      setDraft(shelf?.title ?? "");
    }
  };

  return (
    <section>
      <div className="screen-header">
        {renaming ? (
          <input
            className="input"
            aria-label={t("library.shelfName")}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              if (e.key === "Escape") { setRenaming(false); setDraft(shelf?.title ?? ""); }
            }}
          />
        ) : (
          <h2 className="section-title">{shelf?.title ?? t("library.unshelved")}</h2>
        )}
        {shelf && !renaming && (
          <>
            <button type="button" className="btn" onClick={() => setRenaming(true)}>
              {t("library.renameShelf")}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void useNotebookStore.getState().trash("bookshelf", shelf.id)}
            >
              {t("library.deleteShelf")}
            </button>
          </>
        )}
      </div>
      {units.length === 0 ? (
        <p className="muted">{t("library.emptyShelf")}</p>
      ) : (
        <div className="grid">
          {units.map((u) => <BookCard key={u.id} unit={u} />)}
        </div>
      )}
    </section>
  );
}
