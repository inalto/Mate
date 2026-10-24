import { Plus } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import BookCard from "../components/BookCard";
import { importUnitArchive } from "../ipc/archive";
import type { Unit } from "../model/types";
import ShelfSection from "../components/ShelfSection";
import { useImportStore } from "../stores/importStore";
import { pickAndImportPdf } from "../pdf/import";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";

type View = "recent" | "az" | "shelves";

export default function Library() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tree = useNotebookStore((s) => s.tree);
  const libraryView = useSettingsStore((s) => s.settings.libraryView);
  const view: View = libraryView === "az" || libraryView === "shelves" ? libraryView : "recent";
  const setView = (v: View) => void useSettingsStore.getState().update({ libraryView: v });
  const [newShelf, setNewShelf] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Reading `tree` above subscribes us; selectors read the same state.
  const store = useNotebookStore.getState();
  const match = (u: Unit) => u.title.toLowerCase().includes(query.trim().toLowerCase());
  const empty = tree.units.length === 0;

  const newBook = () => {
    void store.createUnit(t("common.untitledBook"));
  };
  const importBook = async () => {
    try {
      const report = await importUnitArchive();
      if (!report) return;
      await store.load();
      const counts = { pages: report.pages, elements: report.elements, skipped: report.skipped };
      alert(report.skipped > 0 ? t("library.importedSkipped", counts) : t("library.imported", counts));
    } catch (err) {
      alert(t("library.importFailed", { message: err instanceof Error ? err.message : String(err) }));
    }
  };
  const importPdf = async () => {
    const page = await pickAndImportPdf();
    if (page) navigate(`/edit/${page.id}`);
  };
  const tile = (
    <button type="button" className="new-tile" onClick={newBook}>
      <Plus size={28} />
      <span>{t("home.newBook")}</span>
    </button>
  );

  const grid = (units: Unit[]) => (
    <div className="grid">
      {units.filter(match).map((u) => (
        <BookCard key={u.id} unit={u} />
      ))}
      {tile}
    </div>
  );

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>{t("nav.library")}</h1>
        <input
          className="input"
          type="search"
          placeholder={t("library.search")}
          aria-label={t("library.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className="btn" onClick={() => void importBook()}>{t("library.importBook")}</button>
        <button type="button" className="btn" onClick={() => void importPdf()}>{t("home.importPdf")}</button>
        <button type="button" className="btn" onClick={() => void useImportStore.getState().openDialog()}>
          {t("topbar.importNotes")}
        </button>
        <div className="segmented" role="group" aria-label={t("library.sort")}>
          <button aria-pressed={view === "recent"} onClick={() => setView("recent")}>{t("settings.general.libraryView.recent")}</button>
          <button aria-pressed={view === "az"} onClick={() => setView("az")}>{t("library.az")}</button>
          <button aria-pressed={view === "shelves"} onClick={() => setView("shelves")}>{t("settings.general.libraryView.shelves")}</button>
        </div>
      </div>

      {empty && (
        <div className="empty-state">
          <h2>{t("home.noBooks")}</h2>
          <p>{t("library.emptyHint")}</p>
        </div>
      )}
      {!empty && query.trim() !== "" && tree.units.filter(match).length === 0 && (
        <div className="empty-state">
          <h2>{t("library.noneFound")}</h2>
          <button type="button" className="btn" onClick={() => setQuery("")}>
            {t("library.clearSearch")}
          </button>
        </div>
      )}

      {view === "recent" && grid(store.unitsByRecent())}
      {view === "az" && grid(store.unitsAZ())}
      {view === "shelves" && (
        <>
          {store.unitsByShelf().map((g) => (
            <ShelfSection key={g.shelf?.id ?? "none"} shelf={g.shelf} units={g.units.filter(match)} />
          ))}
          {newShelf === null ? (
            <div>
              <button type="button" className="btn" onClick={() => setNewShelf("")}>
                {t("library.newShelf")}
              </button>
            </div>
          ) : (
            <input
              className="input"
              aria-label={t("library.newShelfName")}
              placeholder={t("library.shelfName")}
              autoFocus
              value={newShelf}
              onChange={(e) => setNewShelf(e.target.value)}
              onBlur={() => setNewShelf(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setNewShelf(null);
                if (e.key === "Enter" && newShelf.trim()) {
                  void store.createBookshelf(newShelf.trim());
                  setNewShelf(null);
                }
              }}
            />
          )}
          <div className="grid">{tile}</div>
        </>
      )}
    </div>
  );
}
